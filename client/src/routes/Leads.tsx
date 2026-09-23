import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Crosshair, Trash2, X } from 'lucide-react';
import type { Branch, LeadPin, PinStatus } from '../../../src/types/models';
import { useAuth } from '@/auth/AuthContext';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import * as api from '@/lib/api';
import { relative } from '@/lib/format';
import { addressAt, loadGoogleMaps, type GeocodedAddress } from '@/lib/googleMaps';
import { usePublicConfig } from '@/lib/publicApi';
import { ADDONS } from '@/lib/sales';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';
import { cn } from '@/lib/utils';

/**
 * The door-knocking map. Tap a house, say how it went. A tap on a pin already
 * there is a revisit. Signed customers show as their own pins, with what they
 * pay for.
 */

interface PinView extends LeadPin {
  created_by_name: string | null;
}

interface CustomerPin {
  property_id: string;
  customer_id: string;
  customer_name: string;
  latitude: string;
  longitude: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  access_notes: string | null;
  billing_type: string | null;
  addon_salt: boolean;
  addon_vehicle: boolean;
  addon_stairs: boolean;
}

type Layer = PinStatus | 'customer';

const LAYERS: { key: Layer; label: string; color: string }[] = [
  { key: 'not_home', label: 'Not home', color: '#f59e0b' },
  { key: 'not_interested', label: 'Not interested', color: '#ef4444' },
  { key: 'lead', label: 'Lead', color: '#3b82f6' },
  { key: 'customer', label: 'Customer', color: '#22c55e' },
];
const colorOf = (layer: Layer): string => LAYERS.find((l) => l.key === layer)?.color ?? '#94a3b8';
const labelOf = (layer: Layer): string => LAYERS.find((l) => l.key === layer)?.label ?? layer;

type Selection =
  | { kind: 'new'; position: google.maps.LatLngLiteral; address: GeocodedAddress | null }
  | { kind: 'pin'; pin: PinView }
  | { kind: 'customer'; customer: CustomerPin };

/** Where to look when the phone will not say where it is. Middle of the Maritimes. */
const FALLBACK_CENTER = { lat: 45.0, lng: -64.0 };

