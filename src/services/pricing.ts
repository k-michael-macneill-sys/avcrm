import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { BillingType, PricingGuideEntry } from '../types/models';
import { notFound } from '../utils/errors';
import { applyBranchScope } from '../utils/scope';

export interface PricingGuideFilters {
  driveway_size_cars?: number;
  billing_type?: BillingType;
}

export async function listPricingGuide(
  scope: BranchScope,
  filters: PricingGuideFilters,
  db: Knex = defaultDb,
): Promise<PricingGuideEntry[]> {
  const query = applyBranchScope(db('pricing_guide'), 'branch_id', scope);

  if (filters.driveway_size_cars !== undefined) {
    query.andWhere({ driveway_size_cars: filters.driveway_size_cars });
  }
  if (filters.billing_type) {
    query.andWhere({ billing_type: filters.billing_type });
  }

  return query
    .orderBy([
      { column: 'branch_id', order: 'asc' },
      { column: 'billing_type', order: 'asc' },
      { column: 'driveway_size_cars', order: 'asc' },
    ])
    .select('*');
}

/**
 * What the quote screen pre-fills for a property. `suggested_initial_price` is
 * null when the branch has no guide row for that driveway size — the rep
 * prices it by hand, which is always allowed anyway.
 */
export interface PriceSuggestion {
  property_id: string;
  branch_id: string;
  driveway_size_cars: number | null;
  billing_type: BillingType;
  suggested_initial_price: string | null;
}

export async function suggestPrice(
  propertyId: string,
  billingType: BillingType,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<PriceSuggestion> {
  const property = (await applyBranchScope(
    db('properties').join('customers', 'customers.id', 'properties.customer_id'),
    'customers.branch_id',
    scope,
  )
    .andWhere('properties.id', propertyId)
    .first([
      'properties.id',
      'properties.driveway_size_cars',
      'customers.branch_id as branch_id',
    ])) as
    | { id: string; driveway_size_cars: number | null; branch_id: string }
    | undefined;

  if (!property) {
    throw notFound('Property not found');
  }

  const entry =
    property.driveway_size_cars === null
      ? undefined
      : await db('pricing_guide')
          .where({
            branch_id: property.branch_id,
            driveway_size_cars: property.driveway_size_cars,
            billing_type: billingType,
          })
          .first('initial_price');

  return {
    property_id: property.id,
    branch_id: property.branch_id,
    driveway_size_cars: property.driveway_size_cars,
    billing_type: billingType,
    suggested_initial_price: entry?.initial_price ?? null,
  };
}
