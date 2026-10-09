import type { Knex } from 'knex';
import type { BillingPlan, ContractType } from '../types/models';
import {
  computePricing,
  DEFAULT_TRIGGER_CM,
  toCents,
  type Pricing,
  type ScheduleTerms,
} from '../types/serviceAgreement';

/**
 * A service agreement's money and schedule, read back from the quote it was
 * written on. Billing and the agreement document both start here, so they
 * read the same numbers the same way.
 *
 * A quote from the older PDF sign-up has no billing plan, and gets null.
 */

export interface QuoteAddon {
  id: string;
  code: string;
  label: string;
  /** Cents. */
  price: number;
}

export interface QuoteTerms {
  quote_id: string;
  plan: BillingPlan;
  contract_type: ContractType;
  addons: QuoteAddon[];
  pricing: Pricing;
  /** Everything paymentSchedule needs except the day it was signed. */
  schedule: Omit<ScheduleTerms, 'signed_on'>;
  tax_rate: string;
  trigger_cm: number;
  early_termination_fee: number;
  referral_credit: number;
  referred_by_customer_id: string | null;
}

interface QuoteRow {
  id: string;
  billing_plan_id: string | null;
  contract_type_id: string | null;
  initial_price: string;
  discount: string;
  tax_rate: string | null;
  season_start: string;
  season_end: string;
  auto_renew: boolean;
  trigger_cm: string | null;
  early_termination_fee: string | null;
  referral_credit: string | null;
  referred_by_customer_id: string | null;
}

export async function loadQuoteTerms(quoteId: string, db: Knex): Promise<QuoteTerms | null> {
  const quote = (await db('quotes').where({ id: quoteId }).first()) as QuoteRow | undefined;
  if (!quote?.billing_plan_id || !quote.contract_type_id) return null;

  const [plan, contractType, addons] = await Promise.all([
    db('billing_plans').where({ id: quote.billing_plan_id }).first() as Promise<BillingPlan>,
    db('contract_types').where({ id: quote.contract_type_id }).first() as Promise<ContractType>,
    db('quote_addons')
      .join('addon_services', 'addon_services.id', 'quote_addons.addon_service_id')
      .where('quote_addons.quote_id', quoteId)
      .orderBy('addon_services.sort_order')
      .select('addon_services.id', 'addon_services.code', 'addon_services.label', 'quote_addons.price') as Promise<
      { id: string; code: string; label: string; price: string }[]
    >,
  ]);

  const quoteAddons = addons.map((a) => ({ ...a, price: toCents(a.price) ?? 0 }));
  const addonsTotal = quoteAddons.reduce((sum, a) => sum + a.price, 0);
  const taxRate = quote.tax_rate ?? '0';
  const seasons = plan.kind.startsWith('seasonal') ? contractType.seasons : 1;

  // initial_price holds the list price with the add-ons in it (the quote's
  // "price before discount"); the agreement shows the two separately.
  const pricing = computePricing({
    plan_kind: plan.kind,
    installments_per_season: plan.installments_per_season,
    seasons,
    normal_price: (toCents(quote.initial_price) ?? 0) - addonsTotal,
    discount: toCents(quote.discount) ?? 0,
    addons: quoteAddons.map((a) => ({ label: a.label, price: a.price })),
    tax_rate: taxRate,
  });

  return {
    quote_id: quoteId,
    plan,
    contract_type: contractType,
    addons: quoteAddons,
    pricing,
    schedule: {
      plan_kind: plan.kind,
      installments_per_season: plan.installments_per_season,
      seasons,
      season_start: quote.season_start,
      season_end: quote.season_end,
      auto_renew: quote.auto_renew,
    },
    tax_rate: taxRate,
    trigger_cm: quote.trigger_cm === null ? DEFAULT_TRIGGER_CM : Number(quote.trigger_cm),
    early_termination_fee: toCents(quote.early_termination_fee ?? plan.early_termination_fee) ?? 0,
    referral_credit: toCents(quote.referral_credit) ?? 0,
    referred_by_customer_id: quote.referred_by_customer_id,
  };
}

/** The calendar date in a time zone, as YYYY-MM-DD: when a contract was signed, locally. */
export function localDate(when: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(when);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}