export function Leads(): JSX.Element {
  const config = usePublicConfig();
  const { data: branches, error } = useQuery(() => api.get<Branch[]>('/branches'), []);

  if (error) return <ErrorNotice message={error} />;
  if (!config || !branches) return <Loading />;

  if (!config.maps_api_key) {
    return (
      <>
        <PageHeader title="Leads" subtitle="The door-knocking map" />
        <div className="glass-card rounded-xl border border-border bg-card/60 p-6 text-sm">
          <h2 className="text-base font-semibold text-foreground">The map needs a Google Maps key</h2>
          <p className="mt-2 text-muted-foreground">
            Add a <code className="rounded bg-muted px-1">GOOGLE_MAPS_API_KEY</code> setting on the server (in Render:
            the service's Environment page) and redeploy. The key needs the Maps JavaScript API and the Geocoding API
            turned on, and should be restricted to this site's address.
          </p>
        </div>
      </>
    );
  }

  return <LeadsMap apiKey={config.maps_api_key} branches={branches} />;
}

function LeadsMap({ apiKey, branches }: { apiKey: string; branches: Branch[] }): JSX.Element {
  const { user, isCorporate } = useAuth();
  const containerRef = React.useRef<HTMLDivElement>(null);
  const mapRef = React.useRef<google.maps.Map | null>(null);
  const markersRef = React.useRef(new Map<string, google.maps.Marker>());
  const draftMarkerRef = React.useRef<google.maps.Marker | null>(null);
  const meMarkerRef = React.useRef<google.maps.Marker | null>(null);

  const [maps, setMaps] = React.useState<typeof google.maps | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [pins, setPins] = React.useState<PinView[]>([]);
  const [customers, setCustomers] = React.useState<CustomerPin[]>([]);
  const [shown, setShown] = React.useState<Set<Layer>>(() => new Set(LAYERS.map((l) => l.key)));
  const [selection, setSelection] = React.useState<Selection | null>(null);
  const [branchId, setBranchId] = React.useState(branches[0]?.id ?? '');

  // --- Load the map ---------------------------------------------------------
  React.useEffect(() => {
    loadGoogleMaps(apiKey)
      .then(setMaps)
      .catch((err: unknown) => setLoadError(err instanceof Error ? err.message : String(err)));
  }, [apiKey]);

  const refresh = React.useCallback(async () => {
    const bounds = mapRef.current?.getBounds();
    if (!bounds) return;
    const ne = bounds.getNorthEast();
    const sw = bounds.getSouthWest();
    const box = { north: ne.lat(), south: sw.lat(), east: ne.lng(), west: sw.lng() };
    const [nextPins, nextCustomers] = await Promise.all([
      api.get<PinView[]>('/leads/pins', box),
      api.get<CustomerPin[]>('/leads/customers', box),
    ]);
    setPins(nextPins);
    setCustomers(nextCustomers);
  }, []);

  React.useEffect(() => {
    if (!maps || !containerRef.current || mapRef.current) return;

    const map = new maps.Map(containerRef.current, {
      center: FALLBACK_CENTER,
      zoom: 17,
      // Satellite with street names: a rep is picking out a roof, not a road.
      mapTypeId: 'hybrid',
      tilt: 0,
      clickableIcons: false,
      streetViewControl: false,
      fullscreenControl: false,
      // One finger pans on a phone, instead of the "use two fingers" nag.
      gestureHandling: 'greedy',
      mapTypeControlOptions: { position: maps.ControlPosition.TOP_RIGHT },
    });
    mapRef.current = map;

    map.addListener('idle', () => void refresh().catch(() => undefined));
    map.addListener('click', (event: google.maps.MapMouseEvent) => {
      if (!event.latLng) return;
      const position = event.latLng.toJSON();
      setSelection({ kind: 'new', position, address: null });
      void addressAt(maps, position).then((address) =>
        setSelection((current) =>
          current?.kind === 'new' && current.position === position ? { ...current, address } : current,
        ),
      );
    });

    const home = branches[0];
    const centreOnBranch = (): void => {
      if (!home) return;
      new maps.Geocoder()
        .geocode({ address: `${home.name}, ${home.province}, Canada` })
        .then(({ results }) => {
          const location = results[0]?.geometry.location;
          if (location) {
            map.setCenter(location);
            map.setZoom(15);
          }
        })
        .catch(() => undefined);
    };

    if (navigator.geolocation) {
      navigator.geolocation.getCurrentPosition(
        (pos) => map.setCenter({ lat: pos.coords.latitude, lng: pos.coords.longitude }),
        centreOnBranch,
        { enableHighAccuracy: true, timeout: 6000 },
      );
    } else {
      centreOnBranch();
    }
  }, [maps, branches, refresh]);

  // --- Where the rep is standing -------------------------------------------
  React.useEffect(() => {
    if (!maps || !navigator.geolocation) return;
    const watch = navigator.geolocation.watchPosition(
      (pos) => {
        const at = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        meMarkerRef.current ??= new maps.Marker({
          map: mapRef.current,
          clickable: false,
          zIndex: 1,
          icon: {
            path: maps.SymbolPath.CIRCLE,
            // White with a ring, so it is never mistaken for a lead pin.
            scale: 6,
            fillColor: '#ffffff',
            fillOpacity: 1,
            strokeColor: '#2563eb',
            strokeWeight: 4,
          },
        });
        meMarkerRef.current.setPosition(at);
      },
      () => undefined,
      { enableHighAccuracy: true },
    );
    return () => navigator.geolocation.clearWatch(watch);
  }, [maps]);

  const locateMe = (): void => {
    const at = meMarkerRef.current?.getPosition();
    if (at) {
      mapRef.current?.panTo(at);
      mapRef.current?.setZoom(18);
    }
  };

  // --- Draw the pins ---------------------------------------------------------
  React.useEffect(() => {
    const map = mapRef.current;
    if (!maps || !map) return;

    const wanted = new Map<string, { position: google.maps.LatLngLiteral; layer: Layer; onClick: () => void; title: string }>();
    for (const pin of pins) {
      if (!shown.has(pin.status)) continue;
      wanted.set(`pin:${pin.id}`, {
        position: { lat: Number(pin.latitude), lng: Number(pin.longitude) },
        layer: pin.status,
        title: `${labelOf(pin.status)}${pin.address_line1 ? ` · ${pin.address_line1}` : ''}`,
        onClick: () => setSelection({ kind: 'pin', pin }),
      });
    }
    if (shown.has('customer')) {
      for (const customer of customers) {
        wanted.set(`customer:${customer.property_id}`, {
          position: { lat: Number(customer.latitude), lng: Number(customer.longitude) },
          layer: 'customer',
          title: `${customer.customer_name} · ${customer.address_line1}`,
          onClick: () => setSelection({ kind: 'customer', customer }),
        });
      }
    }

    const markers = markersRef.current;
    for (const [key, marker] of markers) {
      if (!wanted.has(key)) {
        marker.setMap(null);
        markers.delete(key);
      }
    }
    for (const [key, spec] of wanted) {
      markers.get(key)?.setMap(null);
      const marker = new maps.Marker({
        map,
        position: spec.position,
        title: spec.title,
        zIndex: spec.layer === 'customer' ? 3 : 2,
        icon: {
          path: maps.SymbolPath.CIRCLE,
          scale: spec.layer === 'customer' ? 10 : 8,
          fillColor: colorOf(spec.layer),
          fillOpacity: 1,
          strokeColor: '#ffffff',
          strokeWeight: 2,
        },
      });
      marker.addListener('click', spec.onClick);
      markers.set(key, marker);
    }
  }, [maps, pins, customers, shown]);

  // The spot a rep has just tapped and not decided on yet.
  React.useEffect(() => {
    if (!maps || !mapRef.current) return;
    if (selection?.kind !== 'new') {
      draftMarkerRef.current?.setMap(null);
      draftMarkerRef.current = null;
      return;
    }
    draftMarkerRef.current ??= new maps.Marker({ map: mapRef.current, zIndex: 4 });
    draftMarkerRef.current.setPosition(selection.position);
  }, [maps, selection]);

  const afterChange = (): void => {
    setSelection(null);
    void refresh().catch(() => undefined);
  };

  const toggle = (layer: Layer): void =>
    setShown((current) => {
      const next = new Set(current);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });

  return (
    <>
      <PageHeader title="Leads" subtitle="Tap a house to say how the door went" />

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {LAYERS.map((layer) => (
          <button
            key={layer.key}
            type="button"
            aria-pressed={shown.has(layer.key)}
            onClick={() => toggle(layer.key)}
            className={cn(
              'flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium transition-opacity',
              shown.has(layer.key) ? 'border-border text-foreground' : 'border-border text-muted-foreground opacity-50',
            )}
          >
            <span className="size-2.5 rounded-full" style={{ background: layer.color }} />
            {layer.label}
          </button>
        ))}
        {isCorporate && branches.length > 1 ? (
          <div className="ml-auto flex items-center gap-2 text-xs text-muted-foreground">
            New pins go to
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="h-8 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {branches.map((b) => (
                  <SelectItem key={b.id} value={b.id}>
                    {b.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        ) : null}
      </div>

      <div className="relative h-[calc(100vh-13rem)] min-h-[420px] overflow-hidden rounded-xl border border-border">
        {loadError ? (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">{loadError}</div>
        ) : (
          <div ref={containerRef} data-testid="leads-map" className="size-full" />
        )}

        <Button
          type="button"
          variant="secondary"
          size="icon"
          className="absolute bottom-4 left-4 shadow-lg"
          onClick={locateMe}
          aria-label="Show where I am"
          title="Show where I am"
        >
          <Crosshair />
        </Button>

        {selection ? (
          <div
            role="region"
            aria-label="Pin details"
            className="absolute inset-x-2 bottom-2 max-h-[70%] overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-2xl sm:inset-x-auto sm:right-3 sm:w-96"
          >
            <button
              type="button"
              className="absolute right-3 top-3 text-muted-foreground hover:text-foreground"
              onClick={() => setSelection(null)}
              aria-label="Close"
            >
              <X className="size-4" />
            </button>
            {selection.kind === 'new' ? (
              <NewKnock
                key={`${selection.position.lat},${selection.position.lng}`}
                position={selection.position}
                address={selection.address}
                branchId={isCorporate ? branchId : undefined}
                onDone={afterChange}
              />
            ) : selection.kind === 'pin' ? (
              <ExistingPin
                key={selection.pin.id}
                pin={selection.pin}
                canDelete={isCorporate || selection.pin.created_by_user_id === user?.id}
                onDone={afterChange}
              />
            ) : (
              <CustomerCard customer={selection.customer} />
            )}
          </div>
        ) : null}
      </div>
    </>
  );
}

// --- Panels ------------------------------------------------------------------

interface LeadContactForm {
  first_name: string;
  last_name: string;
  phone: string;
  email: string;
}

const EMPTY_CONTACT: LeadContactForm = { first_name: '', last_name: '', phone: '', email: '' };

function contactBody(c: LeadContactForm) {
  return {
    first_name: c.first_name.trim(),
    last_name: c.last_name.trim(),
    phone: c.phone.trim() || null,
    email: c.email.trim() || null,
  };
}

/** The wizard, with the address this pin already worked out. */
function signupLink(
  pinId: string,
  where: { lat: number; lng: number; address: Partial<GeocodedAddress> },
  leadCustomerId?: string | null,
): string {
  const params = new URLSearchParams({ pin: pinId, lat: String(where.lat), lng: String(where.lng) });
  for (const key of ['address_line1', 'city', 'province', 'postal_code'] as const) {
    const value = where.address[key];
    if (value) params.set(key, value);
  }
  if (leadCustomerId) params.set('lead', leadCustomerId);
  return `/customers/new?${params.toString()}`;
}

function NewKnock({
  position,
  address,
  branchId,
  onDone,
}: {
  position: google.maps.LatLngLiteral;
  address: GeocodedAddress | null;
  branchId?: string;
  onDone: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [notes, setNotes] = React.useState('');
  const [asLead, setAsLead] = React.useState(false);
  const [contact, setContact] = React.useState<LeadContactForm>(EMPTY_CONTACT);
  const { run, pending, error } = useSubmit();

  const drop = (status: PinStatus, withContact: boolean) =>
    api.post<LeadPin>('/leads/pins', {
      ...(branchId ? { branch_id: branchId } : {}),
      latitude: position.lat,
      longitude: position.lng,
      address_line1: address?.address_line1 ?? null,
      city: address?.city ?? null,
      province: address?.province ?? null,
      postal_code: address?.postal_code ?? null,
      status,
      notes: notes.trim() || null,
      lead: withContact ? contactBody(contact) : null,
    });

  return (
    <div className="pr-6">
      <p className="text-xs text-muted-foreground">New knock</p>
      <p className="mt-0.5 text-sm font-medium text-foreground">
        {address === null ? 'Finding the address…' : address.formatted ?? 'No address found here — the pin still saves.'}
      </p>

      <Textarea
        className="mt-3"
        rows={2}
        placeholder="Notes (optional)"
        value={notes}
        onChange={(e) => setNotes(e.target.value)}
      />

      {asLead ? (
        <ContactFields value={contact} onChange={setContact} />
      ) : null}

      {error ? <div className="mt-3"><ErrorNotice message={error} /></div> : null}

      {asLead ? (
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="secondary" disabled={pending} onClick={() => setAsLead(false)}>
            Back
          </Button>
          <Button
            type="button"
            className="flex-1"
            disabled={pending}
            onClick={() => run(async () => { await drop('lead', true); onDone(); })}
          >
            Save lead
          </Button>
        </div>
      ) : (
        <div className="mt-3 grid grid-cols-2 gap-2">
          <OutcomeButton layer="not_home" disabled={pending} onClick={() => run(async () => { await drop('not_home', false); onDone(); })} />
          <OutcomeButton layer="not_interested" disabled={pending} onClick={() => run(async () => { await drop('not_interested', false); onDone(); })} />
          <OutcomeButton layer="lead" disabled={pending} onClick={() => setAsLead(true)} />
          <Button
            type="button"
            disabled={pending}
            onClick={() =>
              run(async () => {
                // Pinned first, so the knock is on the map even if the
                // sign-up stops halfway.
                const pin = await drop('lead', false);
                navigate(signupLink(pin.id, { ...position, address: address ?? {} }));
              })
            }
          >
            Add customer
          </Button>
        </div>
      )}
    </div>
  );
}

function ExistingPin({
  pin,
  canDelete,
  onDone,
}: {
  pin: PinView;
  canDelete: boolean;
  onDone: () => void;
}): JSX.Element {
  const navigate = useNavigate();
  const [notes, setNotes] = React.useState(pin.notes ?? '');
  const [asLead, setAsLead] = React.useState(false);
  const [contact, setContact] = React.useState<LeadContactForm>(EMPTY_CONTACT);
  const { run, pending, error } = useSubmit();

  const change = (status: PinStatus, withContact = false) =>
    run(async () => {
      await api.patch(`/leads/pins/${pin.id}`, {
        status,
        notes: notes.trim() || null,
        ...(withContact ? { lead: contactBody(contact) } : {}),
      });
      onDone();
    });

  return (
    <div className="pr-6">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-2.5 rounded-full" style={{ background: colorOf(pin.status) }} />
        {labelOf(pin.status)} · {pin.knock_count} {pin.knock_count === 1 ? 'knock' : 'knocks'} · last{' '}
        {relative(pin.last_knocked_at)}
        {pin.created_by_name ? ` · ${pin.created_by_name}` : ''}
      </p>
      <p className="mt-0.5 text-sm font-medium text-foreground">
        {pin.address_line1 ? `${pin.address_line1}${pin.city ? `, ${pin.city}` : ''}` : 'No address on this pin'}
      </p>
      {pin.customer_id ? (
        <Link className="mt-1 inline-block text-xs text-primary hover:underline" to={`/customers/${pin.customer_id}`}>
          Open their lead
        </Link>
      ) : null}

      <Textarea className="mt-3" rows={2} placeholder="Notes" value={notes} onChange={(e) => setNotes(e.target.value)} />

      {asLead ? <ContactFields value={contact} onChange={setContact} /> : null}
      {error ? <div className="mt-3"><ErrorNotice message={error} /></div> : null}

      {asLead ? (
        <div className="mt-3 flex gap-2">
          <Button type="button" variant="secondary" disabled={pending} onClick={() => setAsLead(false)}>
            Back
          </Button>
          <Button type="button" className="flex-1" disabled={pending} onClick={() => change('lead', true)}>
            Save lead
          </Button>
        </div>
      ) : (
        <>
          <p className="mt-3 text-xs text-muted-foreground">Knocked again?</p>
          <div className="mt-1.5 grid grid-cols-2 gap-2">
            <OutcomeButton layer="not_home" disabled={pending} onClick={() => change('not_home')} />
            <OutcomeButton layer="not_interested" disabled={pending} onClick={() => change('not_interested')} />
            <OutcomeButton
              layer="lead"
              disabled={pending}
              onClick={() => (pin.customer_id ? change('lead') : setAsLead(true))}
            />
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                navigate(
                  signupLink(
                    pin.id,
                    { lat: Number(pin.latitude), lng: Number(pin.longitude), address: pin },
                    pin.customer_id,
                  ),
                )
              }
            >
              Add customer
            </Button>
          </div>
          <div className="mt-2 flex justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  await api.patch(`/leads/pins/${pin.id}`, { notes: notes.trim() || null });
                  onDone();
                })
              }
            >
              Save notes
            </Button>
            {canDelete ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="text-critical"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await api.del(`/leads/pins/${pin.id}`);
                    onDone();
                  })
                }
              >
                <Trash2 className="size-3.5" /> Remove pin
              </Button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}

