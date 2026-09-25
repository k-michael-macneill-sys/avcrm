import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { Property } from '../types/models';
import { badRequest, conflict, notFound } from '../utils/errors';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { isPgError, PG_FK_VIOLATION, PG_UNIQUE_VIOLATION } from '../utils/pg';
import { applyBranchScope } from '../utils/scope';

/**
 * These two expressions must stay identical to the ones in the
 * properties_normalized_address_unique index, or the duplicate pre-check and
 * the database will disagree.
 */
const NORMALIZED_POSTAL = "upper(regexp_replace(properties.postal_code, '\\s+', '', 'g'))";
const NORMALIZED_LINE1 =
  "lower(regexp_replace(btrim(properties.address_line1), '\\s+', ' ', 'g'))";

export interface PropertyFilters {
  customer_id?: string;
  priority_flag?: boolean;
  search?: string;
}

export interface PropertyInput {
  address_line1: string;
  address_line2: string | null;
  city: string;
  province: string;
  postal_code: string;
  latitude: number | null;
  longitude: number | null;
  driveway_size_cars: number | null;
  access_notes: string | null;
  priority_flag: boolean;
}

/** Properties are scoped through their customer's branch. */
function scoped(db: Knex, scope: BranchScope) {
  return applyBranchScope(
    db('properties').join('customers', 'customers.id', 'properties.customer_id'),
    'customers.branch_id',
    scope,
  );
}

export async function listProperties(
  scope: BranchScope,
  filters: PropertyFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<Property>> {
  const base = scoped(db, scope);

  if (filters.customer_id) base.andWhere('properties.customer_id', filters.customer_id);
  if (filters.priority_flag !== undefined) {
    base.andWhere('properties.priority_flag', filters.priority_flag);
  }
  if (filters.search) {
    const like = `%${filters.search.trim()}%`;
    base.andWhere((qb) => {
      qb.whereILike('properties.address_line1', like)
        .orWhereILike('properties.city', like)
        .orWhereILike('properties.postal_code', like);
    });
  }

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        // Priority properties first — medical and mobility needs get serviced
        // before anything else, so they lead every list the crews see.
        { column: 'properties.priority_flag', order: 'desc' },
        { column: 'properties.created_at', order: 'desc' },
        { column: 'properties.id', order: 'desc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('properties.*'),
    base.clone().count<{ count: string }[]>({ count: 'properties.id' }).first(),
  ]);

  return paginated(rows as Property[], Number(countRow?.count ?? 0), pagination);
}

export async function getProperty(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<Property> {
  const property = await scoped(db, scope)
    .andWhere('properties.id', id)
    .first('properties.*');
  if (!property) {
    throw notFound('Property not found');
  }
  return property as Property;
}

/**
 * What a rep sees when an address is already on the books. Cross-branch hits
 * are the whole point of the check, so the branch is always named; the
 * customer is only identified when the caller can already see that branch.
 */
export interface DuplicateWarning {
  property_id: string;
  branch_id: string;
  branch_name: string;
  in_your_scope: boolean;
  customer_id?: string;
  customer_name?: string;
}

interface DuplicateRow {
  property_id: string;
  customer_id: string;
  first_name: string;
  last_name: string;
  branch_id: string;
  branch_name: string;
}

export async function findDuplicateAddress(
  postalCode: string,
  addressLine1: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<DuplicateWarning | null> {
  const row = (await db('properties')
    .join('customers', 'customers.id', 'properties.customer_id')
    .join('branches', 'branches.id', 'customers.branch_id')
    .whereRaw(`${NORMALIZED_POSTAL} = upper(regexp_replace(?, '\\s+', '', 'g'))`, [
      postalCode,
    ])
    .andWhereRaw(`${NORMALIZED_LINE1} = lower(regexp_replace(btrim(?), '\\s+', ' ', 'g'))`, [
      addressLine1,
    ])
    .first([
      'properties.id as property_id',
      'customers.id as customer_id',
      'customers.first_name',
      'customers.last_name',
      'customers.branch_id',
      'branches.name as branch_name',
    ])) as DuplicateRow | undefined;

  if (!row) return null;

  const inScope = scope.kind === 'all' || scope.branchId === row.branch_id;

  return {
    property_id: row.property_id,
    branch_id: row.branch_id,
    branch_name: row.branch_name,
    in_your_scope: inScope,
    ...(inScope
      ? {
          customer_id: row.customer_id,
          customer_name: `${row.first_name} ${row.last_name}`,
        }
      : {}),
  };
}

export async function createProperty(
  customerId: string,
  scope: BranchScope,
  input: PropertyInput,
  db: Knex = defaultDb,
): Promise<Property> {
  const customer = await applyBranchScope(db('customers'), 'branch_id', scope)
    .andWhere({ id: customerId })
    .first('id');
  if (!customer) {
    throw badRequest('customer_id does not match a customer you can access');
  }

  // Checked before the insert rather than after it fails: this runs inside
  // other transactions (a deal, a lead from the map), and after a failed
  // statement Postgres refuses every query until rollback — including the
  // one that would say who already has the address.
  const existing = await findDuplicateAddress(input.postal_code, input.address_line1, scope, db);
  if (existing) {
    throw conflict('That address is already on the books', existing);
  }

  try {
    const [property] = await db('properties')
      .insert({ customer_id: customerId, ...normalize(input) })
      .returning('*');
    if (!property) {
      throw new Error('Insert returned no property row');
    }
    return property;
  } catch (err) {
    // Two reps signing the same house at the same moment: the index is the
    // backstop the check above cannot be.
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict('That address is already on the books');
    }
    throw err;
  }
}

export async function updateProperty(
  id: string,
  scope: BranchScope,
  input: Partial<PropertyInput>,
  db: Knex = defaultDb,
): Promise<Property> {
  const patch = normalize(input);
  if (Object.keys(patch).length === 0) {
    throw badRequest('No updatable fields were provided');
  }

  // Confirm visibility first: the update itself cannot join to customers.
  await getProperty(id, scope, db);

  try {
    const [property] = await db('properties').where({ id }).update(patch).returning('*');
    if (!property) {
      throw notFound('Property not found');
    }
    return property;
  } catch (err) {
    if (isPgError(err, PG_UNIQUE_VIOLATION)) {
      throw conflict('That address is already on the books');
    }
    throw err;
  }
}

export async function deleteProperty(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<void> {
  await getProperty(id, scope, db);
  try {
    await db('properties').where({ id }).delete();
  } catch (err) {
    // contracts.property_id is RESTRICT: a signed address stays on the books.
    if (isPgError(err, PG_FK_VIOLATION)) {
      throw conflict('That address has a contract on it, so it cannot be deleted');
    }
    throw err;
  }
}

function normalize<T extends Partial<PropertyInput>>(input: T): Record<string, unknown> {
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
  return out;
}
