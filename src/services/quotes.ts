import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { BillingType, Quote, QuoteStatus } from '../types/models';
import { badRequest, conflict, notFound } from '../utils/errors';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { isPgError, PG_CHECK_VIOLATION } from '../utils/pg';
import { applyBranchScope } from '../utils/scope';
import { recordAudit, type AuditActor } from './audit';

/**
 * Where a quote may go from where it is. A quote that has been answered stays
 * answered: re-pricing a declined deal means writing a new quote, which keeps
 * the history of what was actually offered.
 */
const TRANSITIONS: Record<QuoteStatus, QuoteStatus[]> = {
  draft: ['presented', 'declined', 'expired'],
  presented: ['accepted', 'declined', 'expired'],
  accepted: [],
  declined: [],
  expired: [],
};

/** Prices can still move while the deal is open, and are frozen after that. */
const EDITABLE_IN: QuoteStatus[] = ['draft', 'presented'];

export interface QuoteFilters {
  property_id?: string;
  customer_id?: string;
  status?: QuoteStatus;
  billing_type?: BillingType;
  created_by_user_id?: string;
}

export interface QuoteInput {
  billing_type: BillingType;
  initial_price: number;
  discounted_price: number;
  season_start: string;
  season_end: string;
  status: QuoteStatus;
  notes: string | null;
}

/** Quotes are scoped through their property's customer's branch. */
function scoped(db: Knex, scope: BranchScope) {
  return applyBranchScope(
    db('quotes')
      .join('properties', 'properties.id', 'quotes.property_id')
      .join('customers', 'customers.id', 'properties.customer_id'),
    'customers.branch_id',
    scope,
  );
}

export async function listQuotes(
  scope: BranchScope,
  filters: QuoteFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<Quote>> {
  const base = scoped(db, scope);

  if (filters.property_id) base.andWhere('quotes.property_id', filters.property_id);
  if (filters.customer_id) base.andWhere('properties.customer_id', filters.customer_id);
  if (filters.status) base.andWhere('quotes.status', filters.status);
  if (filters.billing_type) base.andWhere('quotes.billing_type', filters.billing_type);
  if (filters.created_by_user_id) {
    base.andWhere('quotes.created_by_user_id', filters.created_by_user_id);
  }

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'quotes.created_at', order: 'desc' },
        { column: 'quotes.id', order: 'desc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('quotes.*'),
    base.clone().count<{ count: string }[]>({ count: 'quotes.id' }).first(),
  ]);

  return paginated(rows as Quote[], Number(countRow?.count ?? 0), pagination);
}

