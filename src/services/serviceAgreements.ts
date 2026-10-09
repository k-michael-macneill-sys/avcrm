import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { BillingPlan, ContractTag, ContractType, Quote, TaxCode } from '../types/models';
import {
  centsToDecimal,
  computePricing,
  DEFAULT_REFERRAL_CREDIT_CENTS,
  formatMoney,
  PricingError,
  SIGNATURE_BOXES,
  toCents,
  type AgreementModel,
  type SignatureBox,
} from '../types/serviceAgreement';
import { badRequest, conflict, notFound } from '../utils/errors';
import { applyBranchScope } from '../utils/scope';
import { recordAudit, type AuditActor } from './audit';
import { loadQuoteTerms } from './agreementTerms';
import { buildAgreementModel, renderAgreementPreview, SERVICE_AGREEMENT_TERMS_VERSION } from './agreementDocument';
import { createContract, type ChecklistInput, type ContractWithChecklist } from './contracts';
import { enqueueMessage } from './messages';
import { lock as lockQuote } from './quotes';

/**
 * The contract form, and what becomes of it.
 *
 * The form writes a quote — the money and the choices, frozen once signed —
 * and signing it produces the contract exactly as the door sign-up always
 * has, so every rule the contract, billing and deletion code enforce still
 * holds. What is new is everything around the money: the contract type,
 * billing plan, scope, add-ons and tags, all from the lookup tables, and an
 * agreement generated from them rather than a PDF filled in by hand.
 */

export interface AgreementInput {
  property_id: string;
  contract_type_id: string;
  billing_plan_id: string;
  package: 'basic' | 'premium';
  trigger_cm: number;
  season_start: string;
  season_end: string;
  assigned_operator_id: string | null;
  service_route_id: string | null;
  scope_item_ids: string[];
  addons: { addon_service_id: string; price: string }[];
  tag_ids: string[];
  /** Per season for a seasonal plan, per month for a monthly one. */
  normal_price: string;
  discount: string;
  referral_credit: string | null;
  referred_by_customer_id: string | null;
  tax_code_id: string;
  route_code: string | null;
  driveway_car_lengths: number | null;
  driveway_width: 'single' | 'double' | 'triple' | null;
  property_notes: string | null;
  auto_renew: boolean;
}

/** The form as it was saved, for editing it again. */
export interface AgreementForm extends AgreementInput {
  quote_id: string;
  customer_id: string;
  status: Quote['status'];
  contract_id: string | null;
  created_at: Date;
}

function scopedQuotes(db: Knex, scope: BranchScope) {
  return applyBranchScope(
    db('quotes')
      .join('properties', 'properties.id', 'quotes.property_id')
      .join('customers', 'customers.id', 'properties.customer_id'),
    'customers.branch_id',
    scope,
  );
}

async function scopedCustomer(customerId: string, scope: BranchScope, db: Knex) {
  const customer = (await applyBranchScope(db('customers'), 'customers.branch_id', scope)
    .andWhere('customers.id', customerId)
    .first('customers.id', 'customers.branch_id', 'customers.first_name', 'customers.last_name')) as
    | { id: string; branch_id: string; first_name: string; last_name: string }
    | undefined;
  if (!customer) throw notFound('Customer not found');
  return customer;
}

interface Resolved {
  values: Record<string, unknown>;
  scopeIds: string[];
  addons: { addon_service_id: string; price: string; code: string }[];
  tagIds: string[];
}

/**
 * Checks every choice against the lookup tables and the rules between them,
 * naming every problem at once, and works out the quote's money columns.
 * A retired lookup row is refused unless the quote already had it.
 */
