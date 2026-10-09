import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { Customer, CustomerStatus, PreferredContact } from '../types/models';
import { badRequest, conflict, notFound } from '../utils/errors';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import {
  isPgError,
  PG_CHECK_VIOLATION,
  PG_FK_VIOLATION,
  PG_UNIQUE_VIOLATION,
} from '../utils/pg';
import { applyBranchScope } from '../utils/scope';

export interface CustomerFilters {
  status?: CustomerStatus;
  created_by_user_id?: string;
  /** Case-insensitive match against name, email or phone. */
  search?: string;
}

export interface CustomerInput {
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  preferred_contact: PreferredContact;
  notes: string | null;
  status: CustomerStatus;
  /** Where bills go, when that is not the service address. */
  billing_address_line1?: string | null;
  billing_address_line2?: string | null;
  billing_city?: string | null;
  billing_province?: string | null;
  billing_postal_code?: string | null;
}

export async function listCustomers(
  scope: BranchScope,
  filters: CustomerFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<Customer>> {
  const base = applyBranchScope(db('customers'), 'branch_id', scope);

  if (filters.status) {
    base.andWhere({ status: filters.status });
  }
  if (filters.created_by_user_id) {
    base.andWhere({ created_by_user_id: filters.created_by_user_id });
  }
  if (filters.search) {
    const like = `%${filters.search.trim()}%`;
    base.andWhere((qb) => {
      qb.whereILike('first_name', like)
        .orWhereILike('last_name', like)
        .orWhereRaw("(first_name || ' ' || last_name) ilike ?", [like])
        .orWhereILike('email', like)
        .orWhereILike('phone', like);
    });
  }

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('*'),
    base.clone().count<{ count: string }[]>({ count: '*' }).first(),
  ]);

  return paginated(rows, Number(countRow?.count ?? 0), pagination);
}

export async function getCustomer(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<Customer> {
  const customer = await applyBranchScope(db('customers'), 'branch_id', scope)
    .andWhere({ id })
    .first();
  if (!customer) {
    throw notFound('Customer not found');
  }
  return customer;
}

export async function createCustomer(
  branchId: string,
  createdByUserId: string,
  input: CustomerInput,
  db: Knex = defaultDb,
): Promise<Customer> {
  const branch = await db('branches').where({ id: branchId }).first('id');
  if (!branch) {
    throw badRequest('branch_id does not match an existing branch');
  }

  try {
    const [customer] = await db('customers')
      .insert({
        branch_id: branchId,
        created_by_user_id: createdByUserId,
        ...normalize(input),
      })
      .returning('*');
    if (!customer) {
      throw new Error('Insert returned no customer row');
    }
    await syncPrimaryPhone(customer.id, customer.phone, db);
    return customer;
  } catch (err) {
    throw translate(err);
  }
}

export async function updateCustomer(
  id: string,
  scope: BranchScope,
  input: Partial<CustomerInput>,
  db: Knex = defaultDb,
): Promise<Customer> {
  const patch = normalize(input);
  if (Object.keys(patch).length === 0) {
    throw badRequest('No updatable fields were provided');
  }

  try {
    const [customer] = await applyBranchScope(db('customers'), 'branch_id', scope)
      .andWhere({ id })
      .update(patch)
      .returning('*');
    if (!customer) {
      throw notFound('Customer not found');
    }
    if (patch.phone !== undefined) await syncPrimaryPhone(customer.id, customer.phone, db);
    return customer;
  } catch (err) {
    throw translate(err);
  }
}

/**
 * customers.phone is the primary number in customer_phones, kept in step
 * from either side: a phone set here becomes (or replaces) the primary.
 */
async function syncPrimaryPhone(customerId: string, phone: string | null, db: Knex): Promise<void> {
  const primary = await db('customer_phones').where({ customer_id: customerId, is_primary: true }).first('id');
  if (!phone) {
    if (primary) await db('customer_phones').where({ id: primary.id }).del();
  } else if (primary) {
    await db('customer_phones').where({ id: primary.id }).update({ number: phone });
  } else {
    await db('customer_phones').insert({ customer_id: customerId, number: phone, phone_type: 'mobile', is_primary: true });
  }
}


/** Trims strings and turns empty strings into NULLs, leaving absent keys absent. */
function normalize<T extends Partial<CustomerInput>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      const trimmed = value.trim();
      out[key] = trimmed === '' ? null : trimmed;
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function translate(err: unknown): unknown {
  if (isPgError(err, PG_UNIQUE_VIOLATION)) {
    return conflict('That customer already exists in this branch');
  }
  if (isPgError(err, PG_CHECK_VIOLATION)) {
    // The only check a caller can realistically trip is the contactable one.
    return badRequest(
      'The preferred contact method needs a matching email or phone on file',
    );
  }
  return err;
}
