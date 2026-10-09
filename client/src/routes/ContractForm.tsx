import * as React from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import type { PublicUser } from '../../../src/types/models';
import {
  computePricing,
  DEFAULT_TRIGGER_CM,
  defaultSeason,
  formatMoney,
  PricingError,
  toCents,
  type Pricing,
} from '../../../src/types/serviceAgreement';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import {
  addressOf,
  type AgreementForm,
  type AgreementFormValues,
  type CustomerSummary,
  type Lookups,
} from '@/lib/agreements';
import * as api from '@/lib/api';
import { isoDate } from '@/lib/format';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';
import { cn } from '@/lib/utils';

/**
 * Create or edit a contract: the service agreement's form. Every choice comes
 * from the lookup tables; the money is worked out live with the same module
 * the server bills from, so what the rep sees here is what prints.
 *
 *   /customers/:id/contracts/new   a new one
 *   /agreements/:quoteId/edit      one not signed yet
 */
export function ContractForm(): JSX.Element {
  const { id: customerParam, quoteId } = useParams();
  const { data, loading, error } = useQuery(async () => {
    const existing = quoteId ? await api.get<AgreementForm>(`/agreements/${quoteId}`) : null;
    const customerId = existing?.customer_id ?? customerParam ?? '';
    const summary = await api.get<CustomerSummary>(`/customers/${customerId}/summary`);
    const [lookups, operators] = await Promise.all([
      api.get<Lookups>('/lookups', { branch_id: summary.branch.id }),
      api.get<PublicUser[]>('/operators', { branch_id: summary.branch.id }).catch(() => [] as PublicUser[]),
    ]);
    return { existing, summary, lookups, operators };
  }, [customerParam, quoteId]);

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;
  if (data.existing?.contract_id) {
    return (
      <>
        <PageHeader title="Contract already signed" />
        <p className="text-sm text-muted-foreground">
          This agreement has been signed, so it can no longer be changed.{' '}
          <Link className="text-primary hover:underline" to={`/contracts/${data.existing.contract_id}`}>
            Open the contract
          </Link>
          .
        </p>
      </>
    );
  }
  if (data.summary.properties.length === 0) {
    return (
      <>
        <PageHeader title="Create contract" />
        <p className="text-sm text-muted-foreground">
          This customer has no service address yet.{' '}
          <Link className="text-primary hover:underline" to={`/customers/${data.summary.customer.id}#addresses`}>
            Add one on their page
          </Link>{' '}
          first.
        </p>
      </>
    );
  }
  return <Form {...data} />;
}

function startingValues(summary: CustomerSummary, lookups: Lookups): AgreementFormValues {
  const property = summary.properties.find((p) => p.id === summary.service_property_id) ?? summary.properties[0]!;
  const tax =
    lookups.tax_codes.find((t) => t.province === summary.branch.province && t.is_default) ??
    lookups.tax_codes.find((t) => t.province === summary.branch.province) ??
    lookups.tax_codes[0];
  const plan = lookups.billing_plans.find((p) => p.kind === 'seasonal_installments') ?? lookups.billing_plans[0];
  return {
    property_id: property.id,
    contract_type_id: lookups.contract_types[0]?.id ?? '',
    billing_plan_id: plan?.id ?? '',
    package: 'basic',
    trigger_cm: DEFAULT_TRIGGER_CM,
    ...defaultSeason(isoDate()),
    assigned_operator_id: null,
    service_route_id: null,
    scope_item_ids: lookups.scope_items.filter((s) => s.code === 'driveway').map((s) => s.id),
    addons: [],
    tag_ids: [],
    normal_price: '',
    discount: '0',
    referral_credit: null,
    referred_by_customer_id: null,
    tax_code_id: tax?.id ?? '',
    route_code: null,
    driveway_car_lengths: property.driveway_size_cars,
    driveway_width: null,
    property_notes: property.access_notes,
    auto_renew: true,
  };
}

