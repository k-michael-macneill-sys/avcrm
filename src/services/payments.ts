import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { Payment, PaymentMethod, PaymentStatus } from '../types/models';
import { badRequest, conflict, notFound } from '../utils/errors';
import { logger } from '../utils/logger';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { isPgError, PG_UNIQUE_VIOLATION } from '../utils/pg';
import { applyBranchScope } from '../utils/scope';
import { recordAudit, type AuditActor } from './audit';
import {
  getInvoice,
  lock as lockInvoice,
  recomputeInvoiceTotals,
  type InvoiceWithPayments,
} from './invoices';
import { enqueueMessage } from './messages';

/** Money can only be taken against a bill the customer has actually seen. */
const PAYABLE_STATUSES = ['sent', 'overdue', 'paid'];

export interface PaymentInput {
  amount: number;
  method: PaymentMethod;
  provider_transaction_id: string | null;
  status: Extract<PaymentStatus, 'pending' | 'succeeded' | 'failed'>;
  failure_reason: string | null;
}

/** Payments are scoped through their invoice's branch. */
function scoped(db: Knex, scope: BranchScope) {
  return applyBranchScope(
    db('payments').join('invoices', 'invoices.id', 'payments.invoice_id'),
    'invoices.branch_id',
    scope,
  );
}

export interface PaymentFilters {
  status?: PaymentStatus;
  method?: PaymentMethod;
  invoice_id?: string;
}

export async function listBranchPayments(
  scope: BranchScope,
  filters: PaymentFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<Payment>> {
  const base = scoped(db, scope);

  if (filters.status) base.andWhere('payments.status', filters.status);
  if (filters.method) base.andWhere('payments.method', filters.method);
  if (filters.invoice_id) base.andWhere('payments.invoice_id', filters.invoice_id);

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'payments.created_at', order: 'desc' },
        { column: 'payments.id', order: 'desc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('payments.*'),
    base.clone().count<{ count: string }[]>({ count: 'payments.id' }).first(),
  ]);

  return paginated(rows as Payment[], Number(countRow?.count ?? 0), pagination);
}

/**
 * Books money against an invoice, or records that an attempt failed.
 *
 * A succeeded payment recomputes the invoice from its payments rather than
 * incrementing a running total, so the two can never disagree. A failed card
 * charge tells the customer and the branch manager, per the spec.
 */
export async function recordPayment(
  invoiceId: string,
  scope: BranchScope,
  input: PaymentInput,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<InvoiceWithPayments> {
  if (input.status === 'failed' && !input.failure_reason) {
    throw badRequest('failure_reason is required when a payment failed');
  }

  const payment = await db.transaction(async (trx) => {
    const invoice = await lockInvoice(invoiceId, scope, trx);
    if (!PAYABLE_STATUSES.includes(invoice.status)) {
      throw conflict(
        invoice.status === 'draft'
          ? 'Send this invoice before taking payment against it'
          : `This invoice is ${invoice.status}, so it cannot take a payment`,
      );
    }

    let created: Payment | undefined;
    try {
      [created] = await trx('payments')
        .insert({
          invoice_id: invoiceId,
          amount: input.amount.toFixed(2),
          method: input.method,
          provider_transaction_id: input.provider_transaction_id,
          status: input.status,
          failure_reason: input.status === 'failed' ? input.failure_reason : null,
          processed_at: input.status === 'pending' ? null : new Date(),
        })
        .returning('*');
    } catch (err) {
      // The processor replayed a webhook, or a rep double-tapped.
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw conflict('That transaction has already been recorded');
      }
      throw err;
    }
    if (!created) {
      throw new Error('Insert returned no payment row');
    }

    if (created.status === 'succeeded') {
      await recomputeInvoiceTotals(invoiceId, trx);
    }

    await recordAudit(
      actor,
      {
        action: 'payment.recorded',
        entity_type: 'payment',
        entity_id: created.id,
        after: created,
      },
      trx,
    );

    return created;
  });

  if (payment.status === 'failed') {
    await notifyPaymentFailed(invoiceId, payment, db);
  }

  return getInvoice(invoiceId, scope, db);
}

