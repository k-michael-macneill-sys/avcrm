import { Readable } from 'node:stream';
import type { Knex } from 'knex';
import type { Contract, Customer, Property } from '../types/models';
import {
  agreementDateLabel,
  agreementWording,
  formatMoney,
  formatRate,
  longDate,
  paymentSchedule,
  PROVINCE_NAMES,
  SIGNATURE_BOXES,
  termsAndConditions,
  type AgreementModel,
  type SignatureBox,
} from '../types/serviceAgreement';
import { notFound } from '../utils/errors';
import { loadQuoteTerms, localDate } from './agreementTerms';
import { renderServiceAgreement } from './pdf/serviceAgreement';
import { keyFor, ruleFor, storage } from './storage';

/**
 * The service agreement as a document: every word and number it prints,
 * gathered from the quote, the customer, the branch and — once signed — the
 * contract. The signing screen draws this; the PDF renderer prints it.
 *
 * Callers check branch scope before asking; this reads by id.
 */

/** Bumped when the agreement's wording changes; every contract records the one it was signed on. */
export const SERVICE_AGREEMENT_TERMS_VERSION = 'SA-2026-10-09';

interface Context {
  quote: {
    id: string;
    package: string | null;
    season_start: string;
    season_end: string;
    created_by_user_id: string | null;
    tax_code_id: string;
    route_code: string | null;
    service_route_id: string | null;
    driveway_car_lengths: number | null;
    driveway_width: string | null;
  };
  customer: Customer;
  property: Property;
  branch: { name: string; province: string; timezone: string };
  contract: Contract | null;
}

async function contextFor(quoteId: string, db: Knex): Promise<Context> {
  const quote = (await db('quotes').where({ id: quoteId }).first()) as Context['quote'] & { property_id: string };
  if (!quote) throw notFound('Agreement not found');
  const property = (await db('properties').where({ id: quote.property_id }).first()) as Property;
  const customer = (await db('customers').where({ id: property.customer_id }).first()) as Customer;
  const branch = (await db('branches').where({ id: customer.branch_id }).first('name', 'province', 'timezone')) as Context['branch'];
  const contract = ((await db('contracts').where({ quote_id: quoteId }).first()) as Contract | undefined) ?? null;
  return { quote, customer, property, branch, contract };
}

function addressLines(line1: string, line2: string | null, city: string, province: string, postal: string): string[] {
  return [line1, line2, `${city}, ${province} ${postal}`].filter((l): l is string => !!l && l.trim() !== '');
}

