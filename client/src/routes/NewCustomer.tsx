import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Check } from 'lucide-react';
import {
  CURRENT_TERMS_VERSION,
  PREFERRED_CONTACTS,
  type Branch,
  type BillingType,
  type ChecklistRequirement,
  type Contract,
  type Customer,
  type Property,
  type Quote,
} from '../../../src/types/models';
import { useAuth } from '@/auth/AuthContext';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { SignaturePad, type SignaturePadHandle } from '@/components/SignaturePad';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import * as api from '@/lib/api';
import { money } from '@/lib/format';
import { usePublicConfig } from '@/lib/publicApi';
import { ADDONS, PROVINCES, RECURRING_FLOOR, defaultSeason, parseMoney } from '@/lib/sales';
import { uploadBlob } from '@/lib/upload';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';
import { cn } from '@/lib/utils';

/**
 * Signing up a customer: who they are, what they are buying, then the
 * signature and the card. Pages one and two are only held in this screen
 * until the rep presses on from page two — nothing is written for a
 * customer who says no halfway through the pitch.
 */

type CollectMethod = 'card' | 'cash' | 'cheque';

interface CustomerForm {
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  preferred_contact: string;
  address_line1: string;
  address_line2: string;
  city: string;
  province: string;
  postal_code: string;
  branch_id: string;
}

interface SaleForm {
  addon_salt: boolean;
  addon_vehicle: boolean;
  addon_stairs: boolean;
  billing_type: BillingType;
  initial_price: string;
  discounted_price: string;
  recurring_price: string;
  collect_method: CollectMethod;
  season_start: string;
  season_end: string;
  initial_notes: string;
  permanent_notes: string;
}

interface Deal {
  customer: Customer;
  property: Property;
  quote: Quote;
}

const STEPS = ['Customer', 'Service & price', 'Sign & pay'] as const;

export function NewCustomer(): JSX.Element {
  const { isCorporate } = useAuth();
  const [params] = useSearchParams();
  const leadId = params.get('lead');

  const { data, loading, error } = useQuery(
    () =>
      Promise.all([
        api.get<Branch[]>('/branches'),
        leadId ? api.get<Customer>(`/customers/${leadId}`) : Promise.resolve(null),
      ]),
    [leadId],
  );

  if (loading || !data) return error ? <ErrorNotice message={error} /> : <Loading />;
  const [branches, lead] = data;

  if (branches.length === 0) {
    return (
      <>
        <PageHeader title="Add customer" />
        <p className="text-sm text-muted-foreground">
          {isCorporate ? (
            <>
              There are no branches yet. <Link className="text-primary hover:underline" to="/admin">Add one under Company</Link>{' '}
              first — every customer belongs to a branch.
            </>
          ) : (
            'Your account is not attached to a branch yet. Ask the office to add you to one.'
          )}
        </p>
      </>
    );
  }

  return <Wizard branches={branches} lead={lead} prefill={params} />;
}

function Wizard({
  branches,
  lead,
  prefill,
}: {
  branches: Branch[];
  lead: Customer | null;
  prefill: URLSearchParams;
}): JSX.Element {
  const { isCorporate } = useAuth();
  const [step, setStep] = React.useState(0);
  const [deal, setDeal] = React.useState<Deal | null>(null);

  const firstBranch = branches[0];
  const [customer, setCustomer] = React.useState<CustomerForm>(() => ({
    first_name: lead?.first_name ?? '',
    last_name: lead?.last_name ?? '',
    email: lead?.email ?? '',
    phone: lead?.phone ?? '',
    preferred_contact: lead?.preferred_contact ?? 'email',
    // The map hands an address over when a rep taps a house.
    address_line1: prefill.get('address_line1') ?? '',
    address_line2: '',
    city: prefill.get('city') ?? '',
    province: prefill.get('province') ?? firstBranch?.province ?? '',
    postal_code: prefill.get('postal_code') ?? '',
    branch_id: lead?.branch_id ?? firstBranch?.id ?? '',
  }));

  const [sale, setSale] = React.useState<SaleForm>(() => ({
    addon_salt: false,
    addon_vehicle: false,
    addon_stairs: false,
    billing_type: 'monthly',
    initial_price: '',
    discounted_price: '',
    recurring_price: '',
    collect_method: 'card',
    ...defaultSeason(),
    initial_notes: '',
    permanent_notes: '',
  }));

  return (
    <>
      <PageHeader
        title={lead ? `Sign up ${lead.first_name} ${lead.last_name}` : 'Add customer'}
        subtitle={deal ? 'Agreement written — take the signature.' : 'Nothing is saved until you finish page two.'}
      />
      <Stepper current={step} />

      {step === 0 ? (
        <CustomerStep
          value={customer}
          onChange={setCustomer}
          branches={branches}
          showBranch={isCorporate && !lead}
          onNext={() => setStep(1)}
        />
      ) : null}

      {step === 1 ? (
        <SaleStep
          value={sale}
          onChange={setSale}
          customer={customer}
          leadId={lead?.id ?? null}
          isCorporate={isCorporate}
          onBack={() => setStep(0)}
          onOpened={(opened) => {
            setDeal(opened);
            setStep(2);
          }}
        />
      ) : null}

      {step === 2 && deal ? <FinishStep deal={deal} collect={sale.collect_method} /> : null}
    </>
  );
}

