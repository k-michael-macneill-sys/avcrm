import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import { centsToDecimal, toCents } from '../types/serviceAgreement';

/**
 * A customer's credit, as a ledger: referral credit earned is a positive
 * row, credit spent on an invoice a negative one, and the balance is their
 * sum. Never a running total kept somewhere, so the balance can always be
 * explained row by row.
 */

/** Cents of credit the customer has to spend. */
export async function creditBalance(customerId: string, db: Knex = defaultDb): Promise<number> {
  const row = (await db('customer_credits')
    .where({ customer_id: customerId })
    .sum<{ total: string | null }[]>({ total: 'amount' })
    .first()) as { total: string | null } | undefined;
  return toCents(row?.total ?? '0') ?? 0;
}

/**
 * Spends what credit the customer has against a new invoice, up to what it
 * comes to. The customer row is locked first so two invoices raised at once
 * cannot both spend the same credit. Returns the cents applied.
 */
export async function applyCredit(
  customerId: string,
  invoiceId: string,
  owing: number,
  trx: Knex.Transaction,
): Promise<number> {
  if (owing <= 0) return 0;
  await trx('customers').where({ id: customerId }).forUpdate().first('id');
  const available = await creditBalance(customerId, trx);
  const applied = Math.min(available, owing);
  if (applied <= 0) return 0;
  await trx('customer_credits').insert({
    customer_id: customerId,
    kind: 'applied',
    amount: centsToDecimal(-applied),
    invoice_id: invoiceId,
    description: 'Applied to invoice',
  });
  return applied;
}

/**
 * When a referred customer's bill is paid, the customer who referred them
 * earns their referral credit for each month that bill paid for. Once per
 * invoice, however many times its payments are recomputed.
 */
export async function earnReferralCredit(invoiceId: string, db: Knex): Promise<void> {
  const row = (await db('invoices')
    .join('contracts', 'contracts.id', 'invoices.contract_id')
    .join('quotes', 'quotes.id', 'contracts.quote_id')
    .join('customers', 'customers.id', 'invoices.customer_id')
    .where('invoices.id', invoiceId)
    .first(
      'invoices.status',
      'invoices.service_months',
      'quotes.referred_by_customer_id',
      'quotes.referral_credit',
      'customers.first_name',
      'customers.last_name',
    )) as
    | {
        status: string;
        service_months: number | null;
        referred_by_customer_id: string | null;
        referral_credit: string | null;
        first_name: string;
        last_name: string;
      }
    | undefined;

  if (!row || row.status !== 'paid' || !row.referred_by_customer_id || row.service_months === null) return;
  const perMonth = toCents(row.referral_credit) ?? 0;
  if (perMonth <= 0) return;

  await db('customer_credits')
    .insert({
      customer_id: row.referred_by_customer_id,
      kind: 'referral',
      amount: centsToDecimal(perMonth * row.service_months),
      source_invoice_id: invoiceId,
      description: `Referral credit: ${row.first_name} ${row.last_name}, ${row.service_months} month${row.service_months === 1 ? '' : 's'}`,
    })
    .onConflict(db.raw('(source_invoice_id) where kind = \'referral\''))
    .ignore();
}
