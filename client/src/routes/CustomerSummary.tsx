import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  CalendarClock,
  ClipboardList,
  Copy,
  CreditCard,
  FilePlus2,
  Info,
  Map as MapIcon,
  MapPinned,
  MessageSquareText,
  Pencil,
  Plus,
  Send,
  Settings2,
  UserRoundCheck,
} from 'lucide-react';
import type { MessageTemplate, Property } from '../../../src/types/models';
import { PHONE_TYPES, type AgreementModel, type NoteKind, type PhoneType } from '../../../src/types/serviceAgreement';
import { useAuth } from '@/auth/AuthContext';
import { ConfirmDelete } from '@/components/ConfirmDelete';
import { DataTable } from '@/components/DataTable';
import { Disclosure } from '@/components/Disclosure';
import { InlineForm } from '@/components/InlineForm';
import { ListTable } from '@/components/ListTable';
import { ErrorNotice, Loading } from '@/components/Misc';
import { StatusPill } from '@/components/StatusPill';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Textarea } from '@/components/ui/textarea';
import {
  addressOf,
  mapsUrl,
  phoneBadge,
  PHONE_TYPE_LABELS,
  streetViewUrl,
  type CustomerSummary as Summary,
  type NoteRow,
  type SmsThreadEntry,
} from '@/lib/agreements';
import * as api from '@/lib/api';
import { date, money, stamp } from '@/lib/format';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';
import { cn } from '@/lib/utils';

/**
 * The Customer Summary: one customer at a glance. Who they are and where we
 * clear, what they have signed, the texts back and forth, and the notes the
 * office and the crews keep — with the contract form a click away.
 */
export function CustomerSummary(): JSX.Element {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const { data, loading, error, reload } = useQuery(() => api.get<Summary>(`/customers/${id}/summary`), [id]);
  const [propertyId, setPropertyId] = React.useState<string | null>(null);
  const [serviceInfoOpen, setServiceInfoOpen] = React.useState(false);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const { customer, active_contract: active } = data;
  const property =
    data.properties.find((p) => p.id === (propertyId ?? data.service_property_id)) ?? data.properties[0] ?? null;
  const newContract = `/customers/${customer.id}/contracts/new`;

  return (
    <div className="flex flex-col gap-4 lg:flex-row-reverse lg:items-start">
      {/* The page's own navigation: a column at laptop width, a row above the cards on a tablet. */}
      <nav aria-label="Customer" className="lg:sticky lg:top-4 lg:w-52 lg:shrink-0">
        <Card>
          <CardContent className="flex flex-wrap gap-1 p-2 lg:flex-col">
            <Button type="button" variant="ghost" className="justify-start" onClick={() => setServiceInfoOpen(true)}>
              <Info className="size-4" /> Service Information
            </Button>
            <Button asChild variant="ghost" className="justify-start">
              <Link to={newContract}>
                <FilePlus2 className="size-4" /> Create New Contract
              </Link>
            </Button>
            <Button asChild variant="ghost" className="justify-start">
              <a href="#addresses">
                <MapPinned className="size-4" /> Addresses
              </a>
            </Button>
          </CardContent>
        </Card>
      </nav>

      <div className="flex min-w-0 flex-1 flex-col gap-4">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">
              {customer.first_name} {customer.last_name}
            </h1>
            <p className="text-sm text-muted-foreground">
              {data.branch.name} branch · customer since {date(String(customer.created_at).slice(0, 10))}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className="max-w-full truncate rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground">
              {active ? `${active.agreement} – Active` : customer.status === 'lead' ? 'Lead – no contract yet' : 'No active contract'}
            </span>
            <Button asChild size="sm">
              <Link to={newContract}>
                <Plus className="size-4" /> Add Contract
              </Link>
            </Button>
            <ConfirmDelete
              what={`${customer.first_name} ${customer.last_name}`}
              consequences={
                data.contracts.length
                  ? 'Their addresses, agreements, contracts, invoices, payments, notes and visits are deleted with them.'
                  : 'Their addresses and notes are deleted with them.'
              }
              typeToConfirm="DELETE"
              size="sm"
              onConfirm={() => api.del(`/customers/${customer.id}?confirm=DELETE`)}
              onDeleted={() => navigate('/customers')}
            />
          </div>
        </header>

        <ServiceAddressCard summary={data} property={property} onPropertyChange={setPropertyId} onSaved={reload} />

        <div className="grid gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <ContractsCard summary={data} newContract={newContract} />
          <SmsCard summary={data} onChanged={reload} />
        </div>

        <NotesCard customerId={customer.id} />

        <AddressesSection summary={data} onChanged={reload} />
      </div>

      <ServiceInfoDialog summary={data} open={serviceInfoOpen} onOpenChange={setServiceInfoOpen} />
    </div>
  );
}