export async function getQuote(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<Quote> {
  const quote = await scoped(db, scope).andWhere('quotes.id', id).first('quotes.*');
  if (!quote) {
    throw notFound('Quote not found');
  }
  return quote as Quote;
}

export async function createQuote(
  propertyId: string,
  createdByUserId: string,
  scope: BranchScope,
  input: QuoteInput,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<Quote> {
  const property = await applyBranchScope(
    db('properties').join('customers', 'customers.id', 'properties.customer_id'),
    'customers.branch_id',
    scope,
  )
    .andWhere('properties.id', propertyId)
    .first('properties.id');

  if (!property) {
    throw badRequest('property_id does not match a property you can access');
  }

  return db.transaction(async (trx) => {
    try {
      const [quote] = await trx('quotes')
        .insert({
          property_id: propertyId,
          created_by_user_id: createdByUserId,
          ...priceFields(input),
          season_start: input.season_start,
          season_end: input.season_end,
          status: input.status,
          notes: input.notes,
        })
        .returning('*');
      if (!quote) {
        throw new Error('Insert returned no quote row');
      }

      await recordAudit(
        actor,
        {
          action: 'quote.created',
          entity_type: 'quote',
          entity_id: quote.id,
          after: quote,
        },
        trx,
      );
      return quote;
    } catch (err) {
      throw translate(err);
    }
  });
}

export async function updateQuote(
  id: string,
  scope: BranchScope,
  input: Partial<QuoteInput>,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<Quote> {
  const patch: Record<string, unknown> = { ...priceFields(input) };
  if (input.season_start !== undefined) patch.season_start = input.season_start;
  if (input.season_end !== undefined) patch.season_end = input.season_end;
  if (input.notes !== undefined) patch.notes = input.notes;

  if (Object.keys(patch).length === 0) {
    throw badRequest('No updatable fields were provided');
  }

  return db.transaction(async (trx) => {
    const before = await lock(id, scope, trx);
    if (!EDITABLE_IN.includes(before.status)) {
      throw conflict(
        `This quote is ${before.status}, so it can no longer be re-priced`,
      );
    }

    try {
      const [quote] = await trx('quotes').where({ id }).update(patch).returning('*');
      if (!quote) {
        throw notFound('Quote not found');
      }

      await recordAudit(
        actor,
        {
          action: 'quote.updated',
          entity_type: 'quote',
          entity_id: id,
          before,
          after: quote,
        },
        trx,
      );
      return quote;
    } catch (err) {
      throw translate(err);
    }
  });
}

export async function changeQuoteStatus(
  id: string,
  scope: BranchScope,
  status: QuoteStatus,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<Quote> {
  return db.transaction(async (trx) => {
    const before = await lock(id, scope, trx);
    assertTransition(before.status, status);

    const [quote] = await trx('quotes').where({ id }).update({ status }).returning('*');
    if (!quote) {
      throw notFound('Quote not found');
    }

    await recordAudit(
      actor,
      {
        action: 'quote.status_changed',
        entity_type: 'quote',
        entity_id: id,
        before: { status: before.status },
        after: { status: quote.status },
      },
      trx,
    );
    return quote;
  });
}

/** Only an unsent draft can be thrown away; anything presented is history. */
export async function deleteQuote(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<void> {
  const quote = await getQuote(id, scope, db);
  if (quote.status !== 'draft') {
    throw conflict(`Only a draft quote can be deleted (this one is ${quote.status})`);
  }
  await db('quotes').where({ id }).delete();
}

/**
 * Reads a quote inside a transaction and holds it until commit, so two reps
 * cannot move the same quote at once. `of quotes` keeps the lock off the
 * joined customer and property rows.
 */
export async function lock(
  id: string,
  scope: BranchScope,
  trx: Knex.Transaction,
): Promise<Quote> {
  const quote = await scoped(trx, scope)
    .andWhere('quotes.id', id)
    .forUpdate('quotes')
    .first('quotes.*');
  if (!quote) {
    throw notFound('Quote not found');
  }
  return quote as Quote;
}

export function assertTransition(from: QuoteStatus, to: QuoteStatus): void {
  if (from === to) {
    throw conflict(`The quote is already ${to}`);
  }
  if (!TRANSITIONS[from].includes(to)) {
    const allowed = TRANSITIONS[from];
    throw conflict(
      allowed.length === 0
        ? `This quote is ${from}, which is final and cannot be changed`
        : `This quote is ${from}, so it can only move to ${allowed.join(' or ')}`,
    );
  }
}

/**
 * Money reaches the database as a fixed 2-decimal string. JSON gives us a
 * float; rounding it here means no binary fraction ever lands in numeric.
 */
function priceFields(input: Partial<QuoteInput>): Record<string, string> {
  const out: Record<string, string> = {};
  if (input.billing_type !== undefined) out.billing_type = input.billing_type;
  if (input.initial_price !== undefined) {
    out.initial_price = input.initial_price.toFixed(2);
  }
  if (input.discounted_price !== undefined) {
    out.discounted_price = input.discounted_price.toFixed(2);
  }
  return out;
}

function translate(err: unknown): unknown {
  if (isPgError(err, PG_CHECK_VIOLATION)) {
    const constraint = (err as { constraint?: string }).constraint;
    if (constraint === 'quotes_discount_check') {
      return badRequest('discounted_price cannot be higher than initial_price');
    }
    if (constraint === 'quotes_season_check') {
      return badRequest('season_end must fall after season_start');
    }
  }
  return err;
}
