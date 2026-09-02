import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { ContractStatus, Customer } from '../types/models';
import { badRequest, conflict, notFound } from '../utils/errors';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';

export interface CustomerFilters {
  contract_status?: ContractStatus;
  /** Case-insensitive match against name, email, address or phone. */
  search?: string;
}

export interface CustomerInput {
  name: string;
  phone: string | null;
  address: string | null;
  email: string | null;
  contract_status: ContractStatus;
}

/**
 * All reads are scoped to a single branch. The caller (route) decides which
 * branch that is via resolveBranchScope, so services never look at req.
 */
export async function listCustomers(
  branchId: string,
  filters: CustomerFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<Customer>> {
  const base = db('customers').where({ branch_id: branchId });

  if (filters.contract_status) {
    base.andWhere({ contract_status: filters.contract_status });
  }

  if (filters.search) {
    const like = `%${filters.search.trim()}%`;
    base.andWhere((qb) => {
      qb.whereILike('name', like)
        .orWhereILike('email', like)
        .orWhereILike('address', like)
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
  branchId: string,
  db: Knex = defaultDb,
): Promise<Customer> {
  const customer = await db('customers').where({ id, branch_id: branchId }).first();
  if (!customer) {
    throw notFound('Customer not found');
  }
  return customer;
}

export async function createCustomer(
  branchId: string,
  input: CustomerInput,
  db: Knex = defaultDb,
): Promise<Customer> {
  const branch = await db('branches').where({ id: branchId }).first('id');
  if (!branch) {
    throw badRequest('branch_id does not match an existing branch');
  }

  try {
    const [customer] = await db('customers')
      .insert({ branch_id: branchId, ...normalize(input) })
      .returning('*');
    if (!customer) {
      throw new Error('Insert returned no customer row');
    }
    return customer;
  } catch (err) {
    throw translateUniqueViolation(err);
  }
}

export async function updateCustomer(
  id: string,
  branchId: string,
  input: Partial<CustomerInput>,
  db: Knex = defaultDb,
): Promise<Customer> {
  const patch = normalize(input);
  if (Object.keys(patch).length === 0) {
    throw badRequest('No updatable fields were provided');
  }

  try {
    const [customer] = await db('customers')
      .where({ id, branch_id: branchId })
      .update(patch)
      .returning('*');
    if (!customer) {
      throw notFound('Customer not found');
    }
    return customer;
  } catch (err) {
    throw translateUniqueViolation(err);
  }
}

export async function deleteCustomer(
  id: string,
  branchId: string,
  db: Knex = defaultDb,
): Promise<void> {
  const openJobs = await db('jobs')
    .where({ customer_id: id })
    .whereNotIn('status', ['completed', 'cancelled'])
    .first('id');
  if (openJobs) {
    throw conflict('Customer has jobs that are not completed or cancelled');
  }

  let deleted: number;
  try {
    deleted = await db('customers').where({ id, branch_id: branchId }).delete();
  } catch (err) {
    // Payments reference customers with ON DELETE RESTRICT: billing history is
    // never removed as a side effect of deleting a customer.
    if (isPgError(err, '23503')) {
      throw conflict('Customer has payment history and cannot be deleted');
    }
    throw err;
  }

  if (deleted === 0) {
    throw notFound('Customer not found');
  }
}

/** Trims strings and turns empty strings into NULLs, leaving absent keys absent. */
function normalize<T extends Partial<CustomerInput>>(input: T): T {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue;
    if (typeof value === 'string') {
      const trimmed = key === 'email' ? value.trim().toLowerCase() : value.trim();
      out[key] = trimmed === '' ? null : trimmed;
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

function translateUniqueViolation(err: unknown): unknown {
  if (isPgError(err, '23505')) {
    return conflict('Another customer in this branch already uses that email');
  }
  return err;
}

function isPgError(err: unknown, code: string): boolean {
  return (
    typeof err === 'object' && err !== null && (err as { code?: string }).code === code
  );
}
