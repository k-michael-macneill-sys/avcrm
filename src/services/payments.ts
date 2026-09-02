import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { Payment, PaymentMethod, PaymentStatus } from '../types/models';
import { badRequest, notFound } from '../utils/errors';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { sendEmail } from './notifications';
import { createCharge } from './paymentGateway';

export interface PaymentFilters {
  customer_id?: string;
  status?: PaymentStatus;
}

export interface PaymentInput {
  customer_id: string;
  amount: number;
  method: PaymentMethod;
  description: string | null;
}

function scoped(db: Knex, branchId: string) {
  return db('payments')
    .join('customers', 'customers.id', 'payments.customer_id')
    .where('customers.branch_id', branchId);
}

export async function listPayments(
  branchId: string,
  filters: PaymentFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<Payment>> {
  const base = scoped(db, branchId);

  if (filters.customer_id) base.andWhere('payments.customer_id', filters.customer_id);
  if (filters.status) base.andWhere('payments.status', filters.status);

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'payments.date', order: 'desc' },
        { column: 'payments.id', order: 'desc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('payments.*'),
    base.clone().count<{ count: string }[]>({ count: 'payments.id' }).first(),
  ]);

  return paginated(rows as Payment[], Number(countRow?.count ?? 0), pagination);
}

export async function getPayment(
  id: string,
  branchId: string,
  db: Knex = defaultDb,
): Promise<Payment> {
  const payment = await scoped(db, branchId).andWhere('payments.id', id).first('payments.*');
  if (!payment) {
    throw notFound('Payment not found');
  }
  return payment as Payment;
}

/**
 * Card and ACH go through the (mocked) gateway. Cash and cheque are recorded
 * as already settled — there is nothing to call out to.
 */
export async function recordPayment(
  branchId: string,
  input: PaymentInput,
  db: Knex = defaultDb,
): Promise<Payment> {
  const customer = await db('customers')
    .where({ id: input.customer_id, branch_id: branchId })
    .first(['id', 'email', 'name']);
  if (!customer) {
    throw badRequest('customer_id does not match a customer in this branch');
  }

  let status: PaymentStatus = 'succeeded';
  let reference: string | null = null;

  if (input.method === 'card' || input.method === 'ach') {
    const charge = await createCharge({
      amount: input.amount,
      currency: 'usd',
      customer_id: input.customer_id,
      description: input.description ?? undefined,
    });
    status = charge.status === 'succeeded' ? 'succeeded' : 'failed';
    reference = charge.id;
  }

  const [payment] = await db('payments')
    .insert({
      customer_id: input.customer_id,
      amount: input.amount.toFixed(2),
      method: input.method,
      status,
      reference,
      date: new Date(),
    })
    .returning('*');

  if (!payment) {
    throw new Error('Insert returned no payment row');
  }

  if (status === 'succeeded' && customer.email) {
    await sendEmail(
      customer.email,
      'Payment received',
      `We received $${input.amount.toFixed(2)} from ${customer.name}.`,
    );
  }

  return payment;
}