/**
 * Gives money back. The original row flips to `refunded` rather than being
 * deleted or offset by a negative row, so the history of a disputed charge
 * stays readable, and the invoice total recomputes to match.
 */
export async function refundPayment(
  paymentId: string,
  scope: BranchScope,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<InvoiceWithPayments> {
  const invoiceId = await db.transaction(async (trx) => {
    const payment = (await scoped(trx, scope)
      .andWhere('payments.id', paymentId)
      .forUpdate('payments')
      .first('payments.*')) as Payment | undefined;

    if (!payment) {
      throw notFound('Payment not found');
    }
    if (payment.status !== 'succeeded') {
      throw conflict(`Only a succeeded payment can be refunded (this one is ${payment.status})`);
    }

    const [updated] = await trx('payments')
      .where({ id: paymentId })
      .update({ status: 'refunded' })
      .returning('*');
    if (!updated) {
      throw notFound('Payment not found');
    }

    await recomputeInvoiceTotals(payment.invoice_id, trx);

    await recordAudit(
      actor,
      {
        action: 'payment.refunded',
        entity_type: 'payment',
        entity_id: paymentId,
        before: { status: payment.status },
        after: { status: updated.status },
      },
      trx,
    );

    return payment.invoice_id;
  });

  return getInvoice(invoiceId, scope, db);
}

interface FailureRow {
  branch_id: string;
  customer_id: string;
  customer_first_name: string;
  customer_email: string | null;
  customer_last_name: string;
  customer_phone: string | null;
  address_line1: string;
  branch_name: string;
  manager_email: string | null;
}

/**
 * The spec's rule: a failed card charge tells the customer and flags the
 * branch manager.
 *
 * Only a card gets the customer email — its wording is about a declined card,
 * and a bounced cheque is a conversation for the office rather than an
 * automated notice. The manager hears about either.
 */
async function notifyPaymentFailed(
  invoiceId: string,
  payment: Payment,
  db: Knex,
): Promise<void> {
  const row = (await db('invoices')
    .join('customers', 'customers.id', 'invoices.customer_id')
    .join('contracts', 'contracts.id', 'invoices.contract_id')
    .join('properties', 'properties.id', 'contracts.property_id')
    .join('branches', 'branches.id', 'invoices.branch_id')
    .leftJoin('users as manager', 'manager.id', 'branches.manager_user_id')
    .where('invoices.id', invoiceId)
    .first([
      'invoices.branch_id',
      'customers.id as customer_id',
      'customers.first_name as customer_first_name',
      'customers.last_name as customer_last_name',
      'customers.email as customer_email',
      'customers.phone as customer_phone',
      'properties.address_line1',
      'branches.name as branch_name',
      'manager.email as manager_email',
    ])) as FailureRow | undefined;

  if (!row) return;

  const context = {
    customer_first_name: row.customer_first_name,
    customer_name: `${row.customer_first_name} ${row.customer_last_name}`,
    customer_email: row.customer_email ?? 'no email on file',
    customer_phone: row.customer_phone ?? 'no phone on file',
    address_line1: row.address_line1,
    branch_name: row.branch_name,
    amount: payment.amount,
    method: payment.method.replace(/_/g, ' '),
    failure_reason: payment.failure_reason ?? 'no reason given',
  };

  if (payment.method === 'card_on_file' && row.customer_email) {
    await enqueueMessage(
      {
        template_code: 'payment_failed',
        channel: 'email',
        recipient: row.customer_email,
        branch_id: row.branch_id,
        customer_id: row.customer_id,
        context,
      },
      db,
    );
  }

  if (row.manager_email) {
    await enqueueMessage(
      {
        template_code: 'payment_failed_internal',
        channel: 'email',
        recipient: row.manager_email,
        branch_id: row.branch_id,
        customer_id: row.customer_id,
        context,
      },
      db,
    );
  } else {
    logger.warn({ invoice_id: invoiceId }, 'Payment failed with no branch manager to tell');
  }
}
