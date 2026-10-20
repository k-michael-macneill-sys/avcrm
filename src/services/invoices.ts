import { randomBytes } from 'node:crypto';
import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { Invoice, InvoiceStatus, Payment } from '../types/models';
import { badRequest, conflict, notFound } from '../utils/errors';
import { logger } from '../utils/logger';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { isPgError, PG_UNIQUE_VIOLATION } from '../utils/pg';
import { applyBranchScope } from '../utils/scope';
import { centsToDecimal, formatMoney, longDate, paymentSchedule, toCents } from '../types/serviceAgreement';
import { loadQuoteTerms, localDate, type QuoteTerms } from './agreementTerms';
import { applyCredit, earnReferralCredit } from './credits';
import { activeGateway } from './gateway';
import { contactFor, enqueueMessage } from './messages';

/** Days from the period starting to the money being due. */
const PAYMENT_TERMS_DAYS = 14;

/**
 * A season is five months, so this only guards against a corrupt date pair
 * spinning the period loop forever.
 */
const MAX_PERIODS = 120;

const TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  draft: ['sent', 'void'],
  sent: ['overdue', 'paid', 'void'],
  overdue: ['paid', 'void'],
  paid: [],
  void: [],
};

export interface BillingPeriod {
  start: string;
  end: string;
}

/**
 * Splits a season into monthly periods, the last one ending on season_end
 * rather than running past it. Nov 15 to Apr 15 is five periods.
 */
export function billingPeriods(seasonStart: string, seasonEnd: string): BillingPeriod[] {
  const periods: BillingPeriod[] = [];
  let start = seasonStart;

  for (let month = 1; start < seasonEnd && month <= MAX_PERIODS; month += 1) {
    const next = addMonths(seasonStart, month);
    const end = next < seasonEnd ? next : seasonEnd;
    if (end <= start) break;
    periods.push({ start, end });
    start = end;
  }

  return periods;
}

/**
 * Adds whole months to a YYYY-MM-DD date, clamping to the end of the target
 * month so 31 January plus one month is 28 or 29 February rather than rolling
 * into March.
 */
export function addMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(
    Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0),
  ).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

/** Adds whole days to a YYYY-MM-DD date. */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

interface BillableContract {
  contract_id: string;
  quote_id: string;
  timezone: string;
  customer_id: string;
  branch_id: string;
  status: string;
  signed_at: Date;
  billing_type: string;
  discounted_price: string;
  recurring_price: string | null;
  season_start: string;
  season_end: string;
}

async function billableContract(
  contractId: string,
  db: Knex,
): Promise<BillableContract | undefined> {
  return (await db('contracts')
    .join('quotes', 'quotes.id', 'contracts.quote_id')
    .join('customers', 'customers.id', 'contracts.customer_id')
    .join('branches', 'branches.id', 'customers.branch_id')
    .where('contracts.id', contractId)
    .first([
      'contracts.id as contract_id',
      'contracts.quote_id',
      'branches.timezone',
      'contracts.customer_id',
      'contracts.status',
      'contracts.signed_at',
      'customers.branch_id',
      'quotes.billing_type',
      'quotes.discounted_price',
      'quotes.recurring_price',
      'quotes.season_start',
      'quotes.season_end',
    ])) as BillableContract | undefined;
}

/**
 * Raises whatever this contract owes by `asOf` and has not been billed for.
 *
 * A seasonal contract is one invoice for the whole season, raised the moment
 * it is signed. A monthly contract is one invoice per period, raised as each
 * period starts rather than all five at signature — so cancelling mid-season
 * simply stops the next one being raised, with no future invoices to chase
 * and void.
 *
 * Safe to call repeatedly: a period already invoiced is skipped, and the
 * partial unique index backs that up if two runs race.
 */