async function resolve(
  input: AgreementInput,
  customer: { id: string; branch_id: string },
  current: Quote | null,
  db: Knex,
): Promise<Resolved> {
  const problems: { path: string; message: string }[] = [];
  const need = (path: string, message: string) => problems.push({ path, message });
  const usable = <T extends { active: boolean; id: string }>(row: T | undefined, currentId: string | null | undefined) =>
    row && (row.active || row.id === currentId) ? row : undefined;

  const [contractType, plan, taxCode, property] = await Promise.all([
    db('contract_types').where({ id: input.contract_type_id }).first() as Promise<ContractType | undefined>,
    db('billing_plans').where({ id: input.billing_plan_id }).first() as Promise<BillingPlan | undefined>,
    db('tax_codes').where({ id: input.tax_code_id }).first() as Promise<TaxCode | undefined>,
    db('properties').where({ id: input.property_id }).first('id', 'customer_id') as Promise<
      { id: string; customer_id: string } | undefined
    >,
  ]);
  const type = usable(contractType, current?.contract_type_id);
  const billing = usable(plan, current?.billing_plan_id);
  const tax = usable(taxCode, current?.tax_code_id);
  if (!type) need('contract_type_id', 'Choose a contract type');
  if (!billing) need('billing_plan_id', 'Choose a billing plan');
  if (!tax) need('tax_code_id', 'Choose a tax code');
  if (!property || property.customer_id !== customer.id) need('property_id', 'Choose one of this customer’s addresses');
  if (input.season_end <= input.season_start) need('season_end', 'The season has to end after it starts');

  const scopeIds = [...new Set(input.scope_item_ids)];
  const known = (await db('scope_items').whereIn('id', scopeIds).pluck('id')) as string[];
  if (known.length !== scopeIds.length) need('scope_item_ids', 'One of the scope items no longer exists');
  if (scopeIds.length === 0) need('scope_item_ids', 'Tick at least one area to clear');

  const addonIds = [...new Set(input.addons.map((a) => a.addon_service_id))];
  const addonRows = (await db('addon_services').whereIn('id', addonIds).select('id', 'code', 'label')) as {
    id: string;
    code: string;
    label: string;
  }[];
  if (addonRows.length !== addonIds.length) need('addons', 'One of the add-ons no longer exists');
  const addons = input.addons
    .filter((a, i, all) => all.findIndex((b) => b.addon_service_id === a.addon_service_id) === i)
    .map((a) => {
      const cents = toCents(a.price);
      const row = addonRows.find((r) => r.id === a.addon_service_id);
      if (cents === null || cents < 0) need('addons', `Enter a price for ${row?.label ?? 'each add-on'}`);
      return { addon_service_id: a.addon_service_id, price: centsToDecimal(cents ?? 0), code: row?.code ?? '' };
    });

  let tagIds = [...new Set(input.tag_ids)];
  const tags = (await db('contract_tags').select('*')) as ContractTag[];
  if (tagIds.some((id) => !tags.find((t) => t.id === id))) need('tag_ids', 'One of the tags no longer exists');
  const tagged = (kind: ContractTag['kind']) => {
    const tag = tags.find((t) => t.kind === kind);
    return tag ? tagIds.includes(tag.id) : false;
  };

  // YIA and a pay-in-full plan are the same fact; the form keeps them in
  // step, and this refuses the two disagreeing.
  if (billing) {
    const yiaTag = tags.find((t) => t.kind === 'yia');
    if (billing.kind === 'seasonal_yia' && yiaTag && !tagIds.includes(yiaTag.id)) tagIds = [...tagIds, yiaTag.id];
    if (billing.kind !== 'seasonal_yia' && tagged('yia')) {
      need('tag_ids', 'YIA means paid in full: choose the YIA billing plan, or untick YIA');
    }
  }

  // The referral credit goes to whoever referred this customer.
  let referredBy: string | null = null;
  let referralCredit: string | null = null;
  if (tagged('referral')) {
    if (!input.referred_by_customer_id) {
      need('referred_by_customer_id', 'Choose the customer who made the referral');
    } else if (input.referred_by_customer_id === customer.id) {
      need('referred_by_customer_id', 'A customer cannot refer themselves');
    } else {
      const referrer = await db('customers')
        .where({ id: input.referred_by_customer_id, branch_id: customer.branch_id })
        .first('id');
      if (!referrer) need('referred_by_customer_id', 'The referring customer must be in the same branch');
      referredBy = input.referred_by_customer_id;
    }
    const credit = input.referral_credit === null ? DEFAULT_REFERRAL_CREDIT_CENTS : toCents(input.referral_credit);
    if (credit === null || credit < 0) need('referral_credit', 'Enter the referral credit per month');
    else referralCredit = centsToDecimal(credit);
  }

  if (input.assigned_operator_id) {
    const operator = await db('users')
      .where({ id: input.assigned_operator_id, branch_id: customer.branch_id, is_active: true })
      .first('id');
    if (!operator) need('assigned_operator_id', 'The operator must be active and in this customer’s branch');
  }
  if (input.service_route_id) {
    const route = (await db('service_routes').where({ id: input.service_route_id }).first()) as
      | { id: string; branch_id: string | null; active: boolean }
      | undefined;
    if (!usable(route, current?.service_route_id) || (route!.branch_id && route!.branch_id !== customer.branch_id)) {
      need('service_route_id', 'Choose one of this branch’s routes');
    }
  }

  const normal = toCents(input.normal_price);
  const discount = toCents(input.discount || '0');
  if (normal === null || normal <= 0) need('normal_price', 'Enter the normal price');
  if (discount === null || discount < 0) need('discount', 'The discount must be an amount, or 0');

  let money: Record<string, unknown> = {};
  if (billing && type && tax && normal !== null && discount !== null && normal > 0) {
    try {
      const pricing = computePricing({
        plan_kind: billing.kind,
        installments_per_season: billing.installments_per_season,
        seasons: billing.kind.startsWith('seasonal') ? type.seasons : 1,
        normal_price: normal,
        discount,
        addons: addons.map((a) => ({ label: a.code, price: toCents(a.price) ?? 0 })),
        tax_rate: tax.rate,
      });
      const billingType = billing.kind === 'seasonal_yia' ? 'seasonal_upfront' : 'monthly';
      money = {
        billing_type: billingType,
        // The quote's list price carries the add-ons; the discount is off the lot.
        initial_price: centsToDecimal(normal + pricing.addons_total),
        discounted_price: centsToDecimal(pricing.net),
        recurring_price:
          billingType === 'monthly' && pricing.recurring_payment > 0 ? centsToDecimal(pricing.recurring_payment) : null,
        discount: centsToDecimal(discount),
        // Frozen now, so a later edit to the tax code or plan cannot change it.
        tax_rate: tax.rate,
        early_termination_fee:
          current?.billing_plan_id === billing.id && current.early_termination_fee !== null
            ? current.early_termination_fee
            : billing.early_termination_fee,
      };
    } catch (err) {
      if (err instanceof PricingError) need('discount', err.message);
      else throw err;
    }
  }

  if (problems.length) {
    throw badRequest(problems.map((p) => p.message).join('. ') + '.', problems);
  }

  return {
    values: {
      property_id: input.property_id,
      contract_type_id: input.contract_type_id,
      billing_plan_id: input.billing_plan_id,
      tax_code_id: input.tax_code_id,
      package: input.package,
      trigger_cm: input.trigger_cm,
      season_start: input.season_start,
      season_end: input.season_end,
      assigned_operator_id: input.assigned_operator_id,
      service_route_id: input.service_route_id,
      route_code: input.route_code,
      referral_credit: referralCredit,
      referred_by_customer_id: referredBy,
      driveway_car_lengths: input.driveway_car_lengths,
      driveway_width: input.driveway_width,
      property_notes: input.property_notes,
      auto_renew: input.auto_renew,
      // Older screens read these.
      addons: addons.map((a) => a.code),
      ...money,
    },
    scopeIds,
    addons,
    tagIds,
  };
}