function CustomerCard({ customer }: { customer: CustomerPin }): JSX.Element {
  const services = ADDONS.filter((a) => customer[a.key]).map((a) => a.label);
  return (
    <div className="pr-6 text-sm">
      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="size-2.5 rounded-full" style={{ background: colorOf('customer') }} />
        Customer
        {customer.billing_type ? ` · ${customer.billing_type === 'monthly' ? 'Monthly' : 'Seasonal'}` : ''}
      </p>
      <p className="mt-0.5 font-medium text-foreground">{customer.customer_name}</p>
      <p className="text-muted-foreground">
        {customer.address_line1}
        {customer.address_line2 ? `, Unit ${customer.address_line2}` : ''}, {customer.city}
      </p>
      <p className="mt-2">
        <span className="text-muted-foreground">Services: </span>
        {['Driveway', ...services].join(', ')}
      </p>
      {customer.access_notes ? (
        <p className="mt-2 rounded-lg bg-accent/40 px-3 py-2 text-secondary-foreground">{customer.access_notes}</p>
      ) : null}
      <Link className="mt-3 inline-block text-primary hover:underline" to={`/customers/${customer.customer_id}`}>
        Open customer
      </Link>
    </div>
  );
}

function OutcomeButton({
  layer,
  disabled,
  onClick,
}: {
  layer: PinStatus;
  disabled: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <Button type="button" variant="secondary" disabled={disabled} onClick={onClick} className="justify-start gap-2">
      <span className="size-2.5 shrink-0 rounded-full" style={{ background: colorOf(layer) }} />
      {labelOf(layer)}
    </Button>
  );
}

function ContactFields({
  value,
  onChange,
}: {
  value: LeadContactForm;
  onChange: (next: LeadContactForm) => void;
}): JSX.Element {
  const field = (key: keyof LeadContactForm, label: string, type = 'text') => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`lead-${key}`} className="text-xs">
        {label}
      </Label>
      <Input
        id={`lead-${key}`}
        type={type}
        value={value[key]}
        onChange={(e) => onChange({ ...value, [key]: e.target.value })}
      />
    </div>
  );
  return (
    <div className="mt-3 grid grid-cols-2 gap-2">
      {field('first_name', 'First name')}
      {field('last_name', 'Last name')}
      {field('phone', 'Phone', 'tel')}
      {field('email', 'Email', 'email')}
      <p className="col-span-2 text-xs text-muted-foreground">A phone or an email, so someone can follow up.</p>
    </div>
  );
}