export async function generateInvoicesForContract(
  contractId: string,
  asOf: string = today(),
  db: Knex = defaultDb,
): Promise<Invoice[]> {
  const contract = await billableContract(contractId, db);
  if (!contract) {
    throw notFound('Contract not found');
  }
  if (contract.status !== 'active') {
    return [];
  }

  // A service agreement bills from its own payment schedule.
  const terms = await loadQuoteTerms(contract.quote_id, db);
  if (terms) {
    return raiseScheduledInvoices(contract, terms, asOf, db);
  }

  const periods =
    contract.billing_type === 'seasonal_upfront'
      ? [{ start: contract.season_start, end: contract.season_end }]
      : billingPeriods(contract.season_start, contract.season_end);

  const existing = await db('invoices')
    .where({ contract_id: contractId })
    .whereNot({ status: 'void' })
    .pluck('billing_period_start');
  const alreadyBilled = new Set(existing);

  // A seasonal contract bills at signature; a monthly one waits for the
  // period to start.
  const dueNow =
    contract.billing_type === 'seasonal_upfront'
      ? periods
      : periods.filter((period) => period.start <= asOf);

  const raised: Invoice[] = [];
  // What the rep sold: a first visit at the discounted price, then a monthly
  // amount for the rest of the season. A contract quoted before there was a
  // recurring price, or one where the rep left it blank, bills the same
  // amount all season — which is what it did before this existed.
  const firstPeriodStart = periods[0]?.start;
  const amountFor = (periodStart: string): string =>
    periodStart === firstPeriodStart || contract.recurring_price === null
      ? contract.discounted_price
      : contract.recurring_price;

  for (const period of dueNow) {
    if (alreadyBilled.has(period.start)) continue;

    // Seasonal terms run from the signature; monthly from the period start.
    const termsFrom =
      contract.billing_type === 'seasonal_upfront'
        ? contract.signed_at.toISOString().slice(0, 10)
        : period.start;

    try {
      const [invoice] = await db('invoices')
        .insert({
          contract_id: contract.contract_id,
          customer_id: contract.customer_id,
          branch_id: contract.branch_id,
          billing_period_start: period.start,
          billing_period_end: period.end,
          amount_due: amountFor(period.start),
          amount_paid: '0',
          status: 'draft',
          due_date: addDays(termsFrom, PAYMENT_TERMS_DAYS),
        })
        .returning('*');
      if (invoice) raised.push(invoice);
    } catch (err) {
      // Another run got there first. That is the index doing its job.
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        logger.debug(
          { contract_id: contractId, period_start: period.start },
          'Invoice for this period already exists',
        );
        continue;
      }
      throw err;
    }
  }

  return raised;
}

/**
 * Raises every payment a service agreement's schedule has due by `asOf` that
 * has not been billed yet: the first payment on signing or November 1st,
 * then one a month, renewals included once the commitment is over and the
 * agreement renews. Tax is added per payment, and any credit the customer
 * has — referral credit, mostly — is taken off before the bill goes out.
 * A bill the credit covers entirely is raised already paid.
 *
 * Safe to call repeatedly, for the same reason the monthly path is: the
 * period's start date is unique per contract among invoices that are not void.
 */
async function raiseScheduledInvoices(
  contract: BillableContract,
  terms: QuoteTerms,
  asOf: string,
  db: Knex,
): Promise<Invoice[]> {
  const signedOn = localDate(contract.signed_at, contract.timezone);
  const due = paymentSchedule({ ...terms.schedule, signed_on: signedOn }, terms.pricing, asOf);

  const existing = await db('invoices')
    .where({ contract_id: contract.contract_id })
    .whereNot({ status: 'void' })
    .pluck('billing_period_start');
  const alreadyBilled = new Set(existing);

  const raised: Invoice[] = [];
  for (const entry of due) {
    if (alreadyBilled.has(entry.due_on)) continue;
    try {
      const invoice = await db.transaction(async (trx) => {
        const [row] = (await trx('invoices')
          .insert({
            contract_id: contract.contract_id,
            customer_id: contract.customer_id,
            branch_id: contract.branch_id,
            billing_period_start: entry.due_on,
            billing_period_end: entry.period_end,
            subtotal: centsToDecimal(entry.amount),
            tax_amount: centsToDecimal(entry.tax),
            credit_applied: '0',
            amount_due: centsToDecimal(entry.total),
            amount_paid: '0',
            service_months: entry.months,
            status: 'draft',
            due_date: addDays(entry.due_on, PAYMENT_TERMS_DAYS),
          })
          .returning('*')) as Invoice[];
        if (!row) throw new Error('Insert returned no invoice row');

        const credit = await applyCredit(contract.customer_id, row.id, entry.total, trx);
        if (credit === 0) return row;

        const owing = entry.total - credit;
        const now = new Date();
        const [updated] = (await trx('invoices')
          .where({ id: row.id })
          .update({
            credit_applied: centsToDecimal(credit),
            amount_due: centsToDecimal(owing),
            // Nothing left to pay: it was paid with credit.
            ...(owing === 0 ? { status: 'paid', sent_at: now, paid_at: now } : {}),
          })
          .returning('*')) as Invoice[];
        if (owing === 0) await earnReferralCredit(row.id, trx);
        return updated!;
      });
      raised.push(invoice);
    } catch (err) {
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        logger.debug({ contract_id: contract.contract_id, due_on: entry.due_on }, 'Invoice for this payment already exists');
        continue;
      }
      throw err;
    }
  }
  return raised;
}

