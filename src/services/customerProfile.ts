import { timingSafeEqual } from 'node:crypto';
import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { Customer, CustomerNote, CustomerPhone, Property } from '../types/models';
import { centsToDecimal, toCents, type NoteKind, type PhoneType } from '../types/serviceAgreement';
import { badRequest, conflict, notFound, unauthorized } from '../utils/errors';
import { logger } from '../utils/logger';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { isPgError, PG_CHECK_VIOLATION } from '../utils/pg';
import { applyBranchScope } from '../utils/scope';
import { recordAudit, type AuditActor } from './audit';
import { creditBalance } from './credits';

/**
 * Everything the Customer Summary page shows that is not a contract form:
 * the customer's phones, the notes the office and the crews keep on them,
 * their text thread, and their money at a glance.
 */

async function scopedCustomer(id: string, scope: BranchScope, db: Knex): Promise<Customer> {
  const customer = (await applyBranchScope(db('customers'), 'customers.branch_id', scope)
    .andWhere('customers.id', id)
    .first('customers.*')) as Customer | undefined;
  if (!customer) throw notFound('Customer not found');
  return customer;
}

// ── Summary ───────────────────────────────────────────────────────────────

export interface ContractRow {
  /** The contract once signed; until then, the agreement waiting to be. */
  contract_id: string | null;
  quote_id: string;
  agreement: string;
  status: string;
  /** The day it was signed, or the day the agreement was written. */
  signup_date: Date;
  property_id: string;
  address_line1: string;
  pdf_url: string | null;
  agreement_medium: 'electronic' | 'paper' | null;
}

export interface CustomerSummary {
  customer: Customer;
  phones: CustomerPhone[];
  properties: Property[];
  /** The address the page leads with: the active contract's, or the first. */
  service_property_id: string | null;
  contracts: ContractRow[];
  active_contract: ContractRow | null;
  balance: string;
  credit: string;
  payment_method: { brand: string | null; last4: string; provider: string | null } | null;
  sms_assigned_to: { id: string; name: string } | null;
  branch: { id: string; name: string; province: string };
}

export async function getCustomerSummary(id: string, scope: BranchScope, db: Knex = defaultDb): Promise<CustomerSummary> {
  const customer = await scopedCustomer(id, scope, db);

  const [phones, properties, contracts, pending, balanceRow, credit, assignee, branch] = await Promise.all([
    listPhones(id, db),
    db('properties').where({ customer_id: id }).orderBy('created_at') as Promise<Property[]>,
    db('contracts')
      .join('quotes', 'quotes.id', 'contracts.quote_id')
      .join('properties', 'properties.id', 'contracts.property_id')
      .leftJoin('contract_types', 'contract_types.id', 'quotes.contract_type_id')
      .where('contracts.customer_id', id)
      .orderBy('contracts.signed_at', 'desc')
      .select(
        'contracts.id as contract_id',
        'contracts.quote_id',
        'contracts.status',
        'contracts.signed_at',
        'contracts.property_id',
        'contracts.pdf_url',
        'contracts.agreement_medium',
        'contracts.payment_method_last4',
        'contracts.payment_method_brand',
        'contracts.payment_method_provider',
        'properties.address_line1',
        'contract_types.label as type_label',
        'quotes.billing_type',
      ) as Promise<
      {
        contract_id: string;
        quote_id: string;
        status: string;
        signed_at: Date;
        property_id: string;
        pdf_url: string | null;
        agreement_medium: 'electronic' | 'paper';
        payment_method_last4: string | null;
        payment_method_brand: string | null;
        payment_method_provider: string | null;
        address_line1: string;
        type_label: string | null;
        billing_type: string;
      }[]
    >,
    // Agreements written but not signed yet.
    db('quotes')
      .join('properties', 'properties.id', 'quotes.property_id')
      .join('contract_types', 'contract_types.id', 'quotes.contract_type_id')
      .leftJoin('contracts', 'contracts.quote_id', 'quotes.id')
      .where('properties.customer_id', id)
      .whereNotNull('quotes.billing_plan_id')
      .whereNull('contracts.id')
      .whereIn('quotes.status', ['draft', 'presented'])
      .orderBy('quotes.created_at', 'desc')
      .select(
        'quotes.id as quote_id',
        'quotes.created_at',
        'quotes.property_id',
        'properties.address_line1',
        'contract_types.label as type_label',
        'contract_types.agreement_medium',
      ) as Promise<
      {
        quote_id: string;
        created_at: Date;
        property_id: string;
        address_line1: string;
        type_label: string;
        agreement_medium: 'electronic' | 'paper';
      }[]
    >,
    db('invoices')
      .where({ customer_id: id })
      .whereIn('status', ['sent', 'overdue'])
      .select(db.raw('coalesce(sum(amount_due - amount_paid), 0) as owing'))
      .first() as Promise<{ owing: string } | undefined>,
    creditBalance(id, db),
    customer.sms_assigned_user_id
      ? (db('users').where({ id: customer.sms_assigned_user_id }).first('id', 'first_name', 'last_name') as Promise<
          { id: string; first_name: string; last_name: string } | undefined
        >)
      : Promise.resolve(undefined),
    db('branches').where({ id: customer.branch_id }).first('id', 'name', 'province') as Promise<{
      id: string;
      name: string;
      province: string;
    }>,
  ]);

  const rows: ContractRow[] = [
    ...pending.map((p) => ({
      contract_id: null,
      quote_id: p.quote_id,
      agreement: p.type_label,
      status: 'pending_signature',
      signup_date: p.created_at,
      property_id: p.property_id,
      address_line1: p.address_line1,
      pdf_url: null,
      agreement_medium: p.agreement_medium,
    })),
    ...contracts.map((c) => ({
      contract_id: c.contract_id,
      quote_id: c.quote_id,
      // A contract from the older sign-up has no type: name it by its billing.
      agreement:
        c.type_label ?? (c.billing_type === 'seasonal_upfront' ? 'Seasonal (paid upfront)' : 'Seasonal (monthly billing)'),
      status: c.status,
      signup_date: c.signed_at,
      property_id: c.property_id,
      address_line1: c.address_line1,
      pdf_url: c.pdf_url,
      agreement_medium: c.agreement_medium,
    })),
  ];

  const active = contracts.find((c) => c.status === 'active') ?? null;
  const activeRow = active ? (rows.find((r) => r.contract_id === active.contract_id) ?? null) : null;
  const card = contracts.find((c) => c.status === 'active' && c.payment_method_last4) ?? null;

  return {
    customer,
    phones,
    properties,
    service_property_id: active?.property_id ?? pending[0]?.property_id ?? properties[0]?.id ?? null,
    contracts: rows,
    active_contract: activeRow,
    balance: centsToDecimal(toCents(String(balanceRow?.owing ?? '0')) ?? 0),
    credit: centsToDecimal(credit),
    payment_method: card
      ? { brand: card.payment_method_brand, last4: card.payment_method_last4!, provider: card.payment_method_provider }
      : null,
    sms_assigned_to: assignee ? { id: assignee.id, name: `${assignee.first_name} ${assignee.last_name}` } : null,
    branch,
  };
}