async function writeChoices(quoteId: string, resolved: Resolved, trx: Knex.Transaction): Promise<void> {
  await trx('quote_scope_items').where({ quote_id: quoteId }).del();
  await trx('quote_addons').where({ quote_id: quoteId }).del();
  await trx('quote_tags').where({ quote_id: quoteId }).del();
  if (resolved.scopeIds.length) {
    await trx('quote_scope_items').insert(resolved.scopeIds.map((scope_item_id) => ({ quote_id: quoteId, scope_item_id })));
  }
  if (resolved.addons.length) {
    await trx('quote_addons').insert(
      resolved.addons.map((a) => ({ quote_id: quoteId, addon_service_id: a.addon_service_id, price: a.price })),
    );
  }
  if (resolved.tagIds.length) {
    await trx('quote_tags').insert(resolved.tagIds.map((tag_id) => ({ quote_id: quoteId, tag_id })));
  }
}

export async function createAgreement(
  customerId: string,
  scope: BranchScope,
  input: AgreementInput,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<AgreementForm> {
  return db.transaction(async (trx) => {
    const customer = await scopedCustomer(customerId, scope, trx);
    const resolved = await resolve(input, customer, null, trx);
    const [quote] = (await trx('quotes')
      .insert({
        ...resolved.values,
        created_by_user_id: actor.user_id,
        // Ready to sign: the form is what is shown to the customer.
        status: 'presented',
      })
      .returning('*')) as Quote[];
    if (!quote) throw new Error('Insert returned no quote row');
    await writeChoices(quote.id, resolved, trx);
    await recordAudit(
      actor,
      { action: 'quote.created', entity_type: 'quote', entity_id: quote.id, after: { ...quote, kind: 'service_agreement' } },
      trx,
    );
    return formOf(quote.id, trx);
  });
}

export async function updateAgreement(
  quoteId: string,
  scope: BranchScope,
  input: AgreementInput,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<AgreementForm> {
  return db.transaction(async (trx) => {
    const before = await lockQuote(quoteId, scope, trx);
    if (!before.billing_plan_id) throw conflict('That quote is not a service agreement');
    const signed = await trx('contracts').where({ quote_id: quoteId }).first('id');
    if (signed || !['draft', 'presented'].includes(before.status)) {
      throw conflict('This agreement has been signed or closed, so it can no longer be changed');
    }
    const owner = (await trx('properties')
      .join('customers', 'customers.id', 'properties.customer_id')
      .where('properties.id', before.property_id)
      .first('customers.id', 'customers.branch_id')) as { id: string; branch_id: string };
    const resolved = await resolve(input, owner, before, trx);
    const [quote] = (await trx('quotes').where({ id: quoteId }).update(resolved.values).returning('*')) as Quote[];
    await writeChoices(quoteId, resolved, trx);
    await recordAudit(
      actor,
      { action: 'quote.updated', entity_type: 'quote', entity_id: quoteId, before, after: quote },
      trx,
    );
    return formOf(quoteId, trx);
  });
}

async function formOf(quoteId: string, db: Knex): Promise<AgreementForm> {
  const quote = (await db('quotes')
    .join('properties', 'properties.id', 'quotes.property_id')
    .where('quotes.id', quoteId)
    .first('quotes.*', 'properties.customer_id')) as Quote & { customer_id: string };
  const [scopeIds, addons, tagIds, contract] = await Promise.all([
    db('quote_scope_items').where({ quote_id: quoteId }).pluck('scope_item_id') as Promise<string[]>,
    db('quote_addons').where({ quote_id: quoteId }).select('addon_service_id', 'price') as Promise<
      { addon_service_id: string; price: string }[]
    >,
    db('quote_tags').where({ quote_id: quoteId }).pluck('tag_id') as Promise<string[]>,
    db('contracts').where({ quote_id: quoteId }).first('id') as Promise<{ id: string } | undefined>,
  ]);
  const addonsTotal = addons.reduce((sum, a) => sum + (toCents(a.price) ?? 0), 0);
  return {
    quote_id: quote.id,
    customer_id: quote.customer_id,
    status: quote.status,
    contract_id: contract?.id ?? null,
    created_at: quote.created_at,
    property_id: quote.property_id,
    contract_type_id: quote.contract_type_id!,
    billing_plan_id: quote.billing_plan_id!,
    package: quote.package ?? 'basic',
    trigger_cm: Number(quote.trigger_cm ?? 3),
    season_start: quote.season_start,
    season_end: quote.season_end,
    assigned_operator_id: quote.assigned_operator_id,
    service_route_id: quote.service_route_id,
    scope_item_ids: scopeIds,
    addons,
    tag_ids: tagIds,
    normal_price: centsToDecimal((toCents(quote.initial_price) ?? 0) - addonsTotal),
    discount: quote.discount,
    referral_credit: quote.referral_credit,
    referred_by_customer_id: quote.referred_by_customer_id,
    tax_code_id: quote.tax_code_id!,
    route_code: quote.route_code,
    driveway_car_lengths: quote.driveway_car_lengths,
    driveway_width: quote.driveway_width,
    property_notes: quote.property_notes,
    auto_renew: quote.auto_renew,
  };
}

/** The scope check every read below starts with. */
async function assertAgreementInScope(quoteId: string, scope: BranchScope, db: Knex): Promise<void> {
  const row = await scopedQuotes(db, scope).andWhere('quotes.id', quoteId).first('quotes.billing_plan_id');
  if (!row) throw notFound('Agreement not found');
  if (!(row as { billing_plan_id: string | null }).billing_plan_id) {
    throw notFound('That quote is not a service agreement');
  }
}

export async function getAgreementForm(quoteId: string, scope: BranchScope, db: Knex = defaultDb): Promise<AgreementForm> {
  await assertAgreementInScope(quoteId, scope, db);
  return formOf(quoteId, db);
}

export async function getAgreementModel(quoteId: string, scope: BranchScope, db: Knex = defaultDb): Promise<AgreementModel> {
  await assertAgreementInScope(quoteId, scope, db);
  return buildAgreementModel(quoteId, db);
}

export async function agreementPreviewPdf(quoteId: string, scope: BranchScope, db: Knex = defaultDb): Promise<Buffer> {
  await assertAgreementInScope(quoteId, scope, db);
  return renderAgreementPreview(quoteId, db);
}

export interface SignInput {
  /** The stored PNG of the customer's signature. */
  signature_key: string;
  signer_name: string;
  /** The boxes the customer applied their signature to. */
  boxes: SignatureBox[];
  signed_lat: number | null;
  signed_lng: number | null;
  checklist: ChecklistInput[];
}

/** Which boxes must be signed. A YIA customer has already paid, so there is no card to authorize. */
export function requiredBoxes(planKind: BillingPlan['kind']): SignatureBox[] {
  return SIGNATURE_BOXES.filter((box) => box !== 'card_authorization' || planKind !== 'seasonal_yia');
}

/**
 * Signing on screen. The contract, the locked PDF with the signature in every
 * box, the first invoice if one is due, and the customer's emailed copy all
 * land in one transaction.
 */
export async function signAgreement(
  quoteId: string,
  scope: BranchScope,
  input: SignInput,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<ContractWithChecklist> {
  await assertAgreementInScope(quoteId, scope, db);
  const terms = await loadQuoteTerms(quoteId, db);
  if (!terms) throw notFound('That quote is not a service agreement');
  if (terms.contract_type.agreement_medium === 'paper') {
    throw conflict('This is a paper agreement: upload the signed scan instead');
  }
  const missing = requiredBoxes(terms.plan.kind).filter((box) => !input.boxes.includes(box));
  if (missing.length) {
    throw badRequest(
      'Every signature box has to be signed',
      missing.map((box) => ({ path: `boxes.${box}`, message: 'not signed' })),
    );
  }
  const signerName = input.signer_name.trim();
  if (signerName.split(/\s+/).length < 2) throw badRequest('Enter the signer’s full name');
  await assertStored(input.signature_key, 'signature', db);

  const now = new Date().toISOString();
  const boxes = Object.fromEntries(input.boxes.map((box) => [box, now]));

  return db.transaction(async (trx) => {
    const contract = await createContract(
      quoteId,
      scope,
      {
        signature_image_url: input.signature_key,
        signed_at: null,
        signed_lat: input.signed_lat,
        signed_lng: input.signed_lng,
        terms_version: SERVICE_AGREEMENT_TERMS_VERSION,
        payment_method_token: null,
        payment_method_last4: null,
        payment_method_brand: null,
        checklist: input.checklist,
        agreement_medium: 'electronic',
        signer_name: signerName,
        signature_boxes: boxes,
      },
      actor,
      trx,
    );
    await emailSignedCopy(contract.id, trx);
    return contract;
  });
}

export interface PaperInput {
  /** The uploaded scan of the signed paper agreement. */
  pdf_key: string;
  signer_name: string;
  checklist: ChecklistInput[];
}

/** A paper agreement, signed on paper: the scan is the contract's document. */
export async function recordPaperAgreement(
  quoteId: string,
  scope: BranchScope,
  input: PaperInput,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<ContractWithChecklist> {
  await assertAgreementInScope(quoteId, scope, db);
  const terms = await loadQuoteTerms(quoteId, db);
  if (!terms) throw notFound('That quote is not a service agreement');
  if (terms.contract_type.agreement_medium !== 'paper') {
    throw conflict('This is an electronic agreement: have the customer sign it on screen');
  }
  const signerName = input.signer_name.trim();
  if (!signerName) throw badRequest('Enter the name of the person who signed');
  await assertStored(input.pdf_key, 'contract_pdf', db);

  return createContract(
    quoteId,
    scope,
    {
      signature_image_url: null,
      signed_at: null,
      signed_lat: null,
      signed_lng: null,
      terms_version: SERVICE_AGREEMENT_TERMS_VERSION,
      payment_method_token: null,
      payment_method_last4: null,
      payment_method_brand: null,
      checklist: input.checklist,
      agreement_medium: 'paper',
      signer_name: signerName,
      signature_boxes: null,
      pdf_url: input.pdf_key,
    },
    actor,
    db,
  );
}

async function assertStored(key: string, purpose: 'signature' | 'contract_pdf', db: Knex): Promise<void> {
  const upload = await db('uploads').where({ key, purpose, status: 'stored' }).first('id');
  if (!upload) throw badRequest(purpose === 'signature' ? 'Upload the signature first' : 'Upload the signed PDF first');
}

/** The signed PDF, by email, if the customer has an address to send it to. */
async function emailSignedCopy(contractId: string, trx: Knex.Transaction): Promise<void> {
  const row = (await trx('contracts')
    .join('customers', 'customers.id', 'contracts.customer_id')
    .join('properties', 'properties.id', 'contracts.property_id')
    .join('branches', 'branches.id', 'customers.branch_id')
    .join('quotes', 'quotes.id', 'contracts.quote_id')
    .join('contract_types', 'contract_types.id', 'quotes.contract_type_id')
    .where('contracts.id', contractId)
    .first(
      'contracts.pdf_url',
      'contracts.quote_id',
      'customers.id as customer_id',
      'customers.email',
      'customers.first_name',
      'customers.branch_id',
      'branches.name as branch_name',
      'properties.address_line1',
      'contract_types.label as agreement_name',
    )) as
    | {
        pdf_url: string | null;
        quote_id: string;
        customer_id: string;
        email: string | null;
        first_name: string;
        branch_id: string;
        branch_name: string;
        address_line1: string;
        agreement_name: string;
      }
    | undefined;
  if (!row?.email || !row.pdf_url) return;
  const terms = await loadQuoteTerms(row.quote_id, trx);
  await enqueueMessage(
    {
      template_code: 'agreement_signed',
      channel: 'email',
      recipient: row.email,
      branch_id: row.branch_id,
      customer_id: row.customer_id,
      context: {
        customer_first_name: row.first_name,
        address_line1: row.address_line1,
        agreement_name: row.agreement_name,
        first_payment: terms ? formatMoney(terms.pricing.first_payment_total) : '',
        branch_name: row.branch_name,
      },
      attachment_key: row.pdf_url,
      attachment_name: 'Drift-Service-Agreement.pdf',
    },
    trx,
  );
}