export interface InvoiceFilters {
  status?: InvoiceStatus;
  customer_id?: string;
  contract_id?: string;
  /** Sent or overdue with money still outstanding. */
  outstanding?: boolean;
}

export async function listInvoices(
  scope: BranchScope,
  filters: InvoiceFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<Invoice>> {
  const base = applyBranchScope(db('invoices'), 'branch_id', scope);

  if (filters.status) base.andWhere({ status: filters.status });
  if (filters.customer_id) base.andWhere({ customer_id: filters.customer_id });
  if (filters.contract_id) base.andWhere({ contract_id: filters.contract_id });
  if (filters.outstanding) {
    base.whereIn('status', ['sent', 'overdue']).andWhereRaw('amount_paid < amount_due');
  }

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'due_date', order: 'asc' },
        { column: 'id', order: 'asc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('*'),
    base.clone().count<{ count: string }[]>({ count: '*' }).first(),
  ]);

  return paginated(rows, Number(countRow?.count ?? 0), pagination);
}

export interface InvoiceWithPayments extends Invoice {
  payments: Payment[];
}

export async function getInvoice(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<InvoiceWithPayments> {
  const invoice = await applyBranchScope(db('invoices'), 'branch_id', scope)
    .andWhere({ id })
    .first();
  if (!invoice) {
    throw notFound('Invoice not found');
  }
  return { ...invoice, payments: await listPayments(id, db) };
}

export async function listPayments(
  invoiceId: string,
  db: Knex = defaultDb,
): Promise<Payment[]> {
  return db('payments')
    .where({ invoice_id: invoiceId })
    .orderBy([
      { column: 'created_at', order: 'asc' },
      { column: 'id', order: 'asc' },
    ])
    .select('*');
}

/** Puts the bill in front of the customer, and records that we did. */
export async function sendInvoice(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<InvoiceWithPayments> {
  await db.transaction(async (trx) => {
    const before = await lock(id, scope, trx);
    assertTransition(before.status, 'sent');

    await trx('invoices')
      .where({ id })
      .update({ status: 'sent', sent_at: new Date() });

    await enqueueInvoiceMessage(id, 'invoice_sent', trx);
  });

  return getInvoice(id, scope, db);
}

export async function voidInvoice(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<InvoiceWithPayments> {
  await db.transaction(async (trx) => {
    const before = await lock(id, scope, trx);
    assertTransition(before.status, 'void');

    if (Number(before.amount_paid) > 0) {
      throw conflict('Refund the payments on this invoice before voiding it');
    }

    await trx('invoices').where({ id }).update({ status: 'void' });
  });

  return getInvoice(id, scope, db);
}

export interface OverdueSummary {
  marked: number;
}

/** Anything sent, past its date and still short is overdue. */
export async function markOverdue(
  asOf: string = today(),
  db: Knex = defaultDb,
): Promise<OverdueSummary> {
  const due = await db('invoices')
    .where({ status: 'sent' })
    .andWhere('due_date', '<', asOf)
    .andWhereRaw('amount_paid < amount_due')
    .update({ status: 'overdue' })
    .returning(['id']);

  for (const invoice of due) {
    await enqueueInvoiceMessage(invoice.id, 'invoice_overdue', db);
  }

  return { marked: due.length };
}

/**
 * Recomputes what an invoice has been paid, from the payments themselves.
 *
 * Derived rather than incremented: a refund flips a payment to `refunded` and
 * this simply stops counting it, so the total can never drift from the rows
 * that explain it.
 */
export async function recomputeInvoiceTotals(
  invoiceId: string,
  db: Knex,
): Promise<Invoice> {
  const invoice = await db('invoices').where({ id: invoiceId }).forUpdate().first();
  if (!invoice) {
    throw notFound('Invoice not found');
  }

  const row = (await db('payments')
    .where({ invoice_id: invoiceId, status: 'succeeded' })
    .sum<{ total: string | null }[]>({ total: 'amount' })
    .first()) as { total: string | null } | undefined;

  const paid = Number(row?.total ?? 0);
  const due = Number(invoice.amount_due);
  const covered = paid >= due;

  let status = invoice.status;
  let paidAt = invoice.paid_at;

  if (invoice.status !== 'void') {
    if (covered && invoice.status !== 'paid') {
      status = 'paid';
      paidAt = new Date();
    } else if (!covered && invoice.status === 'paid') {
      // A refund pulled it back under. It owes money again.
      status = invoice.due_date < today() ? 'overdue' : 'sent';
      paidAt = null;
    }
  }

  const [updated] = await db('invoices')
    .where({ id: invoiceId })
    .update({ amount_paid: paid.toFixed(2), status, paid_at: paidAt })
    .returning('*');
  if (!updated) {
    throw notFound('Invoice not found');
  }
  // A referred customer paying their bill earns their referrer's credit.
  if (status === 'paid' && invoice.status !== 'paid') {
    await earnReferralCredit(invoiceId, db);
    // A bill the customer's credit covered was never sent, and took no money.
    if (paid > 0 && invoice.status !== 'draft') await queueReceipt(invoiceId, db);
  }
  return updated;
}

export function payUrl(token: string): string {
  return `${config.messaging.appBaseUrl}/pay/${token}`;
}

/**
 * The capability in the customer's link to their bill, made the first time
 * it is needed and kept after, so every email about one invoice carries the
 * same link.
 */
export async function ensurePortalToken(invoiceId: string, db: Knex = defaultDb): Promise<string> {
  const [row] = (await db('invoices')
    .where({ id: invoiceId })
    .update({
      portal_token: db.raw('coalesce(portal_token, ?)', [randomBytes(24).toString('base64url')]),
    })
    .returning(['portal_token'])) as { portal_token: string }[];
  if (!row) {
    throw notFound('Invoice not found');
  }
  return row.portal_token;
}

interface InvoiceContext {
  customer_first_name: string;
  customer_email: string | null;
  customer_phone: string | null;
  preferred_contact: string | null;
  branch_id: string;
  branch_name: string;
  address_line1: string;
  amount_due: string;
  amount_outstanding: string;
  due_date: string;
  billing_period_start: string;
  billing_period_end: string;
  customer_id: string;
}

/** The messages about one invoice: the bill, the reminder, the receipt. */
export type InvoiceTemplate = 'invoice_sent' | 'invoice_overdue' | 'payment_receipt';

const METHOD_LABELS: Record<string, string> = {
  card_on_file: 'Card on file',
  online: 'Card, paid online',
  etransfer: 'e-Transfer',
  cheque: 'Cheque',
  cash: 'Cash',
};

/** The short number a customer can quote back: the first block of the id. */
export function invoiceNumber(id: string): string {
  return id.slice(0, 8).toUpperCase();
}

const dollars = (amount: string | number): string => formatMoney(toCents(Number(amount).toFixed(2)) ?? 0);

/**
 * Queued, never sent here: the customer's bill is not the API's problem.
 *
 * `to` sends it to that address instead of wherever the customer prefers —
 * an office resending a bill to a previous customer's new email, say.
 * Returns who it went to, or null when there was nowhere to send it.
 */
export async function enqueueInvoiceMessage(
  invoiceId: string,
  templateCode: InvoiceTemplate,
  db: Knex,
  to: string | null = null,
): Promise<string | null> {
  const row = (await db('invoices')
    .join('customers', 'customers.id', 'invoices.customer_id')
    .join('contracts', 'contracts.id', 'invoices.contract_id')
    .join('properties', 'properties.id', 'contracts.property_id')
    .join('branches', 'branches.id', 'invoices.branch_id')
    .where('invoices.id', invoiceId)
    .first([
      'customers.first_name as customer_first_name',
      'customers.email as customer_email',
      'customers.phone as customer_phone',
      'customers.preferred_contact',
      'customers.id as customer_id',
      'invoices.branch_id',
      'invoices.amount_due',
      'invoices.amount_paid',
      'invoices.due_date',
      'invoices.paid_at',
      'invoices.billing_period_start',
      'invoices.billing_period_end',
      'branches.name as branch_name',
      'branches.timezone as branch_timezone',
      'properties.address_line1',
      'properties.city',
    ])) as
    | (InvoiceContext & {
        amount_paid: string;
        paid_at: Date | null;
        branch_timezone: string;
        city: string | null;
      })
    | undefined;

  if (!row) return null;
  const contact = to
    ? { channel: 'email' as const, recipient: to }
    : contactFor({
        preferred_contact: row.preferred_contact,
        email: row.customer_email,
        phone: row.customer_phone,
      });
  if (!contact) {
    logger.info({ invoice_id: invoiceId }, 'No customer email or phone on file; invoice not queued');
    return null;
  }

  const token = await ensurePortalToken(invoiceId, db);
  const takesPayments = (await activeGateway(db)).takesPortalPayments;
  const outstanding = Number(row.amount_due) - Number(row.amount_paid);
  const property = [row.address_line1, row.city].filter(Boolean).join(', ');
  const period = `${longDate(row.billing_period_start)} to ${longDate(row.billing_period_end)}`;
  const lines = (rows: [string, string][]): string => rows.map(([label, value]) => `${label}: ${value}`).join('\n');

  let receipt: Record<string, string> = {};
  if (templateCode === 'payment_receipt') {
    const payment = (await db('payments')
      .where({ invoice_id: invoiceId, status: 'succeeded' })
      .orderBy('processed_at', 'desc')
      .first('method', 'processed_at')) as { method: string; processed_at: Date | null } | undefined;
    const paidAt = row.paid_at ?? payment?.processed_at ?? new Date();
    receipt = {
      amount_paid_text: dollars(row.amount_paid),
      receipt_summary: lines([
        ['Receipt for invoice', `#${invoiceNumber(invoiceId)}`],
        ['Paid on', longDate(localDate(new Date(paidAt), row.branch_timezone))],
        ['Amount paid', dollars(row.amount_paid)],
        ...(payment ? ([['Payment method', METHOD_LABELS[payment.method] ?? payment.method]] as [string, string][]) : []),
        ['Property', property],
        ['Service period', period],
        ['Balance', dollars(Math.max(outstanding, 0))],
      ]),
    };
  }

  const summary: [string, string][] =
    templateCode === 'invoice_overdue'
      ? [
          ['Invoice', `#${invoiceNumber(invoiceId)}`],
          ['Property', property],
          ['Service period', period],
          ['Invoice total', dollars(row.amount_due)],
          ['Still owing', dollars(outstanding)],
          ['Was due', longDate(row.due_date)],
        ]
      : [
          ['Invoice', `#${invoiceNumber(invoiceId)}`],
          ['Property', property],
          ['Service period', period],
          ['Amount due', dollars(row.amount_due)],
          ...(Number(row.amount_paid) > 0
            ? ([
                ['Paid so far', dollars(row.amount_paid)],
                ['Still owing', dollars(outstanding)],
              ] as [string, string][])
            : []),
          ['Due date', longDate(row.due_date)],
        ];

  await enqueueMessage(
    {
      template_code: templateCode,
      ...contact,
      branch_id: row.branch_id,
      customer_id: row.customer_id,
      context: {
        customer_first_name: row.customer_first_name,
        address_line1: row.address_line1,
        branch_name: row.branch_name,
        amount_due: row.amount_due,
        amount_outstanding: outstanding.toFixed(2),
        outstanding: dollars(outstanding),
        due_date: row.due_date,
        due_on: longDate(row.due_date),
        billing_period_start: row.billing_period_start,
        billing_period_end: row.billing_period_end,
        pay_url: payUrl(token),
        pay_prompt: takesPayments ? 'Pay online' : 'View it online',
        pay_button: takesPayments ? 'Pay your invoice online' : 'View your invoice',
        payment_note: takesPayments
          ? 'If you have a card on file, we’ll charge it automatically on the due date, and you don’t need to do anything.'
          : 'You can pay by e-Transfer, cheque or cash. Reply to this email if you need our payment details.',
        invoice_summary: lines(summary),
        ...receipt,
      },
    },
    db,
  );
  return contact.recipient;
}

/**
 * Sends the customer this invoice's email again — the bill, the reminder if
 * it is late, or the receipt if it is paid — to their own address or `to`.
 * A draft is sent for the first time, the way the Send button does it.
 */
export async function emailInvoice(
  id: string,
  scope: BranchScope,
  to: string | null = null,
  db: Knex = defaultDb,
): Promise<{ sent_to: string; template_code: InvoiceTemplate }> {
  return db.transaction(async (trx) => {
    const invoice = await lock(id, scope, trx);
    if (invoice.status === 'void') {
      throw conflict('This invoice is void, so there is nothing to send');
    }
    if (invoice.status === 'draft') {
      await trx('invoices').where({ id }).update({ status: 'sent', sent_at: new Date() });
    }
    const templateCode: InvoiceTemplate =
      invoice.status === 'paid' ? 'payment_receipt' : invoice.status === 'overdue' ? 'invoice_overdue' : 'invoice_sent';

    const sentTo = await enqueueInvoiceMessage(id, templateCode, trx, to);
    if (!sentTo) {
      throw badRequest('This customer has no email or phone on file. Enter an email address to send it to.');
    }
    return { sent_to: sentTo, template_code: templateCode };
  });
}

/**
 * The receipt, queued when an invoice is paid in full. Never allowed to undo
 * the payment it is about: it runs in a savepoint, and a failure is logged.
 */
async function queueReceipt(invoiceId: string, db: Knex): Promise<void> {
  try {
    await db.transaction((sp) => enqueueInvoiceMessage(invoiceId, 'payment_receipt', sp));
  } catch (err) {
    logger.error({ err, invoice_id: invoiceId }, 'Could not queue the payment receipt');
  }
}

export function assertTransition(from: InvoiceStatus, to: InvoiceStatus): void {
  if (from === to) {
    throw conflict(`This invoice is already ${to}`);
  }
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw conflict(
      allowed.length === 0
        ? `This invoice is ${from}, which is final and cannot be changed`
        : `This invoice is ${from}, so it can only move to ${allowed.join(' or ')}`,
    );
  }
}

export async function lock(
  id: string,
  scope: BranchScope,
  trx: Knex.Transaction,
): Promise<Invoice> {
  const invoice = await applyBranchScope(trx('invoices'), 'branch_id', scope)
    .andWhere({ id })
    .forUpdate()
    .first();
  if (!invoice) {
    throw notFound('Invoice not found');
  }
  return invoice;
}

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/** A manually raised bill, for the things the season plan does not cover. */
export interface ManualInvoiceInput {
  billing_period_start: string;
  billing_period_end: string;
  amount_due: number;
  due_date: string;
}

export async function createInvoice(
  contractId: string,
  scope: BranchScope,
  input: ManualInvoiceInput,
  db: Knex = defaultDb,
): Promise<InvoiceWithPayments> {
  const contract = (await applyBranchScope(
    db('contracts').join('customers', 'customers.id', 'contracts.customer_id'),
    'customers.branch_id',
    scope,
  )
    .andWhere('contracts.id', contractId)
    .first([
      'contracts.id',
      'contracts.customer_id',
      'contracts.status',
      'customers.branch_id',
    ])) as
    | { id: string; customer_id: string; status: string; branch_id: string }
    | undefined;

  if (!contract) {
    throw badRequest('contract_id does not match a contract you can access');
  }
  // An ended contract can still be billed by hand: a previous customer's
  // last visit, or damage found after the season. The nightly run never
  // touches it; that only bills active contracts.

  try {
    const [invoice] = await db('invoices')
      .insert({
        contract_id: contract.id,
        customer_id: contract.customer_id,
        branch_id: contract.branch_id,
        billing_period_start: input.billing_period_start,
        billing_period_end: input.billing_period_end,
        amount_due: input.amount_due.toFixed(2),
        amount_paid: '0',
        status: 'draft',
        due_date: input.due_date,
      })
      .returning('*');
    if (!invoice) {
      throw new Error('Insert returned no invoice row');
    }
    return { ...invoice, payments: [] };
  } catch (err) {
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict('That period has already been invoiced on this contract');
    }
    throw err;
  }
}