// ── Phones ────────────────────────────────────────────────────────────────

export async function listPhones(customerId: string, db: Knex = defaultDb): Promise<CustomerPhone[]> {
  return db('customer_phones')
    .where({ customer_id: customerId })
    .orderBy([{ column: 'is_primary', order: 'desc' }, { column: 'sort_order' }, { column: 'created_at' }]);
}

export interface PhoneInput {
  number: string;
  phone_type: PhoneType;
  is_primary: boolean;
}

/**
 * Replaces the customer's phone list. The primary number is also written to
 * customers.phone, which everything older (texts, the map, the sign-up)
 * still reads.
 */
export async function setPhones(
  customerId: string,
  scope: BranchScope,
  phones: PhoneInput[],
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<CustomerPhone[]> {
  const cleaned = phones
    .map((p) => ({ ...p, number: p.number.trim() }))
    .filter((p) => p.number !== '');
  if (cleaned.filter((p) => p.is_primary).length > 1) throw badRequest('Only one number can be the primary');
  if (cleaned.length && !cleaned.some((p) => p.is_primary)) cleaned[0]!.is_primary = true;

  return db.transaction(async (trx) => {
    const before = await scopedCustomer(customerId, scope, trx);
    await trx('customer_phones').where({ customer_id: customerId }).del();
    if (cleaned.length) {
      await trx('customer_phones').insert(
        cleaned.map((p, i) => ({ customer_id: customerId, ...p, sort_order: i * 10 })),
      );
    }
    const primary = cleaned.find((p) => p.is_primary)?.number ?? null;
    try {
      await trx('customers').where({ id: customerId }).update({ phone: primary });
    } catch (err) {
      if (isPgError(err, PG_CHECK_VIOLATION)) {
        throw badRequest('This customer prefers texts, so they need a phone number. Change their preferred contact first.');
      }
      throw err;
    }
    await recordAudit(
      actor,
      {
        action: 'customer.phones_updated',
        entity_type: 'customer',
        entity_id: customerId,
        before: { phone: before.phone },
        after: { phones: cleaned },
      },
      trx,
    );
    return listPhones(customerId, trx);
  });
}

// ── Notes ─────────────────────────────────────────────────────────────────

export interface NoteRow extends CustomerNote {
  author_name: string | null;
}

export async function listNotes(
  customerId: string,
  scope: BranchScope,
  kind: NoteKind,
  search: string | undefined,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<NoteRow>> {
  await scopedCustomer(customerId, scope, db);
  const base = db('customer_notes')
    .leftJoin('users', 'users.id', 'customer_notes.author_user_id')
    .where({ 'customer_notes.customer_id': customerId, 'customer_notes.kind': kind });
  if (search) {
    base.andWhere((q) =>
      q
        .whereILike('customer_notes.body', `%${search}%`)
        .orWhereRaw("(users.first_name || ' ' || users.last_name) ilike ?", [`%${search}%`]),
    );
  }
  const [rows, count] = await Promise.all([
    base
      .clone()
      .orderBy('customer_notes.created_at', 'desc')
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('customer_notes.*', db.raw("users.first_name || ' ' || users.last_name as author_name")),
    base.clone().count<{ count: string }[]>({ count: 'customer_notes.id' }).first(),
  ]);
  return paginated(rows as NoteRow[], Number(count?.count ?? 0), pagination);
}

export async function addNote(
  customerId: string,
  scope: BranchScope,
  kind: NoteKind,
  body: string,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<CustomerNote> {
  const text = body.trim();
  if (!text) throw badRequest('Write the note first');
  await scopedCustomer(customerId, scope, db);
  const [note] = (await db('customer_notes')
    .insert({ customer_id: customerId, kind, body: text, author_user_id: actor.user_id })
    .returning('*')) as CustomerNote[];
  return note!;
}

// ── Text messages ─────────────────────────────────────────────────────────

export interface SmsThreadEntry {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  /** When it was sent or received, or when it is due to go. */
  at: Date;
  status: string;
  /** Who typed it, for one written by hand. */
  author: string | null;
  scheduled_for: Date | null;
}

export async function smsThread(customerId: string, scope: BranchScope, db: Knex = defaultDb): Promise<SmsThreadEntry[]> {
  await scopedCustomer(customerId, scope, db);
  const [outbound, inbound] = await Promise.all([
    db('message_log')
      .leftJoin('users', 'users.id', 'message_log.sent_by_user_id')
      .where('message_log.customer_id', customerId)
      .andWhere('message_log.channel', 'sms')
      .orderBy('message_log.created_at', 'desc')
      .limit(200)
      .select(
        'message_log.id',
        'message_log.body',
        'message_log.status',
        'message_log.sent_at',
        'message_log.created_at',
        'message_log.send_after',
        db.raw("users.first_name || ' ' || users.last_name as author"),
      ) as Promise<
      {
        id: string;
        body: string;
        status: string;
        sent_at: Date | null;
        created_at: Date;
        send_after: Date | null;
        author: string | null;
      }[]
    >,
    db('sms_inbound').where({ customer_id: customerId }).orderBy('received_at', 'desc').limit(200),
  ]);
  const entries: SmsThreadEntry[] = [
    ...outbound.map((m) => ({
      id: m.id,
      direction: 'outbound' as const,
      body: m.body,
      at: m.sent_at ?? m.send_after ?? m.created_at,
      status: m.status,
      author: m.author,
      scheduled_for: m.status === 'queued' ? m.send_after : null,
    })),
    ...(inbound as { id: string; body: string; received_at: Date }[]).map((m) => ({
      id: m.id,
      direction: 'inbound' as const,
      body: m.body,
      at: m.received_at,
      status: 'received',
      author: null,
      scheduled_for: null,
    })),
  ];
  return entries.sort((a, b) => a.at.getTime() - b.at.getTime());
}

/**
 * A text typed on the customer's page. It goes through the same queue as
 * every other message, so the provider configured in Settings sends it —
 * now, or at the time picked for "send later".
 */
export async function sendCustomerSms(
  customerId: string,
  scope: BranchScope,
  input: { body: string; send_at: Date | null },
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<SmsThreadEntry> {
  const body = input.body.trim();
  if (!body) throw badRequest('Write the message first');
  if (body.length > 1600) throw badRequest('That message is too long to text');
  const customer = await scopedCustomer(customerId, scope, db);
  if (customer.sms_opt_out) throw conflict('This customer has asked not to be texted');
  const phones = await listPhones(customerId, db);
  const to = phones.find((p) => p.is_primary && p.phone_type === 'mobile')?.number
    ?? phones.find((p) => p.phone_type === 'mobile')?.number
    ?? customer.phone;
  if (!to) throw badRequest('This customer has no mobile number to text');
  if (input.send_at && input.send_at.getTime() < Date.now() - 60_000) {
    throw badRequest('Pick a time in the future to send it later');
  }

  const [row] = (await db('message_log')
    .insert({
      branch_id: customer.branch_id,
      customer_id: customerId,
      template_code: 'manual',
      channel: 'sms',
      recipient: to,
      body,
      status: 'queued',
      send_after: input.send_at,
      sent_by_user_id: actor.user_id,
    })
    .returning('*')) as { id: string; body: string; status: string; created_at: Date; send_after: Date | null }[];
  return {
    id: row!.id,
    direction: 'outbound',
    body: row!.body,
    at: row!.send_after ?? row!.created_at,
    status: row!.status,
    author: null,
    scheduled_for: row!.send_after,
  };
}

/** "To Employee": who on staff looks after this customer's texts. Null hands it back. */
export async function assignSmsThread(
  customerId: string,
  scope: BranchScope,
  userId: string | null,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<{ id: string; name: string } | null> {
  const customer = await scopedCustomer(customerId, scope, db);
  let user: { id: string; first_name: string; last_name: string } | undefined;
  if (userId) {
    user = (await db('users')
      .where({ id: userId, is_active: true })
      .andWhere((q) => q.where({ branch_id: customer.branch_id }).orWhereNull('branch_id'))
      .first('id', 'first_name', 'last_name')) as typeof user;
    if (!user) throw badRequest('Choose someone who works in this customer’s branch');
  }
  await db('customers').where({ id: customerId }).update({ sms_assigned_user_id: userId });
  await recordAudit(actor, {
    action: 'customer.sms_assigned',
    entity_type: 'customer',
    entity_id: customerId,
    before: { sms_assigned_user_id: customer.sms_assigned_user_id },
    after: { sms_assigned_user_id: userId },
  });
  return user ? { id: user.id, name: `${user.first_name} ${user.last_name}` } : null;
}

export async function setSmsOptOut(
  customerId: string,
  scope: BranchScope,
  optOut: boolean,
  db: Knex = defaultDb,
): Promise<void> {
  await scopedCustomer(customerId, scope, db);
  await db('customers').where({ id: customerId }).update({ sms_opt_out: optOut });
}

/** The people a thread can be handed to: active staff in the customer's branch, and the office. */
export async function threadAssignees(
  customerId: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<{ id: string; name: string; role: string }[]> {
  const customer = await scopedCustomer(customerId, scope, db);
  const users = (await db('users')
    .where({ is_active: true })
    .andWhere((q) => q.where({ branch_id: customer.branch_id }).orWhereNull('branch_id'))
    .whereNot({ role: 'branch' })
    .orderBy(['first_name', 'last_name'])
    .select('id', 'first_name', 'last_name', 'role')) as {
    id: string;
    first_name: string;
    last_name: string;
    role: string;
  }[];
  return users.map((u) => ({ id: u.id, name: `${u.first_name} ${u.last_name}`, role: u.role }));
}

/** Digits only, without a leading North American 1, for matching a number however it was typed. */
export function phoneKey(number: string): string {
  const digits = number.replace(/\D/g, '');
  return digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
}

export function inboundSecretMatches(given: string | undefined): boolean {
  const expected = config.sms.inboundSecret;
  if (!expected || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * A text a customer sent us, from the provider's inbound webhook. Matched to
 * a customer by phone number; one that matches nobody is still kept. A STOP
 * opts them out, the way carriers require.
 */
export async function recordInboundSms(
  input: { from: string; body: string; provider_message_id: string | null; secret: string | undefined },
  db: Knex = defaultDb,
): Promise<{ customer_id: string | null }> {
  if (!inboundSecretMatches(input.secret)) throw unauthorized('Inbound texts are not accepted without the shared secret');
  const key = phoneKey(input.from);
  if (key.length < 7) throw badRequest('That is not a phone number');

  // Any of their numbers, or the one on the customer row for anyone whose
  // phones were never split out.
  const last10 = key.slice(-10);
  const match = (await db('customers')
    .whereRaw("right(regexp_replace(coalesce(customers.phone, ''), '\\D', '', 'g'), 10) = ?", [last10])
    .orWhereExists(
      db('customer_phones')
        .whereRaw('customer_phones.customer_id = customers.id')
        .andWhereRaw("right(regexp_replace(customer_phones.number, '\\D', '', 'g'), 10) = ?", [last10]),
    )
    .orderBy('customers.updated_at', 'desc')
    .first('customers.id')) as { id: string } | undefined;

  await db('sms_inbound')
    .insert({
      customer_id: match?.id ?? null,
      from_number: input.from,
      body: input.body,
      provider_message_id: input.provider_message_id,
    })
    .onConflict(db.raw('(provider_message_id) where provider_message_id is not null'))
    .ignore();

  if (match && /^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i.test(input.body)) {
    await db('customers').where({ id: match.id }).update({ sms_opt_out: true });
    logger.info({ customer_id: match.id }, 'Customer opted out of texts');
  }
  return { customer_id: match?.id ?? null };
}
