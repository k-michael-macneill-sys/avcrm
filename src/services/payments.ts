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
import { activeGateway, fromMinorUnits, gatewayNamed, toMinorUnits } from './gateway';
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
  /** The processor that moved the money; null for a cheque or a hand entry. */
  provider?: string | null;
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
          provider: input.provider ?? null,
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

    // Money a processor took goes back through that processor. Flipping the
    // row alone would tell the office it was refunded while the customer
    // never saw a cent.
    if (payment.provider && payment.provider_transaction_id) {
      const processor = await gatewayNamed(payment.provider, trx);
      if (!processor?.canCharge) {
        throw conflict(
          `This payment went through ${payment.provider}, which is no longer connected. ` +
            `Refund it from the ${payment.provider} dashboard instead.`,
        );
      }
      await processor.refund(payment.provider_transaction_id, toMinorUnits(payment.amount));
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

interface ChargeableRow {
  invoice_id: string;
  invoice_status: string;
  amount_due: string;
  amount_paid: string;
  branch_id: string;
  address_line1: string;
  payment_method_token: string | null;
  payment_method_provider: string | null;
  autopay_expires_on: string | null;
  square_customer_id: string | null;
  customer_name: string;
}

/**
 * Charges the card the customer saved, with nobody present.
 *
 * This is the whole point of capturing a reusable payment method: the monthly
 * invoice is taken automatically. A decline is not an error here — it comes
 * back as a recorded failed payment, which is what fires the notice to the
 * customer and the flag to the branch manager.
 */
export async function chargeInvoice(
  invoiceId: string,
  scope: BranchScope,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<InvoiceWithPayments> {
  const gateway = await activeGateway(db);
  if (!gateway.canCharge) {
    throw badRequest(
      'No payment processor is connected, so nothing can be charged automatically',
    );
  }

  const row = (await applyBranchScope(
    db('invoices')
      .join('contracts', 'contracts.id', 'invoices.contract_id')
      .join('customers', 'customers.id', 'invoices.customer_id')
      .join('properties', 'properties.id', 'contracts.property_id'),
    'invoices.branch_id',
    scope,
  )
    .andWhere('invoices.id', invoiceId)
    .first([
      'invoices.id as invoice_id',
      'invoices.status as invoice_status',
      'invoices.amount_due',
      'invoices.amount_paid',
      'invoices.branch_id',
      'properties.address_line1',
      'contracts.payment_method_token',
      'contracts.payment_method_provider',
      'contracts.autopay_expires_on',
      'customers.square_customer_id',
      db.raw("customers.first_name || ' ' || customers.last_name as customer_name"),
    ])) as ChargeableRow | undefined;

  if (!row) {
    throw notFound('Invoice not found');
  }
  if (!PAYABLE_STATUSES.includes(row.invoice_status)) {
    throw conflict(
      row.invoice_status === 'draft'
        ? 'Send this invoice before charging it'
        : `This invoice is ${row.invoice_status}, so it cannot be charged`,
    );
  }
  const processorCustomerId = gateway.customerColumn ? row[gateway.customerColumn] : null;
  if (!row.payment_method_token || !processorCustomerId) {
    throw badRequest('There is no card on file for this contract');
  }
  // The customer signed for a year of automatic charges, not for ever.
  // Contracts carded before signed authorizations existed have no date.
  if (row.autopay_expires_on && row.autopay_expires_on < new Date().toISOString().slice(0, 10)) {
    throw badRequest(
      `The customer's autopay authorization ended on ${row.autopay_expires_on}. ` +
        'Ask them to add their card again, which renews it for another year.',
    );
  }
  if (row.payment_method_provider && row.payment_method_provider !== gateway.name) {
    throw badRequest(
      `The card on file was saved with ${row.payment_method_provider}, and payments now go ` +
        `through ${gateway.name}. Ask the customer to add their card again.`,
    );
  }

  const outstanding = Number(row.amount_due) - Number(row.amount_paid);
  if (outstanding <= 0) {
    throw conflict('This invoice is already settled');
  }

  const amountMinor = toMinorUnits(outstanding);
  const result = await gateway.charge({
    processor_customer_id: processorCustomerId,
    payment_method: row.payment_method_token,
    amount_minor: amountMinor,
    description: `Snow clearing — ${row.address_line1}`,
    // Keyed on the invoice and what it owed: retrying the same charge is a
    // no-op at the processor, while a genuinely different balance is a
    // genuinely different charge.
    idempotency_key: `invoice:${invoiceId}:${amountMinor}`,
    metadata: { avcrm_invoice_id: invoiceId, avcrm_branch_id: row.branch_id },
  });

  return recordPayment(
    invoiceId,
    scope,
    {
      amount: Number(fromMinorUnits(amountMinor)),
      method: 'card_on_file',
      provider_transaction_id: result.transaction_id,
      provider: gateway.name,
      status: result.status,
      failure_reason: result.failure_reason,
    },
    actor,
    db,
  );
}

/**
 * Brings a payment into line with what the processor says asynchronously.
 * Idempotent by design: it is keyed on the processor's own transaction id and
 * does nothing when the state already matches, so a replayed webhook is
 * harmless.
 */
export async function reconcilePayment(
  transactionId: string,
  status: Extract<PaymentStatus, 'succeeded' | 'failed' | 'refunded'>,
  failureReason: string | null,
  db: Knex = defaultDb,
): Promise<void> {
  const payment = await db('payments')
    .where({ provider_transaction_id: transactionId })
    .first();

  if (!payment) {
    logger.warn({ transactionId, status }, 'Webhook for a payment we never recorded');
    return;
  }
  if (payment.status === status) return;

  await db.transaction(async (trx) => {
    await trx('payments')
      .where({ id: payment.id })
      .update({
        status,
        failure_reason: status === 'failed' ? (failureReason ?? 'Declined') : null,
        processed_at: payment.processed_at ?? new Date(),
      });

    await recomputeInvoiceTotals(payment.invoice_id, trx);
  });

  logger.info(
    { payment_id: payment.id, from: payment.status, to: status },
    'Payment reconciled from a webhook',
  );
}