// ── Service address ───────────────────────────────────────────────────────

function ServiceAddressCard({
  summary,
  property,
  onPropertyChange,
  onSaved,
}: {
  summary: Summary;
  property: Property | null;
  onPropertyChange: (id: string) => void;
  onSaved: () => void;
}): JSX.Element {
  const { customer, phones, payment_method: card } = summary;
  const [editing, setEditing] = React.useState(false);
  const address = property ? addressOf(property) : null;
  const phoneList = phones.length
    ? phones
    : customer.phone
      ? [{ id: 'legacy', number: customer.phone, phone_type: 'mobile' as const, is_primary: true }]
      : [];

  return (
    <Card>
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-3 space-y-0">
        <CardTitle>Service Address</CardTitle>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
          <span className="inline-flex items-center gap-1.5 text-muted-foreground" title={card ? `${card.brand ?? 'Card'} ending ${card.last4}` : 'No card on file'}>
            <CreditCard className={cn('size-4', card ? 'text-good' : 'text-muted-foreground')} />
            {card ? `${card.brand ?? 'Card'} ••${card.last4}` : 'No card'}
          </span>
          <span>
            Balance: <strong className={cn(Number(summary.balance) > 0 && 'text-serious')}>{money(summary.balance)}</strong>
          </span>
          <span>
            Credit: <strong className={cn(Number(summary.credit) > 0 && 'text-good')}>{money(summary.credit)}</strong>
          </span>
          <Button type="button" variant="secondary" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" /> Edit
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-2">
        <div className="flex flex-col gap-1.5">
          <p className="text-base font-semibold">
            {customer.first_name} {customer.last_name}
          </p>
          {property && address ? (
            <>
              <a className="text-primary hover:underline" href={mapsUrl(address)} target="_blank" rel="noopener noreferrer">
                {address}
              </a>
              <div className="flex gap-1.5">
                <Button asChild variant="secondary" size="icon" className="size-8" title="Map view">
                  <a href={mapsUrl(address)} target="_blank" rel="noopener noreferrer" aria-label="Open in Google Maps">
                    <MapIcon className="size-4" />
                  </a>
                </Button>
                <Button asChild variant="secondary" size="icon" className="size-8" title="Street view of the property">
                  <a
                    href={streetViewUrl(property, address)}
                    target="_blank"
                    rel="noopener noreferrer"
                    aria-label="Look up the property in Street View"
                  >
                    <MapPinned className="size-4" />
                  </a>
                </Button>
              </div>
              {summary.properties.length > 1 ? (
                <Select value={property.id} onValueChange={onPropertyChange}>
                  <SelectTrigger className="mt-1 h-8 max-w-sm" aria-label="Show another address">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {summary.properties.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.address_line1}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : null}
              {property.access_notes ? (
                <p className="mt-1 rounded-lg bg-accent/40 px-3 py-2 text-xs text-secondary-foreground">
                  <span className="font-semibold">Notes for the crew: </span>
                  {property.access_notes}
                </p>
              ) : null}
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No service address yet — add one under Addresses below.</p>
          )}
        </div>

        <div className="flex flex-col gap-2 text-sm md:items-end">
          {customer.email ? (
            <a className="text-primary hover:underline" href={`mailto:${customer.email}`}>
              {customer.email}
            </a>
          ) : (
            <span className="text-muted-foreground">No email on file</span>
          )}
          {phoneList.length ? (
            phoneList.map((phone) => (
              <span key={phone.id} className="flex items-center gap-2">
                <a className="hover:underline" href={`tel:${phone.number}`}>
                  {phone.number}
                </a>
                <Badge variant={phone.is_primary ? 'primary' : 'neutral'}>{phoneBadge(phone)}</Badge>
              </span>
            ))
          ) : (
            <span className="text-muted-foreground">No phone on file</span>
          )}
          {customer.billing_address_line1 ? (
            <span className="text-xs text-muted-foreground md:text-right">
              Bills to: {customer.billing_address_line1}, {customer.billing_city} {customer.billing_province}{' '}
              {customer.billing_postal_code}
            </span>
          ) : null}
        </div>
      </CardContent>
      <EditCustomerDialog summary={summary} open={editing} onOpenChange={setEditing} onSaved={onSaved} />
    </Card>
  );
}

interface PhoneDraft {
  number: string;
  phone_type: PhoneType;
  is_primary: boolean;
}

function EditCustomerDialog({
  summary,
  open,
  onOpenChange,
  onSaved,
}: {
  summary: Summary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}): JSX.Element {
  const { customer } = summary;
  const initialPhones = (): PhoneDraft[] =>
    summary.phones.length
      ? summary.phones.map((p) => ({ number: p.number, phone_type: p.phone_type, is_primary: p.is_primary }))
      : [{ number: customer.phone ?? '', phone_type: 'mobile', is_primary: true }];
  const [fields, setFields] = React.useState(() => fieldsOf(customer));
  const [phones, setPhones] = React.useState<PhoneDraft[]>(initialPhones);
  const [separateBilling, setSeparateBilling] = React.useState(!!customer.billing_address_line1);
  const { run, pending, error } = useSubmit(() => {
    onOpenChange(false);
    onSaved();
  });

  React.useEffect(() => {
    if (open) {
      setFields(fieldsOf(customer));
      setPhones(initialPhones());
      setSeparateBilling(!!customer.billing_address_line1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const set = (name: keyof ReturnType<typeof fieldsOf>, value: string) => setFields((f) => ({ ...f, [name]: value }));
  const save = (): Promise<void> =>
    (async () => {
      // Phones first, so a new primary number is there before the preferred contact needs it.
      const kept = phones.filter((p) => p.number.trim());
      await api.put(`/customers/${customer.id}/phones`, { phones: kept });
      await api.patch(`/customers/${customer.id}`, {
        first_name: fields.first_name,
        last_name: fields.last_name,
        email: fields.email || null,
        preferred_contact: fields.preferred_contact,
        billing_address_line1: separateBilling ? fields.billing_address_line1 || null : null,
        billing_address_line2: separateBilling ? fields.billing_address_line2 || null : null,
        billing_city: separateBilling ? fields.billing_city || null : null,
        billing_province: separateBilling ? fields.billing_province || null : null,
        billing_postal_code: separateBilling ? fields.billing_postal_code || null : null,
      });
    })();

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Edit customer</DialogTitle>
          <DialogDescription>Contact details and where bills go.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextField label="First name" value={fields.first_name} onChange={(v) => set('first_name', v)} />
          <TextField label="Last name" value={fields.last_name} onChange={(v) => set('last_name', v)} />
          <TextField label="Email" type="email" value={fields.email} onChange={(v) => set('email', v)} />
          <div className="flex flex-col gap-1.5">
            <Label>Preferred contact</Label>
            <Select value={fields.preferred_contact} onValueChange={(v) => set('preferred_contact', v)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="email">Email</SelectItem>
                <SelectItem value="sms">Text</SelectItem>
                <SelectItem value="both">Both</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>

        <fieldset className="mt-2 flex flex-col gap-2">
          <legend className="mb-1 text-sm font-medium">Phone numbers</legend>
          {phones.map((phone, i) => (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <Input
                className="w-44"
                value={phone.number}
                aria-label={`Phone ${i + 1}`}
                onChange={(e) => setPhones((all) => all.map((p, j) => (j === i ? { ...p, number: e.target.value } : p)))}
              />
              <Select
                value={phone.phone_type}
                onValueChange={(v) => setPhones((all) => all.map((p, j) => (j === i ? { ...p, phone_type: v as PhoneType } : p)))}
              >
                <SelectTrigger className="w-32" aria-label={`Phone ${i + 1} type`}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PHONE_TYPES.map((t) => (
                    <SelectItem key={t} value={t}>
                      {PHONE_TYPE_LABELS[t]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex items-center gap-1.5 text-sm">
                <input
                  type="radio"
                  name="primary-phone"
                  checked={phone.is_primary}
                  onChange={() => setPhones((all) => all.map((p, j) => ({ ...p, is_primary: j === i })))}
                />
                Primary
              </label>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setPhones((all) => all.filter((_, j) => j !== i))}
                aria-label={`Remove phone ${i + 1}`}
              >
                Remove
              </Button>
            </div>
          ))}
          <Button
            type="button"
            variant="secondary"
            size="sm"
            className="w-fit"
            onClick={() => setPhones((all) => [...all, { number: '', phone_type: 'mobile', is_primary: all.length === 0 }])}
          >
            <Plus className="size-3.5" /> Add phone
          </Button>
        </fieldset>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <Checkbox checked={separateBilling} onCheckedChange={(v) => setSeparateBilling(v === true)} />
          Bills go to a different address
        </label>
        {separateBilling ? (
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField label="Billing address" value={fields.billing_address_line1} onChange={(v) => set('billing_address_line1', v)} />
            <TextField label="Unit / line 2" value={fields.billing_address_line2} onChange={(v) => set('billing_address_line2', v)} />
            <TextField label="City" value={fields.billing_city} onChange={(v) => set('billing_city', v)} />
            <TextField label="Province" value={fields.billing_province} onChange={(v) => set('billing_province', v)} />
            <TextField label="Postal code" value={fields.billing_postal_code} onChange={(v) => set('billing_postal_code', v)} />
          </div>
        ) : null}

        {error ? <ErrorNotice message={error} /> : null}
        <div className="mt-2 flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="button" disabled={pending} onClick={() => run(save)}>
            {pending ? 'Saving…' : 'Save'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function fieldsOf(customer: Summary['customer']) {
  return {
    first_name: customer.first_name,
    last_name: customer.last_name,
    email: customer.email ?? '',
    preferred_contact: customer.preferred_contact as string,
    billing_address_line1: customer.billing_address_line1 ?? '',
    billing_address_line2: customer.billing_address_line2 ?? '',
    billing_city: customer.billing_city ?? '',
    billing_province: customer.billing_province ?? '',
    billing_postal_code: customer.billing_postal_code ?? '',
  };
}

function TextField({
  label,
  value,
  onChange,
  type = 'text',
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
}): JSX.Element {
  const id = React.useId();
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} type={type} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ── Contracts ─────────────────────────────────────────────────────────────

function ContractsCard({ summary, newContract }: { summary: Summary; newContract: string }): JSX.Element {
  const navigate = useNavigate();
  const target = (row: Summary['contracts'][number]): string =>
    row.contract_id ? `/contracts/${row.contract_id}` : `/agreements/${row.quote_id}`;
  return (
    <Card className="min-w-0">
      <CardHeader className="flex-row items-center justify-between space-y-0">
        <CardTitle>Contracts</CardTitle>
        <Button asChild size="sm" variant="secondary">
          <Link to={newContract}>
            <Plus className="size-3.5" /> Add Contract
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        <ListTable
          rows={summary.contracts}
          rowKey={(row) => row.quote_id}
          emptyMessage="Nothing signed yet. Add a contract to write their agreement."
          initialSort={{ column: 2, direction: 'desc' }}
          onRowClick={(row) => navigate(target(row))}
          columns={[
            {
              header: 'Agreement',
              cell: (row) => (
                <Link className="text-primary hover:underline" to={target(row)} onClick={(e) => e.stopPropagation()}>
                  {row.agreement}
                  <span className="block text-xs text-muted-foreground">{row.address_line1}</span>
                </Link>
              ),
              sortValue: (row) => row.agreement,
              searchValue: (row) => `${row.agreement} ${row.address_line1}`,
            },
            { header: 'Status', cell: (row) => <StatusPill status={row.status} />, sortValue: (row) => row.status },
            {
              header: 'Sign-up Date',
              cell: (row) => date(String(row.signup_date).slice(0, 10)),
              sortValue: (row) => String(row.signup_date),
              searchValue: (row) => date(String(row.signup_date).slice(0, 10)),
            },
          ]}
        />
      </CardContent>
    </Card>
  );
}

// ── Text messages ─────────────────────────────────────────────────────────

/** Fills the tokens a template might use from what the page knows; anything else is left to edit by hand. */
function fillTemplate(body: string, summary: Summary): string {
  const property = summary.properties.find((p) => p.id === summary.service_property_id) ?? summary.properties[0];
  const values: Record<string, string> = {
    customer_first_name: summary.customer.first_name,
    customer_name: `${summary.customer.first_name} ${summary.customer.last_name}`,
    address_line1: property?.address_line1 ?? '',
    city: property?.city ?? '',
    branch_name: summary.branch.name,
  };
  return body.replace(/\{\{\s*(\w+)\s*\}\}/g, (match, token: string) => values[token] ?? match);
}

function SmsCard({ summary, onChanged }: { summary: Summary; onChanged: () => void }): JSX.Element {
  const customerId = summary.customer.id;
  const thread = useQuery(() => api.get<SmsThreadEntry[]>(`/customers/${customerId}/sms`), [customerId]);
  const templates = useQuery(() => api.get<MessageTemplate[]>('/message-templates'), []);
  const assignees = useQuery(
    () => api.get<{ id: string; name: string; role: string }[]>(`/customers/${customerId}/sms/assignees`),
    [customerId],
  );
  const [text, setText] = React.useState('');
  const [later, setLater] = React.useState(false);
  const [when, setWhen] = React.useState('');
  const scroller = React.useRef<HTMLDivElement>(null);
  const { run, pending, error } = useSubmit(() => {
    setText('');
    setLater(false);
    setWhen('');
    thread.reload();
  });
  const settings = useSubmit(onChanged);

  React.useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight });
  }, [thread.data]);

  const smsTemplates = (templates.data ?? []).filter((t) => t.channel === 'sms');
  const optedOut = summary.customer.sms_opt_out;

  return (
    <Card className="flex min-w-0 flex-col">
      <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
        <CardTitle className="inline-flex items-center gap-1.5">
          <MessageSquareText className="size-3.5" /> SMS Messages
        </CardTitle>
        <div className="flex items-center gap-1.5">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="sm" variant="secondary">
                <UserRoundCheck className="size-3.5" />
                {summary.sms_assigned_to ? summary.sms_assigned_to.name : 'To Employee'}
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="max-h-72 overflow-y-auto">
              <DropdownMenuLabel>Hand this thread to</DropdownMenuLabel>
              {(assignees.data ?? []).map((user) => (
                <DropdownMenuItem
                  key={user.id}
                  onSelect={() => settings.run(() => api.patch(`/customers/${customerId}/sms`, { assigned_user_id: user.id }))}
                >
                  {user.name} <span className="ml-auto text-xs text-muted-foreground">{user.role}</span>
                </DropdownMenuItem>
              ))}
              {summary.sms_assigned_to ? (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem
                    onSelect={() => settings.run(() => api.patch(`/customers/${customerId}/sms`, { assigned_user_id: null }))}
                  >
                    Unassign
                  </DropdownMenuItem>
                </>
              ) : null}
            </DropdownMenuContent>
          </DropdownMenu>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button type="button" size="icon" variant="ghost" className="size-8" aria-label="Text settings">
                <Settings2 className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuLabel>Text messages</DropdownMenuLabel>
              <DropdownMenuCheckboxItem
                checked={optedOut}
                onCheckedChange={(checked) =>
                  settings.run(() => api.patch(`/customers/${customerId}/sms`, { opt_out: checked === true }))
                }
              >
                Customer opted out (no texts)
              </DropdownMenuCheckboxItem>
              <DropdownMenuItem asChild>
                <Link to="/settings">SMS provider settings</Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        <div
          ref={scroller}
          className="flex h-72 flex-col gap-2 overflow-y-auto rounded-lg border border-border bg-background/40 p-3"
          aria-live="polite"
        >
          {thread.loading && !thread.data ? (
            <Loading />
          ) : thread.data?.length ? (
            thread.data.map((m) => (
              <div
                key={m.id}
                className={cn(
                  'max-w-[85%] rounded-2xl px-3 py-2 text-sm',
                  m.direction === 'outbound'
                    ? 'self-end rounded-br-sm bg-primary/20 text-foreground'
                    : 'self-start rounded-bl-sm bg-accent text-accent-foreground',
                )}
              >
                <p className="whitespace-pre-wrap">{m.body}</p>
                <p className="mt-1 text-[10px] text-muted-foreground">
                  {m.scheduled_for ? (
                    <span className="inline-flex items-center gap-1">
                      <CalendarClock className="size-3" /> Scheduled for {stamp(m.scheduled_for)}
                    </span>
                  ) : (
                    stamp(m.at)
                  )}
                  {m.author ? ` · ${m.author}` : ''}
                  {m.direction === 'outbound' && m.status !== 'sent' && !m.scheduled_for ? ` · ${m.status}` : ''}
                </p>
              </div>
            ))
          ) : (
            <p className="m-auto text-sm text-muted-foreground">No texts with this customer yet.</p>
          )}
        </div>

        {optedOut ? (
          <p className="text-sm text-warning">This customer has opted out of texts.</p>
        ) : (
          <>
            <div className="flex items-start gap-2">
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="secondary" size="icon" className="size-9 shrink-0" aria-label="Use a template">
                    <Copy className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="max-h-72 max-w-xs overflow-y-auto">
                  <DropdownMenuLabel>Templates</DropdownMenuLabel>
                  {smsTemplates.length ? (
                    smsTemplates.map((t) => (
                      <DropdownMenuItem key={t.id} onSelect={() => setText(fillTemplate(t.body, summary))}>
                        <span className="truncate">{t.code.replace(/_/g, ' ')}</span>
                      </DropdownMenuItem>
                    ))
                  ) : (
                    <DropdownMenuItem disabled>No text templates</DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
              <Textarea
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder="Write a text…"
                rows={3}
                maxLength={1600}
                aria-label="Message"
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <label className="flex items-center gap-2 text-sm">
                <Checkbox checked={later} onCheckedChange={(v) => setLater(v === true)} /> Send later
              </label>
              {later ? (
                <Input
                  type="datetime-local"
                  value={when}
                  onChange={(e) => setWhen(e.target.value)}
                  className="h-9 w-56"
                  aria-label="When to send"
                />
              ) : null}
              <Button
                type="button"
                className="bg-good text-white hover:bg-good/90"
                disabled={pending || !text.trim() || (later && !when)}
                onClick={() =>
                  run(() =>
                    api.post(`/customers/${customerId}/sms`, {
                      body: text,
                      send_at: later && when ? new Date(when).toISOString() : null,
                    }),
                  )
                }
              >
                <Send className="size-4" /> {later ? 'Schedule' : 'Send'}
              </Button>
            </div>
          </>
        )}
        {error || settings.error ? <ErrorNotice message={(error ?? settings.error)!} /> : null}
      </CardContent>
    </Card>
  );
}

// ── Notes ─────────────────────────────────────────────────────────────────

function NotesCard({ customerId }: { customerId: string }): JSX.Element {
  const [kind, setKind] = React.useState<NoteKind>('account');
  const [adding, setAdding] = React.useState(false);
  const [draft, setDraft] = React.useState('');
  const notes = useQuery(
    () => api.list<NoteRow>(`/customers/${customerId}/notes`, { kind, page_size: 100 }),
    [customerId, kind],
  );
  const { run, pending, error } = useSubmit(() => {
    setDraft('');
    setAdding(false);
    notes.reload();
  });

  return (
    <Card>
      <Tabs value={kind} onValueChange={(v) => setKind(v as NoteKind)}>
        <CardHeader className="flex-row flex-wrap items-center justify-between gap-2 space-y-0">
          <TabsList>
            <TabsTrigger value="account">Account Notes</TabsTrigger>
            <TabsTrigger value="operator">Operator Notes</TabsTrigger>
          </TabsList>
          <Button type="button" size="sm" variant="secondary" onClick={() => setAdding((a) => !a)}>
            <Plus className="size-3.5" /> Add Note
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <p className="text-xs text-muted-foreground">
            {kind === 'account'
              ? 'For the office: calls, billing questions, anything about the account.'
              : 'For the snow operators: gate codes, where to pile snow, obstacles, the dog in the yard.'}
          </p>
          {adding ? (
            <div className="flex flex-col gap-2 rounded-xl border border-border bg-card/40 p-3">
              <Textarea
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={kind === 'account' ? 'Write an account note…' : 'Write a note for the crews…'}
                maxLength={5000}
                aria-label="New note"
              />
              <div className="flex gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={pending || !draft.trim()}
                  onClick={() => run(() => api.post(`/customers/${customerId}/notes`, { kind, body: draft }))}
                >
                  Save note
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(false)}>
                  Cancel
                </Button>
              </div>
              {error ? <ErrorNotice message={error} /> : null}
            </div>
          ) : null}
          {(['account', 'operator'] as const).map((tab) => (
            <TabsContent key={tab} value={tab} className="mt-0">
              {notes.loading && !notes.data ? (
                <Loading />
              ) : notes.error ? (
                <ErrorNotice message={notes.error} />
              ) : (
                <ListTable
                  rows={notes.data?.data ?? []}
                  rowKey={(row) => row.id}
                  emptyMessage="No notes yet."
                  initialSort={{ column: 0, direction: 'desc' }}
                  columns={[
                    {
                      header: 'Date',
                      cell: (row) => stamp(row.created_at),
                      sortValue: (row) => row.created_at,
                      className: 'whitespace-nowrap',
                    },
                    {
                      header: 'Author',
                      cell: (row) => row.author_name ?? '—',
                      sortValue: (row) => row.author_name ?? '',
                      className: 'whitespace-nowrap',
                    },
                    {
                      header: 'Note',
                      cell: (row) => <span className="whitespace-pre-wrap">{row.body}</span>,
                      searchValue: (row) => row.body,
                    },
                  ]}
                />
              )}
            </TabsContent>
          ))}
        </CardContent>
      </Tabs>
    </Card>
  );
}

// ── Addresses ─────────────────────────────────────────────────────────────

function AddressesSection({ summary, onChanged }: { summary: Summary; onChanged: () => void }): JSX.Element {
  const { isBranch, branch } = useAuth();
  const branchCity = isBranch ? (branch?.default_city ?? null) : null;
  return (
    <Card id="addresses">
      <CardHeader>
        <CardTitle className="inline-flex items-center gap-1.5">
          <ClipboardList className="size-3.5" /> Addresses
        </CardTitle>
      </CardHeader>
      <CardContent>
        <DataTable
          rowKey={(row) => row.id}
          rows={summary.properties}
          emptyMessage="No addresses on this customer yet."
          columns={[
            { header: 'Address', cell: (row) => addressOf(row) },
            {
              header: 'Driveway',
              numeric: true,
              cell: (row) =>
                row.driveway_size_cars === null ? '—' : `${row.driveway_size_cars}${row.driveway_size_cars === 6 ? '+' : ''} cars`,
            },
            { header: 'Priority', cell: (row) => (row.priority_flag ? <StatusPill status="priority" /> : '—') },
            {
              header: 'Notes for the crew',
              cell: (row) => <span className="whitespace-pre-wrap text-xs">{row.access_notes || '—'}</span>,
            },
            {
              header: '',
              cell: (row) => (
                <ConfirmDelete
                  what={row.address_line1}
                  consequences="Its agreements, and any contract, invoices, payments and visits at this address, are deleted with it."
                  onConfirm={() => api.del(`/properties/${row.id}`)}
                  onDeleted={onChanged}
                />
              ),
            },
          ]}
        />
        <Disclosure label="Add address">
          <InlineForm
            submitLabel="Add address"
            specs={[
              { name: 'address_line1', label: 'Address', required: true },
              ...(branchCity ? [] : [{ name: 'city', label: 'City', required: true }]),
              { name: 'province', label: 'Province', required: true, value: summary.branch.province },
              { name: 'postal_code', label: 'Postal code', required: true },
              { name: 'access_notes', label: 'Notes for the crew', type: 'textarea' },
            ]}
            onSubmit={(values) =>
              api.post<Property>('/properties', {
                customer_id: summary.customer.id,
                address_line1: values.address_line1,
                ...(branchCity ? {} : { city: values.city }),
                province: values.province,
                postal_code: values.postal_code,
                access_notes: values.access_notes || null,
              })
            }
            onDone={onChanged}
          />
        </Disclosure>
      </CardContent>
    </Card>
  );
}

// ── Service information ───────────────────────────────────────────────────

function ServiceInfoDialog({
  summary,
  open,
  onOpenChange,
}: {
  summary: Summary;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}): JSX.Element {
  // The active contract's agreement, or the newest one waiting to be signed.
  const row = summary.active_contract ?? summary.contracts.find((c) => c.status === 'pending_signature' || c.status === 'sent_for_signature') ?? null;
  const doc = useQuery(
    () => (open && row ? api.get<AgreementModel>(`/agreements/${row.quote_id}/document`).catch(() => null) : Promise.resolve(null)),
    [open, row?.quote_id],
  );
  const model = doc.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90vh] max-w-xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Service Information</DialogTitle>
          <DialogDescription>{row ? `${row.agreement} · ${row.address_line1}` : 'No contract yet.'}</DialogDescription>
        </DialogHeader>
        {!row ? (
          <Button asChild>
            <Link to={`/customers/${summary.customer.id}/contracts/new`}>Create New Contract</Link>
          </Button>
        ) : doc.loading ? (
          <Loading />
        ) : !model ? (
          <p className="text-sm text-muted-foreground">
            This contract was signed on the older PDF agreement.{' '}
            {row.contract_id ? (
              <Link className="text-primary hover:underline" to={`/contracts/${row.contract_id}`}>
                Open the contract
              </Link>
            ) : null}
          </p>
        ) : (
          <div className="flex flex-col gap-3 text-sm">
            <p>{model.service_summary}</p>
            <p>
              <span className="font-medium">Plan:</span> {model.plan_label}
            </p>
            <div>
              <p className="font-medium">Areas cleared</p>
              <ul className="ml-4 list-disc">
                {model.scope.filter((s) => s.checked).map((s) => (
                  <li key={s.label}>{s.label}</li>
                ))}
              </ul>
            </div>
            {model.addons.some((a) => a.checked) ? (
              <div>
                <p className="font-medium">Additional services</p>
                <ul className="ml-4 list-disc">
                  {model.addons.filter((a) => a.checked).map((a) => (
                    <li key={a.label}>
                      {a.label} {a.price ? `(${a.price})` : ''}
                    </li>
                  ))}
                </ul>
              </div>
            ) : null}
            <div className="grid grid-cols-2 gap-x-4">
              {model.pricing_lines.map((line) => (
                <React.Fragment key={line.label}>
                  <span className="text-muted-foreground">{line.label}</span>
                  <span className="text-right tabular-nums">{line.value}</span>
                </React.Fragment>
              ))}
            </div>
            <div className="flex flex-wrap gap-2">
              <Button asChild size="sm">
                <Link to={row.contract_id ? `/contracts/${row.contract_id}` : `/agreements/${row.quote_id}`}>
                  {row.contract_id ? 'Open the contract' : 'Open the agreement'}
                </Link>
              </Button>
              {!row.contract_id ? (
                <Button asChild size="sm" variant="secondary">
                  <Link to={`/agreements/${row.quote_id}/edit`}>Edit the agreement</Link>
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