function Stepper({ current }: { current: number }): JSX.Element {
  return (
    <ol className="mb-6 flex flex-wrap gap-2" aria-label="Progress">
      {STEPS.map((label, i) => (
        <li
          key={label}
          aria-current={i === current ? 'step' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-full border px-3 py-1 text-xs font-medium',
            i === current
              ? 'border-primary/50 bg-primary/15 text-primary'
              : i < current
                ? 'border-border text-foreground'
                : 'border-border text-muted-foreground',
          )}
        >
          <span
            className={cn(
              'grid size-5 place-items-center rounded-full text-[10px]',
              i < current ? 'bg-primary text-primary-foreground' : 'bg-muted',
            )}
          >
            {i < current ? <Check className="size-3" /> : i + 1}
          </span>
          {label}
        </li>
      ))}
    </ol>
  );
}

// --- Page one ---------------------------------------------------------------

function CustomerStep({
  value,
  onChange,
  branches,
  showBranch,
  onNext,
}: {
  value: CustomerForm;
  onChange: (next: CustomerForm) => void;
  branches: Branch[];
  showBranch: boolean;
  onNext: () => void;
}): JSX.Element {
  const [problem, setProblem] = React.useState<string | null>(null);
  const set = (key: keyof CustomerForm) => (v: string) => {
    setProblem(null);
    onChange({ ...value, [key]: v });
  };

  const next = (): void => {
    const missing: string[] = [];
    if (!value.first_name.trim()) missing.push('first name');
    if (!value.last_name.trim()) missing.push('last name');
    if (!value.address_line1.trim()) missing.push('street address');
    if (!value.city.trim()) missing.push('city');
    if (!value.province.trim()) missing.push('province');
    if (!value.postal_code.trim()) missing.push('postal code');
    const wantsEmail = value.preferred_contact !== 'sms';
    const wantsPhone = value.preferred_contact !== 'email';
    if (wantsEmail && !value.email.trim()) missing.push('email');
    if (wantsPhone && !value.phone.trim()) missing.push('phone');

    if (missing.length > 0) {
      setProblem(`Still needed: ${missing.join(', ')}.`);
      return;
    }
    setProblem(null);
    onNext();
  };

  return (
    <Section title="Customer">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id="first_name" label="First name" required>
          <Input id="first_name" value={value.first_name} onChange={(e) => set('first_name')(e.target.value)} />
        </Field>
        <Field id="last_name" label="Last name" required>
          <Input id="last_name" value={value.last_name} onChange={(e) => set('last_name')(e.target.value)} />
        </Field>
        <Field id="email" label="Email" required={value.preferred_contact !== 'sms'}>
          <Input id="email" type="email" value={value.email} onChange={(e) => set('email')(e.target.value)} />
        </Field>
        <Field id="phone" label="Phone" required={value.preferred_contact !== 'email'}>
          <Input id="phone" type="tel" value={value.phone} onChange={(e) => set('phone')(e.target.value)} />
        </Field>
        <Field id="preferred_contact" label="Preferred contact">
          <Select value={value.preferred_contact} onValueChange={set('preferred_contact')}>
            <SelectTrigger id="preferred_contact">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PREFERRED_CONTACTS.map((c) => (
                <SelectItem key={c} value={c}>
                  {c === 'sms' ? 'Text' : c === 'both' ? 'Email and text' : 'Email'}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        {showBranch ? (
          <Field id="branch_id" label="Branch" required>
            <Select
              value={value.branch_id}
              onValueChange={(id) =>
                onChange({
                  ...value,
                  branch_id: id,
                  province: branches.find((b) => b.id === id)?.province ?? value.province,
                })
              }
            >
              <SelectTrigger id="branch_id">
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
          </Field>
        ) : null}
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">Service address</h3>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-[2fr_1fr]">
        <Field id="address_line1" label="Street address" required>
          <Input id="address_line1" value={value.address_line1} placeholder="123 Main St" onChange={(e) => set('address_line1')(e.target.value)} />
        </Field>
        <Field id="address_line2" label="Unit #">
          <Input id="address_line2" value={value.address_line2} onChange={(e) => set('address_line2')(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field id="city" label="City" required>
          <Input id="city" value={value.city} onChange={(e) => set('city')(e.target.value)} />
        </Field>
        <Field id="province" label="Province" required>
          <Select value={value.province} onValueChange={set('province')}>
            <SelectTrigger id="province">
              <SelectValue placeholder="Province" />
            </SelectTrigger>
            <SelectContent>
              {PROVINCES.map((p) => (
                <SelectItem key={p} value={p}>
                  {p}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <Field id="postal_code" label="Postal code" required>
          <Input id="postal_code" value={value.postal_code} onChange={(e) => set('postal_code')(e.target.value.toUpperCase())} />
        </Field>
      </div>

      {problem ? <div className="mt-4"><ErrorNotice message={problem} /></div> : null}
      <div className="mt-5 flex justify-end">
        <Button type="button" onClick={next}>
          Next: service &amp; price
        </Button>
      </div>
    </Section>
  );
}

// --- Page two ---------------------------------------------------------------

function SaleStep({
  value,
  onChange,
  customer,
  leadId,
  isCorporate,
  onBack,
  onOpened,
}: {
  value: SaleForm;
  onChange: (next: SaleForm) => void;
  customer: CustomerForm;
  leadId: string | null;
  isCorporate: boolean;
  onBack: () => void;
  onOpened: (deal: Deal) => void;
}): JSX.Element {
  const [problem, setProblem] = React.useState<string | null>(null);
  const [floorWarning, setFloorWarning] = React.useState(false);
  const warnedFor = React.useRef<string | null>(null);
  const { run, pending, error } = useSubmit();

  const set = <K extends keyof SaleForm>(key: K, v: SaleForm[K]) => {
    setProblem(null);
    onChange({ ...value, [key]: v });
  };
  const monthly = value.billing_type === 'monthly';

  const initial = parseMoney(value.initial_price);
  const discounted = parseMoney(value.discounted_price);
  const recurring = parseMoney(value.recurring_price);

  /** The pop-up is a second look, not a gate: shown once per value typed. */
  const checkFloor = (): boolean => {
    if (!monthly || recurring === null || recurring >= RECURRING_FLOOR) return false;
    if (warnedFor.current === value.recurring_price) return false;
    warnedFor.current = value.recurring_price;
    setFloorWarning(true);
    return true;
  };

  const submit = (): void => {
    const missing: string[] = [];
    if (initial === null) missing.push('initial price');
    if (discounted === null) missing.push('discounted price');
    if (monthly && recurring === null) missing.push('recurring price');
    if (missing.length > 0) {
      setProblem(`Still needed: ${missing.join(', ')}.`);
      return;
    }
    if (discounted! > initial!) {
      setProblem('The discounted price cannot be higher than the initial price.');
      return;
    }
    if (value.season_end <= value.season_start) {
      setProblem('The season has to end after it starts.');
      return;
    }
    setProblem(null);
    if (checkFloor()) return;

    const contact = {
      first_name: customer.first_name.trim(),
      last_name: customer.last_name.trim(),
      email: customer.email.trim() || null,
      phone: customer.phone.trim() || null,
      preferred_contact: customer.preferred_contact,
    };

    run(async () => {
      // A lead's details are often thin; whatever the rep filled in at the
      // door is kept before the agreement is written against them.
      if (leadId) await api.patch(`/customers/${leadId}`, contact);

      const opened = await api.post<Deal>('/sales/deals', {
        ...(leadId
          ? { customer_id: leadId }
          : {
              customer: contact,
              ...(isCorporate ? { branch_id: customer.branch_id } : {}),
            }),
        // The map pin this sign-up started from, so it follows the customer.
        ...(stringParam('pin') ? { lead_pin_id: stringParam('pin') } : {}),
        property: {
          address_line1: customer.address_line1.trim(),
          address_line2: customer.address_line2.trim() || null,
          city: customer.city.trim(),
          province: customer.province,
          postal_code: customer.postal_code.trim(),
          access_notes: value.permanent_notes.trim() || null,
          latitude: numberParam('lat'),
          longitude: numberParam('lng'),
        },
        quote: {
          billing_type: value.billing_type,
          initial_price: initial,
          discounted_price: discounted,
          recurring_price: monthly ? recurring : null,
          season_start: value.season_start,
          season_end: value.season_end,
          notes: value.initial_notes.trim() || null,
          addon_salt: value.addon_salt,
          addon_vehicle: value.addon_vehicle,
          addon_stairs: value.addon_stairs,
        },
      });
      onOpened(opened);
    });
  };

  return (
    <Section title="Service & price">
      <h3 className="mb-2 text-sm font-semibold text-foreground">Upsells</h3>
      <div className="flex flex-wrap gap-2">
        {ADDONS.map(({ key, label }) => (
          <label
            key={key}
            className={cn(
              'flex cursor-pointer items-center gap-2 rounded-lg border px-3 py-2 text-sm',
              value[key] ? 'border-primary/50 bg-primary/10' : 'border-border',
            )}
          >
            <Checkbox checked={value[key]} onCheckedChange={(v) => set(key, v === true)} />
            {label}
          </label>
        ))}
      </div>

      <h3 className="mb-2 mt-6 text-sm font-semibold text-foreground">Billing</h3>
      <div role="radiogroup" aria-label="Billing" className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {(
          [
            ['monthly', 'Monthly billing', 'First visit at the discounted price, then the recurring price each month.'],
            ['seasonal_upfront', 'Seasonal billing', 'One payment for the whole season.'],
          ] as const
        ).map(([type, title, hint]) => (
          <button
            key={type}
            type="button"
            role="radio"
            aria-checked={value.billing_type === type}
            onClick={() =>
              onChange({
                ...value,
                billing_type: type,
                // Monthly is always charged to the card; seasonal can be either.
                collect_method: type === 'monthly' ? 'card' : value.collect_method,
              })
            }
            className={cn(
              'rounded-lg border p-3 text-left transition-colors',
              value.billing_type === type ? 'border-primary/60 bg-primary/10' : 'border-border hover:bg-accent',
            )}
          >
            <span className="block text-sm font-medium text-foreground">{title}</span>
            <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
          </button>
        ))}
      </div>

      <div className={cn('mt-4 grid grid-cols-1 gap-3', monthly ? 'sm:grid-cols-3' : 'sm:grid-cols-2')}>
        <Field id="initial_price" label="Initial price" required help="The list price, shown for the discount.">
          <MoneyInput id="initial_price" value={value.initial_price} onChange={(v) => set('initial_price', v)} />
        </Field>
        <Field
          id="discounted_price"
          label="Discounted price"
          required
          help={monthly ? 'What they actually pay for the first visit.' : 'What they pay for the season.'}
        >
          <MoneyInput id="discounted_price" value={value.discounted_price} onChange={(v) => set('discounted_price', v)} />
        </Field>
        {monthly ? (
          <Field id="recurring_price" label="Recurring price" required help="Every month after the first visit.">
            <MoneyInput
              id="recurring_price"
              value={value.recurring_price}
              onChange={(v) => set('recurring_price', v)}
              onBlur={checkFloor}
            />
          </Field>
        ) : null}
      </div>

      {!monthly ? (
        <div className="mt-3 max-w-xs">
          <Field id="collect_method" label="Payment method" required>
            <Select value={value.collect_method} onValueChange={(v) => set('collect_method', v as CollectMethod)}>
              <SelectTrigger id="collect_method">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="card">Card</SelectItem>
                <SelectItem value="cash">Cash (collected now)</SelectItem>
                <SelectItem value="cheque">Cheque (collected now)</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      ) : null}

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id="season_start" label="Season starts">
          <Input id="season_start" type="date" value={value.season_start} onChange={(e) => set('season_start', e.target.value)} />
        </Field>
        <Field id="season_end" label="Season ends">
          <Input id="season_end" type="date" value={value.season_end} onChange={(e) => set('season_end', e.target.value)} />
        </Field>
      </div>

      <div className="mt-6 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field id="initial_notes" label="Initial job notes" help="For the first visit only.">
          <Textarea id="initial_notes" rows={4} value={value.initial_notes} onChange={(e) => set('initial_notes', e.target.value)} />
        </Field>
        <Field id="permanent_notes" label="Permanent job notes" help="Shown to the crew and managers on every visit: gate codes, where to pile snow.">
          <Textarea id="permanent_notes" rows={4} value={value.permanent_notes} onChange={(e) => set('permanent_notes', e.target.value)} />
        </Field>
      </div>

      {problem ? <div className="mt-4"><ErrorNotice message={problem} /></div> : null}
      {error ? <div className="mt-4"><ErrorNotice message={error} /></div> : null}
      <div className="mt-5 flex justify-between gap-2">
        <Button type="button" variant="secondary" onClick={onBack} disabled={pending}>
          Back
        </Button>
        <Button type="button" onClick={submit} disabled={pending}>
          {pending ? 'Writing agreement…' : 'Next: sign & pay'}
        </Button>
      </div>

      <Dialog open={floorWarning} onOpenChange={setFloorWarning}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Check the recurring price</DialogTitle>
            <DialogDescription>
              This value should be above {money(RECURRING_FLOOR)}. You can still go ahead with {money(recurring ?? 0)} if
              that is the deal.
            </DialogDescription>
          </DialogHeader>
          <div className="flex justify-end gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                warnedFor.current = null;
                setFloorWarning(false);
                document.getElementById('recurring_price')?.focus();
              }}
            >
              Change it
            </Button>
            <Button type="button" onClick={() => setFloorWarning(false)}>
              Keep {money(recurring ?? 0)}
            </Button>
          </div>
        </DialogContent>
      </Dialog>
    </Section>
  );
}

function stringParam(name: string): string | null {
  return new URLSearchParams(window.location.search).get(name);
}

function numberParam(name: string): number | null {
  const raw = new URLSearchParams(window.location.search).get(name);
  const n = raw === null ? NaN : Number(raw);
  return Number.isFinite(n) ? n : null;
}

// --- Page three -------------------------------------------------------------

function FinishStep({ deal, collect }: { deal: Deal; collect: CollectMethod }): JSX.Element {
  const [mode, setMode] = React.useState<'choose' | 'in_person' | 'emailed'>('choose');
  const [contract, setContract] = React.useState<Contract | null>(null);
  const { quote, customer, property } = deal;

  return (
    <>
      <Section title="Agreement" className="mb-4">
        <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
          <Summary label="Customer">{customer.first_name} {customer.last_name}</Summary>
          <Summary label="Address">
            {property.address_line1}
            {property.address_line2 ? `, Unit ${property.address_line2}` : ''}, {property.city}
          </Summary>
          <Summary label="Billing">{quote.billing_type === 'monthly' ? 'Monthly' : 'Seasonal'}</Summary>
          <Summary label="Price">
            <span className="text-muted-foreground line-through">{money(quote.initial_price)}</span>{' '}
            {money(quote.discounted_price)}
            {quote.recurring_price ? ` then ${money(quote.recurring_price)}/month` : ' for the season'}
          </Summary>
          <Summary label="Includes">
            {ADDONS.filter((a) => quote[a.key]).map((a) => a.label).join(', ') || 'Driveway clearing'}
          </Summary>
          {quote.billing_type === 'seasonal_upfront' ? (
            <Summary label="Paying by">{collect === 'card' ? 'Card' : collect === 'cash' ? 'Cash' : 'Cheque'}</Summary>
          ) : null}
        </dl>
      </Section>

      {contract ? (
        <AfterSigning contract={contract} collect={collect} quote={quote} />
      ) : mode === 'choose' ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <ChoiceCard
            title="Collect signature"
            body="The customer is here. They sign on this screen, then add their card on the payment page."
            action="Sign in person"
            onClick={() => setMode('in_person')}
          />
          <ChoiceCard
            title="Email completion"
            body={`Send ${customer.email ?? 'the customer'} a link to sign the agreement and set up card autopay themselves.`}
            action="Email the agreement"
            disabled={!customer.email}
            onClick={() => setMode('emailed')}
          />
        </div>
      ) : mode === 'in_person' ? (
        <InPersonSigning quote={quote} onSigned={setContract} onCancel={() => setMode('choose')} />
      ) : (
        <EmailCompletion quote={quote} customer={customer} onCancel={() => setMode('choose')} />
      )}
    </>
  );
}

function InPersonSigning({
  quote,
  onSigned,
  onCancel,
}: {
  quote: Quote;
  onSigned: (contract: Contract) => void;
  onCancel: () => void;
}): JSX.Element {
  const { data: requirements, loading, error } = useQuery(
    () => api.get<ChecklistRequirement[]>('/checklist-requirements'),
    [],
  );
  const padRef = React.useRef<SignaturePadHandle>(null);
  const [checked, setChecked] = React.useState<Record<string, boolean>>({});
  const { run, pending, error: submitError } = useSubmit();

  if (loading || !requirements) return error ? <ErrorNotice message={error} /> : <Loading />;
  // The card comes after the signature, on the processor's page, which ticks
  // this box itself once it lands.
  const confirmable = requirements.filter((r) => r.code !== 'card_on_file');

  const sign = (): void => {
    run(async () => {
      const drawn = await padRef.current?.toBlob();
      if (!drawn) {
        throw new api.ApiError(400, 'bad_request', 'The customer needs to sign first', []);
      }
      const key = await uploadBlob('signature', drawn, `signature-${quote.id}.png`);
      const contract = await api.post<Contract>('/contracts', {
        quote_id: quote.id,
        signature_image_url: key,
        terms_version: CURRENT_TERMS_VERSION,
        checklist: confirmable.map((r) => ({ item_code: r.code, checked: checked[r.code] ?? false })),
      });
      onSigned(contract);
    });
  };

  return (
    <Section title="Collect signature">
      <div className="mb-4 flex flex-col gap-2">
        {confirmable.map((r) => (
          <label key={r.code} className="flex items-center gap-2 text-sm">
            <Checkbox
              checked={checked[r.code] ?? false}
              onCheckedChange={(v) => setChecked((c) => ({ ...c, [r.code]: v === true }))}
            />
            {r.label}
            {r.is_required ? <span className="text-xs text-muted-foreground">required</span> : null}
          </label>
        ))}
      </div>
      <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        Customer signature
      </p>
      <SignaturePad ref={padRef} />
      {submitError ? <ErrorNotice message={submitError} /> : null}
      <div className="mt-3 flex justify-between gap-2">
        <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
          Back
        </Button>
        <Button type="button" onClick={sign} disabled={pending}>
          {pending ? 'Saving…' : 'Accept & sign'}
        </Button>
      </div>
    </Section>
  );
}

/** Once it is signed: take the money, whichever way it is coming. */
function AfterSigning({
  contract,
  collect,
  quote,
}: {
  contract: Contract;
  collect: CollectMethod;
  quote: Quote;
}): JSX.Element {
  const config = usePublicConfig();
  const [cardUrl, setCardUrl] = React.useState<string | null>(null);
  const [sentTo, setSentTo] = React.useState<string | null>(null);
  const [settled, setSettled] = React.useState(false);
  const { run, pending, error } = useSubmit();

  const takesCard = quote.billing_type === 'monthly' || collect === 'card';

  return (
    <Section title="Signed">
      <p className="mb-4 text-sm text-foreground">
        The agreement is signed.{' '}
        <Link className="text-primary hover:underline" to={`/contracts/${contract.id}`}>
          Open the contract
        </Link>
      </p>

      {!takesCard ? (
        settled ? (
          <p className="text-sm text-good">{collect === 'cash' ? 'Cash' : 'Cheque'} recorded — the season is paid.</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted-foreground">
              Record the {collect} you have collected. The customer is emailed their paid invoice.
            </p>
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  await api.post(`/sales/contracts/${contract.id}/collected-payment`, { method: collect });
                  setSettled(true);
                })
              }
            >
              {pending ? 'Recording…' : `Record ${collect} payment`}
            </Button>
          </>
        )
      ) : config && !config.card_capture ? (
        <p className="text-sm text-muted-foreground">
          Card payments are not connected yet, so the office will follow up for the card. (Connect Stripe to take
          cards here.)
        </p>
      ) : cardUrl ? (
        <div className="flex flex-col gap-2 text-sm">
          <a
            className="inline-flex w-fit items-center rounded-lg bg-primary px-4 py-2 font-medium text-primary-foreground shadow-glow"
            href={cardUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            Open card form on this device
          </a>
          <p className="text-muted-foreground">
            Hand them the phone, or they can use the link we {sentTo ? `sent to ${sentTo}` : 'sent them'}. The card is
            typed on the payment provider's page, never here.
          </p>
        </div>
      ) : (
        <>
          <p className="mb-3 text-sm text-muted-foreground">
            Next, the card for autopay. It opens the payment provider's secure page.
          </p>
          <Button
            type="button"
            disabled={pending || !config}
            onClick={() =>
              run(async () => {
                const result = await api.post<{ url: string; sent_to: string | null }>('/card-setups', {
                  contract_id: contract.id,
                });
                setCardUrl(result.url);
                setSentTo(result.sent_to);
              })
            }
          >
            {pending ? 'Opening…' : 'Add card (Stripe)'}
          </Button>
        </>
      )}

      {error ? <div className="mt-3"><ErrorNotice message={error} /></div> : null}
      <div className="mt-6 flex gap-2">
        <Button asChild variant="secondary">
          <Link to="/customers/new">Add another customer</Link>
        </Button>
      </div>
    </Section>
  );
}

function EmailCompletion({
  quote,
  customer,
  onCancel,
}: {
  quote: Quote;
  customer: Customer;
  onCancel: () => void;
}): JSX.Element {
  const [sent, setSent] = React.useState<{ url: string; sent_to: string } | null>(null);
  const [copied, setCopied] = React.useState(false);
  const { run, pending, error } = useSubmit();

  return (
    <Section title="Email completion">
      {sent ? (
        <div className="text-sm">
          <p className="text-foreground">
            Sent to <strong>{sent.sent_to}</strong>. They sign the agreement and add their card for autopay from the
            link. It works for 14 days and stops working once used.
          </p>
          <p className="mt-2 text-muted-foreground">
            The customer shows as active once they sign.
          </p>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button
              type="button"
              variant="secondary"
              onClick={() => {
                void navigator.clipboard?.writeText(sent.url).then(() => setCopied(true));
              }}
            >
              {copied ? 'Link copied' : 'Copy link to text it'}
            </Button>
            <Button asChild variant="secondary">
              <Link to={`/quotes/${quote.id}`}>Open the quote</Link>
            </Button>
            <Button asChild variant="secondary">
              <Link to="/customers/new">Add another customer</Link>
            </Button>
          </div>
        </div>
      ) : (
        <>
          <p className="mb-4 text-sm text-muted-foreground">
            {customer.first_name} gets an email at <strong className="text-foreground">{customer.email}</strong> with a
            link to read and sign the service agreement, then set up card autopay on the payment provider's page.
          </p>
          {error ? <ErrorNotice message={error} /> : null}
          <div className="flex justify-between gap-2">
            <Button type="button" variant="secondary" onClick={onCancel} disabled={pending}>
              Back
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() =>
                run(async () => {
                  setSent(await api.post(`/sales/quotes/${quote.id}/signing-request`));
                })
              }
            >
              {pending ? 'Sending…' : 'Send agreement'}
            </Button>
          </div>
        </>
      )}
    </Section>
  );
}

// --- Small pieces -------------------------------------------------------------

function Field({
  id,
  label,
  required,
  help,
  children,
}: {
  id: string;
  label: string;
  required?: boolean;
  help?: string;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id}>
        {label}
        {required ? <span className="text-critical"> *</span> : null}
      </Label>
      {children}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  );
}

function MoneyInput({
  id,
  value,
  onChange,
  onBlur,
}: {
  id: string;
  value: string;
  onChange: (v: string) => void;
  onBlur?: () => void;
}): JSX.Element {
  return (
    <div className="relative">
      <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
        $
      </span>
      <Input
        id={id}
        inputMode="decimal"
        className="pl-7"
        value={value}
        placeholder="0.00"
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlur}
      />
    </div>
  );
}

function Summary({ label, children }: { label: string; children: React.ReactNode }): JSX.Element {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-foreground">{children}</dd>
    </div>
  );
}

function ChoiceCard({
  title,
  body,
  action,
  disabled,
  onClick,
}: {
  title: string;
  body: string;
  action: string;
  disabled?: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <div className="glass-card flex flex-col rounded-xl border border-border bg-card/60 p-5 backdrop-blur-xl">
      <h3 className="text-base font-semibold text-foreground">{title}</h3>
      <p className="mb-4 mt-1 flex-1 text-sm text-muted-foreground">{body}</p>
      <Button type="button" onClick={onClick} disabled={disabled}>
        {action}
      </Button>
    </div>
  );
}
