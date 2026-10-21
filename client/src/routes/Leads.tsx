import * as React from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Crosshair, X } from 'lucide-react';
import type { Branch, LeadPin, PinStatus } from '../../../src/types/models';
import { useAuth } from '@/auth/AuthContext';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import * as api from '@/lib/api';
import { relative } from '@/lib/format';
import { addressAt, loadGoogleMaps, type GeocodedAddress } from '@/lib/googleMaps';
import { usePublicConfigState } from '@/lib/publicApi';
import { AGREEMENT_ADDONS } from '../../../src/types/agreement';
import { ADDONS } from '@/lib/sales';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';

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
  package: string | null;
  addons: string[];
}

type Layer = PinStatus | 'customer';
/** The outcomes that take the person's name and number. */
type ContactStatus = Extract<PinStatus, 'lead' | 'monitor'>;

/**
 * Each kind of pin: its colour, and the white symbol drawn on it so a pin
 * reads at a glance from the street. The symbols are Lucide's (minus, x,
 * rotate-ccw, eye, house) as SVG paths on a 24-unit grid.
 */
const LAYERS: { key: Layer; label: string; color: string; glyph: string }[] = [
  { key: 'not_home', label: 'Not home', color: '#3b82f6', glyph: '<path d="M5 12h14"/>' },
  { key: 'not_interested', label: 'Not interested', color: '#374151', glyph: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>' },
  // Come back to it.
  {
    key: 'lead',
    label: 'Lead',
    color: '#22c55e',
    glyph: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
  },
  // Keeping an eye on it: taken down like a lead, not one yet.
  {
    key: 'monitor',
    label: 'Monitor',
    color: '#0891b2',
    glyph:
      '<path d="M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"/>' +
      '<circle cx="12" cy="12" r="3"/>',
  },
  // Gold, so a signed customer never reads as a lead. Deep enough for the
  // white house to stand out on it.
  {
    key: 'customer',
    label: 'Customer',
    color: '#ca8a04',
    glyph:
      '<path d="M15 21v-8a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v8"/>' +
      '<path d="M3 10a2 2 0 0 1 .709-1.528l7-5.999a2 2 0 0 1 2.582 0l7 5.999A2 2 0 0 1 21 10v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
  },
];
const colorOf = (layer: Layer): string => LAYERS.find((l) => l.key === layer)?.color ?? '#94a3b8';
const labelOf = (layer: Layer): string => LAYERS.find((l) => l.key === layer)?.label ?? layer;

/** A pin big enough to tap with a glove on: a coloured disc with its symbol in white. */
function pinIcon(maps: typeof google.maps, layer: Layer): google.maps.Icon {
  const spec = LAYERS.find((l) => l.key === layer);
  const size = layer === 'customer' ? 38 : 34;
  const glyph = 20;
  const offset = (size - glyph) / 2;
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${size / 2 - 1.5}" fill="${spec?.color ?? '#94a3b8'}" stroke="#ffffff" stroke-width="2.5"/>` +
    `<g transform="translate(${offset} ${offset}) scale(${glyph / 24})" fill="none" stroke="#ffffff" stroke-width="2.75" ` +
    `stroke-linecap="round" stroke-linejoin="round">${spec?.glyph ?? ''}</g></svg>`;
  return {
    url: `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`,
    scaledSize: new maps.Size(size, size),
    anchor: new maps.Point(size / 2, size / 2),
  };
}

type Selection =
  | { kind: 'new'; position: google.maps.LatLngLiteral; address: GeocodedAddress | null }
  | { kind: 'pin'; pin: PinView }
  | { kind: 'customer'; customer: CustomerPin };

/** Where to look when the phone will not say where it is. Middle of the Maritimes. */
const FALLBACK_CENTER = { lat: 45.0, lng: -64.0 };

export function Leads(): JSX.Element {
  const { config, error: configError } = usePublicConfigState();
  const { data: branches, error } = useQuery(() => api.get<Branch[]>('/branches'), []);

  if (error) return <ErrorNotice message={error} />;
  if (configError) return <ErrorNotice message={configError} />;
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
      wanted.set(`pin:${pin.id}`, {
        position: { lat: Number(pin.latitude), lng: Number(pin.longitude) },
        layer: pin.status,
        title: `${labelOf(pin.status)}${pin.address_line1 ? ` · ${pin.address_line1}` : ''}`,
        onClick: () => setSelection({ kind: 'pin', pin }),
      });
    }
    for (const customer of customers) {
      wanted.set(`customer:${customer.property_id}`, {
        position: { lat: Number(customer.latitude), lng: Number(customer.longitude) },
        layer: 'customer',
        title: `${customer.customer_name} · ${customer.address_line1}`,
        onClick: () => setSelection({ kind: 'customer', customer }),
      });
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
        icon: pinIcon(maps, spec.layer),
      });
      marker.addListener('click', spec.onClick);
      markers.set(key, marker);
    }
  }, [maps, pins, customers]);

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

  return (
    <>
      {/* The whole page is the map: between the top bar and the tabs on a
          phone, so it owns every swipe and there is nothing to scroll; the
          full window beside the menu otherwise. */}
      <div className="relative h-screen min-h-[420px] overflow-hidden max-[720px]:h-[calc(100dvh-110px-env(safe-area-inset-top)-env(safe-area-inset-bottom))] max-[720px]:min-h-[300px]">
        {loadError ? (
          <div className="grid h-full place-items-center p-6 text-center text-sm text-muted-foreground">{loadError}</div>
        ) : (
          <div ref={containerRef} data-testid="leads-map" className="size-full" />
        )}

        {isCorporate && branches.length > 1 ? (
          <div className="absolute left-3 top-3 flex items-center gap-2 rounded-lg border border-border bg-card/90 px-2.5 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur">
            New pins go to
            <Select value={branchId} onValueChange={setBranchId}>
              <SelectTrigger className="h-8 w-36">
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
          // Covers the map, so a tap outside the box closes it rather than
          // dropping another pin.
          <div
            className="absolute inset-0 z-10 flex items-center justify-center bg-black/40 p-3"
            onClick={(e) => {
              if (e.target === e.currentTarget) setSelection(null);
            }}
          >
           <div className="flex max-h-full w-full max-w-sm flex-col gap-2">
            <div
              role="region"
              aria-label="Pin details"
              className="overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-2xl"
            >
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
            <button
              type="button"
              onClick={() => setSelection(null)}
              aria-label="Close"
              className="flex h-11 shrink-0 items-center justify-center rounded-xl border border-border bg-card text-muted-foreground shadow-2xl hover:text-foreground"
            >
              <X className="size-5" />
            </button>
           </div>
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
  /** They said yes to the cold email sequence, at the door. */
  email_opt_in: boolean;
}

const EMPTY_CONTACT: LeadContactForm = {
  first_name: '',
  last_name: '',
  phone: '',
  email: '',
  email_opt_in: false,
};

function contactBody(c: LeadContactForm) {
  return {
    first_name: c.first_name.trim(),
    last_name: c.last_name.trim(),
    phone: c.phone.trim() || null,
    email: c.email.trim() || null,
    email_opt_in: c.email_opt_in && c.email.trim() !== '',
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
  // Lead and monitor both take the person's details before the pin saves.
  const [taking, setTaking] = React.useState<ContactStatus | null>(null);
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
      notes: null,
      lead: withContact ? contactBody(contact) : null,
    });

  return (
    <div>
      <p className="text-center text-base font-semibold text-foreground">
        {address === null ? 'Finding the address…' : address.formatted ?? 'No address found here — the pin still saves.'}
      </p>

      {taking ? (
        <>
          <ContactFields value={contact} onChange={setContact} />
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setTaking(null)}>
              Back
            </Button>
            <Button
              type="button"
              className="flex-1"
              disabled={pending}
              onClick={() => run(async () => { await drop(taking, true); onDone(); })}
            >
              Save {labelOf(taking).toLowerCase()}
            </Button>
          </div>
        </>
      ) : (
        <div className="mt-3 flex flex-col gap-2">
          <OutcomeButton layer="not_home" disabled={pending} onClick={() => run(async () => { await drop('not_home', false); onDone(); })} />
          <OutcomeButton layer="not_interested" disabled={pending} onClick={() => run(async () => { await drop('not_interested', false); onDone(); })} />
          <OutcomeButton layer="lead" disabled={pending} onClick={() => setTaking('lead')} />
          <OutcomeButton layer="monitor" disabled={pending} onClick={() => setTaking('monitor')} />
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

      {error ? <div className="mt-3"><ErrorNotice message={error} /></div> : null}
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
  const [taking, setTaking] = React.useState<ContactStatus | null>(null);
  const [contact, setContact] = React.useState<LeadContactForm>(EMPTY_CONTACT);
  const { run, pending, error } = useSubmit();

  const change = (status: PinStatus, withContact = false) =>
    run(async () => {
      await api.patch(`/leads/pins/${pin.id}`, {
        status,
        ...(withContact ? { lead: contactBody(contact) } : {}),
      });
      onDone();
    });
  // A pin that already has the person's details just changes colour.
  const take = (status: ContactStatus) => (pin.customer_id ? change(status) : setTaking(status));

  return (
    <div>
      <p className="text-center text-base font-semibold text-foreground">
        {pin.address_line1 ? `${pin.address_line1}${pin.city ? `, ${pin.city}` : ''}` : 'No address on this pin'}
      </p>
      <p className="mt-1 flex items-center justify-center gap-2 text-xs text-muted-foreground">
        <span className="size-2.5 rounded-full" style={{ background: colorOf(pin.status) }} />
        {labelOf(pin.status)} · {pin.knock_count} {pin.knock_count === 1 ? 'knock' : 'knocks'} · last{' '}
        {relative(pin.last_knocked_at)}
        {pin.created_by_name ? ` · ${pin.created_by_name}` : ''}
      </p>
      {pin.customer_id ? (
        <Link className="mt-1 block text-center text-xs text-primary hover:underline" to={`/customers/${pin.customer_id}`}>
          Open their lead
        </Link>
      ) : null}

      {pin.notes ? (
        <p className="mt-2 rounded-lg bg-accent/40 px-3 py-2 text-xs text-secondary-foreground">{pin.notes}</p>
      ) : null}

      {taking ? (
        <>
          <ContactFields value={contact} onChange={setContact} />
          <div className="mt-3 flex gap-2">
            <Button type="button" variant="secondary" disabled={pending} onClick={() => setTaking(null)}>
              Back
            </Button>
            <Button type="button" className="flex-1" disabled={pending} onClick={() => change(taking, true)}>
              Save {labelOf(taking).toLowerCase()}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="mt-3 text-xs text-muted-foreground">Knocked again?</p>
          <div className="mt-1.5 flex flex-col gap-2">
            <OutcomeButton layer="not_home" disabled={pending} onClick={() => change('not_home')} />
            <OutcomeButton layer="not_interested" disabled={pending} onClick={() => change('not_interested')} />
            <OutcomeButton layer="lead" disabled={pending} onClick={() => take('lead')} />
            <OutcomeButton layer="monitor" disabled={pending} onClick={() => take('monitor')} />
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
            {canDelete ? (
              <Button
                type="button"
                variant="destructive"
                disabled={pending}
                onClick={() =>
                  run(async () => {
                    await api.del(`/leads/pins/${pin.id}`);
                    onDone();
                  })
                }
              >
                Remove pin
              </Button>
            ) : null}
          </div>
        </>
      )}
      {error ? <div className="mt-3"><ErrorNotice message={error} /></div> : null}
    </div>
  );
}

function CustomerCard({ customer }: { customer: CustomerPin }): JSX.Element {
  const services = [
    ...(customer.package ? [`${customer.package === 'premium' ? 'Premium' : 'Basic'} package`] : ['Driveway']),
    ...AGREEMENT_ADDONS.filter((a) => customer.addons.includes(a.code)).map((a) => a.label),
    ...ADDONS.filter((a) => customer[a.key]).map((a) => a.label),
  ];
  return (
    <div className="text-sm">
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
        {services.join(', ')}
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
  const field = (key: Exclude<keyof LeadContactForm, 'email_opt_in'>, label: string, type = 'text') => (
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
      <label className="col-span-2 flex items-start gap-2 text-xs text-foreground">
        <Checkbox
          className="mt-0.5"
          checked={value.email_opt_in}
          disabled={value.email.trim() === ''}
          onCheckedChange={(v) => onChange({ ...value, email_opt_in: v === true })}
        />
        <span>Receive email follow-ups</span>
      </label>
    </div>
  );
}