export async function buildAgreementModel(quoteId: string, db: Knex): Promise<AgreementModel> {
  const terms = await loadQuoteTerms(quoteId, db);
  if (!terms) throw notFound('That quote is not a service agreement');
  const { quote, customer, property, branch, contract } = await contextFor(quoteId, db);

  const [scopeRows, selectedScope, addonRows, taxCode, rep, primaryPhone, route] = await Promise.all([
    db('scope_items').orderBy('sort_order').select('id', 'label', 'active') as Promise<
      { id: string; label: string; active: boolean }[]
    >,
    db('quote_scope_items').where({ quote_id: quoteId }).pluck('scope_item_id') as Promise<string[]>,
    db('addon_services').orderBy('sort_order').select('id', 'label', 'active', 'default_price') as Promise<
      { id: string; label: string; active: boolean; default_price: string | null }[]
    >,
    db('tax_codes').where({ id: quote.tax_code_id }).first('label', 'rate') as Promise<{ label: string; rate: string }>,
    quote.created_by_user_id
      ? (db('users').where({ id: quote.created_by_user_id }).first('first_name', 'last_name') as Promise<
          { first_name: string; last_name: string } | undefined
        >)
      : Promise.resolve(undefined),
    db('customer_phones').where({ customer_id: customer.id }).orderBy([{ column: 'is_primary', order: 'desc' }, 'sort_order']).first('number') as Promise<
      { number: string } | undefined
    >,
    quote.service_route_id
      ? (db('service_routes').where({ id: quote.service_route_id }).first('label') as Promise<{ label: string } | undefined>)
      : Promise.resolve(undefined),
  ]);

  const selected = new Set(selectedScope);
  const chosenAddons = new Map(terms.addons.map((a) => [a.id, a]));
  const phone = primaryPhone?.number ?? customer.phone;
  const name = `${customer.first_name} ${customer.last_name}`;
  const serviceAddress = addressLines(
    property.address_line1,
    property.address_line2,
    property.city,
    property.province,
    property.postal_code,
  );
  const billingAddress = customer.billing_address_line1
    ? addressLines(
        customer.billing_address_line1,
        customer.billing_address_line2,
        customer.billing_city ?? '',
        customer.billing_province ?? '',
        customer.billing_postal_code ?? '',
      )
    : serviceAddress;

  const signedOn = contract ? localDate(contract.signed_at, branch.timezone) : localDate(new Date(), branch.timezone);
  const { pricing, plan } = terms;
  const schedule = paymentSchedule({ ...terms.schedule, signed_on: signedOn }, pricing);
  const monthly = plan.kind === 'monthly_recurring';
  const unit = pricing.unit === 'season' ? 'per season' : 'per month';
  const none = (cents: number): string => (cents === 0 ? '—' : formatMoney(cents));

  const seasons = terms.schedule.seasons;
  const length = plan.kind.startsWith('seasonal')
    ? { one: seasons === 1, two: seasons === 2, other: seasons > 2, other_label: seasons > 2 ? `${seasons} SEASONS` : null }
    : { one: false, two: false, other: true, other_label: monthly ? 'MONTH-TO-MONTH' : 'ONE MONTH' };

  const driveway = [
    quote.driveway_car_lengths ? `${quote.driveway_car_lengths} car length${quote.driveway_car_lengths === 1 ? '' : 's'}` : null,
    quote.driveway_width,
  ]
    .filter(Boolean)
    .join(', ');
  const serviceSummary = [
    `Package: ${quote.package === 'premium' ? 'Premium' : 'Basic'}`,
    `Service frequency: per snowfall of ${terms.trigger_cm} cm or more`,
    `Season: ${longDate(terms.schedule.season_start)} – ${longDate(terms.schedule.season_end)}`,
    driveway ? `Driveway: ${driveway}` : null,
    route ? `Route: ${route.label}${quote.route_code ? ` (${quote.route_code})` : ''}` : quote.route_code ? `Route code: ${quote.route_code}` : null,
  ]
    .filter(Boolean)
    .join('  ·  ');

  const boxes = Object.fromEntries(
    SIGNATURE_BOXES.map((box) => [box, !!contract?.signature_boxes?.[box]]),
  ) as Record<SignatureBox, boolean>;

  const signedAt = contract
    ? `${contract.signed_at.toLocaleString('en-CA', { timeZone: branch.timezone, dateStyle: 'medium', timeStyle: 'short' })} (${branch.timezone})`
    : null;

  return {
    quote_id: quoteId,
    contract_id: contract?.id ?? null,
    status: contract ? 'signed' : 'draft',
    terms_version: contract?.terms_version ?? SERVICE_AGREEMENT_TERMS_VERSION,
    contract_type: terms.contract_type.label,
    agreement_medium: terms.contract_type.agreement_medium,
    plan_kind: plan.kind,
    plan_label: plan.label,
    package_label: quote.package === 'premium' ? 'Premium' : 'Basic',
    branch_name: branch.name,
    customer: { name, email: customer.email, phone, address: serviceAddress },
    billing: { name, email: customer.email, phone, address: billingAddress },
    scope: scopeRows
      .filter((s) => s.active || selected.has(s.id))
      .map((s) => ({ label: s.label, checked: selected.has(s.id) })),
    service_summary: serviceSummary,
    addons: addonRows
      .filter((a) => a.active || chosenAddons.has(a.id))
      .map((a) => {
        const chosen = chosenAddons.get(a.id);
        const price = chosen ? chosen.price : a.default_price ? Math.round(Number(a.default_price) * 100) : null;
        return { label: a.label, checked: !!chosen, price: price === null ? null : `${formatMoney(price)} ${unit}` };
      }),
    length,
    schedule: schedule.map((e) => ({
      label: e.label,
      due_on: e.due_on,
      amount: formatMoney(e.amount),
      total: formatMoney(e.total),
      season: e.season,
    })),
    paid_in_full: plan.kind === 'seasonal_yia',
    pricing_lines: [
      { label: `Normal Price (${unit})`, value: formatMoney(pricing.normal_price) },
      { label: 'Discount', value: pricing.discount ? `-${formatMoney(pricing.discount)}` : '—' },
      { label: 'Net First Payment', value: formatMoney(pricing.first_payment) },
      { label: 'First Payment incl. Tax', value: formatMoney(pricing.first_payment_total) },
      { label: 'Recurring Monthly Amount', value: none(pricing.recurring_payment) },
      { label: 'Recurring incl. Tax', value: none(pricing.recurring_payment ? pricing.recurring_total : 0) },
      { label: `Add-ons (${unit})`, value: none(pricing.addons_total) },
      {
        label: monthly ? 'Total incl. Tax (per month)' : 'Total incl. Tax',
        value: formatMoney(pricing.commitment_total),
      },
    ],
    tax_label: `${taxCode.label.replace(/^[A-Z]{2} – /, '')}`.trim() || formatRate(taxCode.rate),
    rep_name: rep ? `${rep.first_name} ${rep.last_name}` : null,
    card: contract?.payment_method_last4
      ? { label: `**** **** **** ${contract.payment_method_last4}`, brand: contract.payment_method_brand }
      : { label: 'Added on our payment processor’s secure page', brand: null },
    notification_email: customer.email,
    notification_phone: phone,
    wording: agreementWording({
      plan_kind: plan.kind,
      seasons,
      season_start: terms.schedule.season_start,
      season_end: terms.schedule.season_end,
      trigger_cm: terms.trigger_cm,
      early_termination_fee_cents: terms.early_termination_fee,
      referral_credit_cents: terms.referral_credit,
      auto_renew: terms.schedule.auto_renew,
    }),
    terms: termsAndConditions({
      trigger_cm: terms.trigger_cm,
      province_name: PROVINCE_NAMES[branch.province] ?? branch.province,
      early_termination_fee_cents: terms.early_termination_fee,
    }),
    signer_name: contract?.signer_name ?? name,
    signed_date_label: contract ? agreementDateLabel(signedOn) : null,
    signed_at: signedAt,
    signed_ip: contract?.signed_ip ?? null,
    boxes,
  };
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/** The unsigned agreement, for showing before anyone signs. */
export async function renderAgreementPreview(quoteId: string, db: Knex): Promise<Buffer> {
  return renderServiceAgreement(await buildAgreementModel(quoteId, db));
}

/**
 * Prints the signed agreement, stores it, and points the contract at it.
 * Runs inside the signing transaction, so an electronic contract never
 * exists without its locked PDF.
 */
export async function attachServiceAgreement(
  trx: Knex.Transaction,
  input: { contractId: string; quoteId: string; branchId: string; signatureKey: string },
): Promise<string> {
  const signature = await readAll(storage.read(input.signatureKey));
  const bytes = await renderServiceAgreement(await buildAgreementModel(input.quoteId, trx), { customer: signature });

  const key = keyFor('contract_pdf', 'application/pdf');
  const stored = await storage.put(key, Readable.from(bytes), 'application/pdf', ruleFor('contract_pdf').maxBytes);
  await trx('uploads').insert({
    key,
    purpose: 'contract_pdf',
    content_type: 'application/pdf',
    file_name: 'service-agreement.pdf',
    byte_size: stored.byte_size,
    status: 'stored',
    uploaded_by_user_id: null,
    branch_id: input.branchId,
    stored_at: new Date(),
  });
  await trx('contracts').where({ id: input.contractId }).update({ pdf_url: key });
  return key;
}