function Form({
  existing,
  summary,
  lookups,
  operators,
}: {
  existing: AgreementForm | null;
  summary: CustomerSummary;
  lookups: Lookups;
  operators: PublicUser[];
}): JSX.Element {
  const navigate = useNavigate();
  const [values, setValues] = React.useState<AgreementFormValues>(() => existing ?? startingValues(summary, lookups));
  const set = <K extends keyof AgreementFormValues>(key: K, value: AgreementFormValues[K]) =>
    setValues((v) => ({ ...v, [key]: value }));
  const { run, pending, error } = useSubmit();

  const plan = lookups.billing_plans.find((p) => p.id === values.billing_plan_id);
  const contractType = lookups.contract_types.find((t) => t.id === values.contract_type_id);
  const tax = lookups.tax_codes.find((t) => t.id === values.tax_code_id);
  const tagOf = (kind: string) => lookups.contract_tags.find((t) => t.kind === kind);
  const yiaTag = tagOf('yia');
  const referralTag = tagOf('referral');
  const isReferral = !!referralTag && values.tag_ids.includes(referralTag.id);
  const perUnit = plan?.kind.startsWith('seasonal') ? 'per season' : 'per month';

  // YIA and the pay-in-full plan are one fact: ticking one sets the other.
  const choosePlan = (planId: string): void => {
    const chosen = lookups.billing_plans.find((p) => p.id === planId);
    setValues((v) => {
      const tags = v.tag_ids.filter((id) => id !== yiaTag?.id);
      return { ...v, billing_plan_id: planId, tag_ids: chosen?.kind === 'seasonal_yia' && yiaTag ? [...tags, yiaTag.id] : tags };
    });
  };
  const toggleTag = (tagId: string, on: boolean): void => {
    if (tagId === yiaTag?.id) {
      const target = lookups.billing_plans.find((p) => p.kind === (on ? 'seasonal_yia' : 'seasonal_installments'));
      if (target) return choosePlan(target.id);
    }
    setValues((v) => ({
      ...v,
      tag_ids: on ? [...v.tag_ids, tagId] : v.tag_ids.filter((id) => id !== tagId),
      ...(tagId === referralTag?.id
        ? on
          ? { referral_credit: v.referral_credit ?? '10.00' }
          : { referral_credit: null, referred_by_customer_id: null }
        : {}),
    }));
  };

  let pricing: Pricing | null = null;
  let pricingProblem: string | null = null;
  const normal = toCents(values.normal_price);
  if (plan && contractType && tax && normal !== null && normal > 0) {
    try {
      pricing = computePricing({
        plan_kind: plan.kind,
        installments_per_season: plan.installments_per_season,
        seasons: plan.kind.startsWith('seasonal') ? contractType.seasons : 1,
        normal_price: normal,
        discount: toCents(values.discount || '0') ?? 0,
        addons: values.addons.map((a) => ({ label: a.addon_service_id, price: toCents(a.price) ?? 0 })),
        tax_rate: tax.rate,
      });
    } catch (err) {
      pricingProblem = err instanceof PricingError ? err.message : String(err);
    }
  }

  const save = () =>
    run(async () => {
      const saved = existing
        ? await api.put<AgreementForm>(`/agreements/${existing.quote_id}`, values)
        : await api.post<AgreementForm>(`/customers/${summary.customer.id}/agreements`, values);
      navigate(`/agreements/${saved.quote_id}`);
    });

  const field = 'flex flex-col gap-1.5';
  const grid = 'grid gap-4 sm:grid-cols-2 lg:grid-cols-3';

  return (
    <>
      <PageHeader
        title={existing ? 'Edit contract' : 'Create contract'}
        subtitle={`${summary.customer.first_name} ${summary.customer.last_name} · ${summary.branch.name} branch`}
        actions={
          <Button asChild variant="secondary">
            <Link to={`/customers/${summary.customer.id}`}>Back to customer</Link>
          </Button>
        }
      />

      <div className="flex flex-col gap-4">
        <Section title="Service Information">
          <div className={grid}>
            <div className={cn(field, 'sm:col-span-2 lg:col-span-3')}>
              <Label>Contract Type</Label>
              <Choice
                value={values.contract_type_id}
                onChange={(v) => set('contract_type_id', v)}
                options={lookups.contract_types.map((t) => ({ value: t.id, label: t.label }))}
                ariaLabel="Contract type"
              />
            </div>
            <div className={field}>
              <Label>Service address</Label>
              <Choice
                value={values.property_id}
                onChange={(v) => set('property_id', v)}
                options={summary.properties.map((p) => ({ value: p.id, label: addressOf(p) }))}
                ariaLabel="Service address"
              />
            </div>
            <div className={field}>
              <Label>Billing</Label>
              <Choice
                value={values.billing_plan_id}
                onChange={choosePlan}
                options={lookups.billing_plans.map((p) => ({ value: p.id, label: p.label }))}
                ariaLabel="Billing plan"
              />
            </div>
            <div className={field}>
              <Label>Package</Label>
              <Choice
                value={values.package}
                onChange={(v) => set('package', v as 'basic' | 'premium')}
                options={[
                  { value: 'basic', label: 'Basic (up to 30 services)' },
                  { value: 'premium', label: 'Premium (unlimited)' },
                ]}
                ariaLabel="Package"
              />
            </div>
            <div className={field}>
              <Label htmlFor="trigger">Service Frequency: per snowfall of at least (cm)</Label>
              <Input
                id="trigger"
                type="number"
                min={0}
                max={100}
                step={0.5}
                value={values.trigger_cm}
                onChange={(e) => set('trigger_cm', Number(e.target.value))}
              />
            </div>
            <div className={field}>
              <Label htmlFor="season-start">Season Start</Label>
              <Input id="season-start" type="date" value={values.season_start} onChange={(e) => set('season_start', e.target.value)} />
            </div>
            <div className={field}>
              <Label htmlFor="season-end">Season End</Label>
              <Input id="season-end" type="date" value={values.season_end} onChange={(e) => set('season_end', e.target.value)} />
            </div>
            <div className={field}>
              <Label>Assigned Operator</Label>
              <Choice
                value={values.assigned_operator_id ?? ''}
                onChange={(v) => set('assigned_operator_id', v || null)}
                options={[{ value: '', label: 'Not assigned' }, ...operators.map((o) => ({ value: o.id, label: `${o.first_name} ${o.last_name}` }))]}
                ariaLabel="Assigned operator"
              />
            </div>
            <div className={field}>
              <Label>Route</Label>
              <Choice
                value={values.service_route_id ?? ''}
                onChange={(v) => set('service_route_id', v || null)}
                options={[{ value: '', label: 'No route' }, ...lookups.service_routes.map((r) => ({ value: r.id, label: r.label }))]}
                ariaLabel="Route"
              />
            </div>
          </div>
        </Section>

        <Section title="Scope of Service">
          <div className="grid gap-2 sm:grid-cols-2">
            {lookups.scope_items.map((item) => (
              <label key={item.id} className="flex items-center gap-2 text-sm">
                <Checkbox
                  checked={values.scope_item_ids.includes(item.id)}
                  onCheckedChange={(on) =>
                    set(
                      'scope_item_ids',
                      on === true ? [...values.scope_item_ids, item.id] : values.scope_item_ids.filter((id) => id !== item.id),
                    )
                  }
                />
                {item.label}
              </label>
            ))}
          </div>
        </Section>

        <Section title="Add-On Services">
          <div className="flex flex-col gap-2">
            {lookups.addon_services.map((addon) => {
              const chosen = values.addons.find((a) => a.addon_service_id === addon.id);
              return (
                <div key={addon.id} className="flex flex-wrap items-center gap-3 text-sm">
                  <label className="flex min-w-[220px] items-center gap-2">
                    <Checkbox
                      checked={!!chosen}
                      onCheckedChange={(on) =>
                        set(
                          'addons',
                          on === true
                            ? [...values.addons, { addon_service_id: addon.id, price: addon.default_price ?? '' }]
                            : values.addons.filter((a) => a.addon_service_id !== addon.id),
                        )
                      }
                    />
                    {addon.label}
                  </label>
                  {chosen ? (
                    <Money
                      value={chosen.price}
                      onChange={(price) =>
                        set(
                          'addons',
                          values.addons.map((a) => (a.addon_service_id === addon.id ? { ...a, price } : a)),
                        )
                      }
                      ariaLabel={`${addon.label} price`}
                      suffix={perUnit}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </Section>

        <Section title="Tags">
          <div className="flex flex-col gap-2">
            {lookups.contract_tags.map((tag) => (
              <label key={tag.id} className="flex items-start gap-2 text-sm">
                <Checkbox
                  className="mt-0.5"
                  checked={values.tag_ids.includes(tag.id)}
                  onCheckedChange={(on) => toggleTag(tag.id, on === true)}
                />
                <span>
                  <span className="font-medium">{tag.label}</span>
                  <span className="block text-xs text-muted-foreground">
                    {tag.kind === 'yia'
                      ? 'Year In Advance: paid for the season up front. The agreement shows one payment, and there is no monthly billing.'
                      : tag.kind === 'referral'
                        ? 'Referred by another customer, who gets a monthly referral credit while this customer is on paid service.'
                        : tag.kind === 'route_code'
                          ? 'The route code has been added to the route.'
                          : null}
                  </span>
                </span>
              </label>
            ))}
            {isReferral ? (
              <ReferrerPicker
                branchId={summary.branch.id}
                customerId={summary.customer.id}
                value={values.referred_by_customer_id}
                onChange={(id) => set('referred_by_customer_id', id)}
              />
            ) : null}
          </div>
        </Section>

        <Section title="Pricing Information">
          <div className={grid}>
            <div className={field}>
              <Label>Normal Price ({perUnit})</Label>
              <Money value={values.normal_price} onChange={(v) => set('normal_price', v)} ariaLabel="Normal price" />
            </div>
            <div className={field}>
              <Label>Discount</Label>
              <Money value={values.discount} onChange={(v) => set('discount', v)} ariaLabel="Discount" />
            </div>
            <ReadOnly label="First Payment" value={pricing ? formatMoney(pricing.first_payment) : '—'} hint={pricing ? `${formatMoney(pricing.first_payment_total)} with tax` : undefined} />
            <ReadOnly
              label="Recurring Monthly Price"
              value={pricing ? (pricing.recurring_payment ? formatMoney(pricing.recurring_payment) : 'None') : '—'}
              hint={
                pricing?.recurring_payment
                  ? `${formatMoney(pricing.recurring_total)} with tax`
                  : plan?.kind === 'seasonal_yia'
                    ? 'Paid in full: no monthly billing'
                    : undefined
              }
            />
            {isReferral ? (
              <div className={field}>
                <Label>Referral Credit (per month, to the referrer)</Label>
                <Money
                  value={values.referral_credit ?? ''}
                  onChange={(v) => set('referral_credit', v || null)}
                  ariaLabel="Referral credit"
                />
              </div>
            ) : null}
            <ReadOnly label={`Add-ons (${perUnit})`} value={pricing ? formatMoney(pricing.addons_total) : '—'} />
          </div>
          {pricing ? (
            <dl className="mt-4 grid gap-x-6 gap-y-1 rounded-xl border border-border bg-card/40 p-4 text-sm sm:grid-cols-2">
              <Total label={`Net price (${perUnit})`} value={formatMoney(pricing.net)} />
              <Total
                label="Payments"
                value={
                  pricing.payments_count === null
                    ? 'Monthly until cancelled'
                    : `${pricing.payments_count} payment${pricing.payments_count === 1 ? '' : 's'}`
                }
              />
              <Total label={`Tax (${tax?.label ?? ''})`} value={formatMoney(pricing.commitment_tax)} />
              <Total
                label={pricing.payments_count === null ? 'Total incl. tax, per month' : 'Total incl. tax'}
                value={formatMoney(pricing.commitment_total)}
                strong
              />
              {plan && plan.early_termination_fee !== '0.00' ? (
                <Total label="Early termination fee (plus tax)" value={formatMoney(toCents(plan.early_termination_fee) ?? 0)} />
              ) : null}
            </dl>
          ) : pricingProblem ? (
            <p className="mt-3 text-sm text-critical">{pricingProblem}</p>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Enter the normal price to see the payments.</p>
          )}
        </Section>

        <Section title="Additional Information">
          <div className={grid}>
            <div className={field}>
              <Label>Tax Code</Label>
              <Choice
                value={values.tax_code_id}
                onChange={(v) => set('tax_code_id', v)}
                options={lookups.tax_codes.map((t) => ({ value: t.id, label: t.label }))}
                ariaLabel="Tax code"
              />
            </div>
            <div className={field}>
              <Label htmlFor="route-code">Route Code</Label>
              <Input
                id="route-code"
                value={values.route_code ?? ''}
                maxLength={60}
                onChange={(e) => set('route_code', e.target.value || null)}
              />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className={field}>
                <Label>Driveway (car lengths)</Label>
                <Choice
                  value={values.driveway_car_lengths ? String(values.driveway_car_lengths) : ''}
                  onChange={(v) => set('driveway_car_lengths', v ? Number(v) : null)}
                  options={[{ value: '', label: '—' }, ...Array.from({ length: 10 }, (_, i) => ({ value: String(i + 1), label: String(i + 1) }))]}
                  ariaLabel="Driveway car lengths"
                />
              </div>
              <div className={field}>
                <Label>Width</Label>
                <Choice
                  value={values.driveway_width ?? ''}
                  onChange={(v) => set('driveway_width', (v || null) as AgreementFormValues['driveway_width'])}
                  options={[
                    { value: '', label: '—' },
                    { value: 'single', label: 'Single' },
                    { value: 'double', label: 'Double' },
                    { value: 'triple', label: 'Triple' },
                  ]}
                  ariaLabel="Driveway width"
                />
              </div>
            </div>
            <div className={cn(field, 'sm:col-span-2 lg:col-span-3')}>
              <Label htmlFor="property-notes">Property notes (obstacles, where to pile snow)</Label>
              <Textarea
                id="property-notes"
                rows={3}
                maxLength={2000}
                value={values.property_notes ?? ''}
                onChange={(e) => set('property_notes', e.target.value || null)}
              />
              <p className="text-xs text-muted-foreground">Saved as the address's notes for the crew, shown on dispatch.</p>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <Checkbox checked={values.auto_renew} onCheckedChange={(on) => set('auto_renew', on === true)} />
              Auto-Renew
            </label>
          </div>
        </Section>

        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex flex-wrap justify-end gap-2 pb-6">
          <Button asChild variant="secondary">
            <Link to={`/customers/${summary.customer.id}`}>Cancel</Link>
          </Button>
          <Button type="button" disabled={pending || !pricing} onClick={save}>
            {pending ? 'Saving…' : contractType?.agreement_medium === 'paper' ? 'Save and print agreement' : 'Save and review agreement'}
          </Button>
        </div>
      </div>
    </>
  );
}

function Choice({
  value,
  onChange,
  options,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
  ariaLabel: string;
}): JSX.Element {
  // Radix Select cannot hold an empty value, so "none" stands in for it.
  const NONE = '__none__';
  return (
    <Select value={value === '' ? NONE : value} onValueChange={(v) => onChange(v === NONE ? '' : v)}>
      <SelectTrigger aria-label={ariaLabel}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.value || NONE} value={o.value || NONE}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Money({
  value,
  onChange,
  ariaLabel,
  suffix,
}: {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  suffix?: string;
}): JSX.Element {
  return (
    <div className="flex items-center gap-2">
      <div className="relative">
        <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
        <Input
          inputMode="decimal"
          className="w-36 pl-6"
          value={value}
          aria-label={ariaLabel}
          onChange={(e) => onChange(e.target.value.replace(/[^\d.]/g, ''))}
          placeholder="0.00"
        />
      </div>
      {suffix ? <span className="text-xs text-muted-foreground">{suffix}</span> : null}
    </div>
  );
}

function ReadOnly({ label, value, hint }: { label: string; value: string; hint?: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex h-9 items-center rounded-lg border border-dashed border-input bg-muted/40 px-3 text-sm tabular-nums" aria-readonly="true">
        {value}
      </div>
      {hint ? <span className="text-xs text-muted-foreground">{hint}</span> : null}
    </div>
  );
}

function Total({ label, value, strong }: { label: string; value: string; strong?: boolean }): JSX.Element {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className={cn('tabular-nums', strong && 'font-semibold')}>{value}</dd>
    </div>
  );
}

/** Finds the customer who made the referral, by name, in the same branch. */
function ReferrerPicker({
  branchId,
  customerId,
  value,
  onChange,
}: {
  branchId: string;
  customerId: string;
  value: string | null;
  onChange: (id: string | null) => void;
}): JSX.Element {
  const [search, setSearch] = React.useState('');
  const results = useQuery(
    () =>
      search.trim().length >= 2
        ? api.list<{ id: string; first_name: string; last_name: string; email: string | null }>('/customers', {
            search: search.trim(),
            branch_id: branchId,
            page_size: 8,
          })
        : Promise.resolve(null),
    [search, branchId],
  );
  const chosen = useQuery(
    () =>
      value ? api.get<{ id: string; first_name: string; last_name: string }>(`/customers/${value}`) : Promise.resolve(null),
    [value],
  );

  return (
    <div className="ml-6 flex flex-col gap-2 rounded-xl border border-border bg-card/40 p-3">
      <Label htmlFor="referrer">Referred by</Label>
      {chosen.data ? (
        <div className="flex items-center gap-2 text-sm">
          <span className="font-medium">
            {chosen.data.first_name} {chosen.data.last_name}
          </span>
          <Button type="button" variant="ghost" size="sm" onClick={() => onChange(null)}>
            Change
          </Button>
        </div>
      ) : (
        <>
          <Input
            id="referrer"
            placeholder="Search customers by name, email or phone"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <ul className="flex flex-col">
            {(results.data?.data ?? [])
              .filter((c) => c.id !== customerId)
              .map((c) => (
                <li key={c.id}>
                  <button
                    type="button"
                    className="w-full rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => onChange(c.id)}
                  >
                    {c.first_name} {c.last_name}
                    {c.email ? <span className="text-muted-foreground"> · {c.email}</span> : null}
                  </button>
                </li>
              ))}
          </ul>
        </>
      )}
    </div>
  );
}
