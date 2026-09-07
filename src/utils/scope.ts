import type { Knex } from 'knex';
import type { BranchScope } from '../types/auth';

/**
 * Applies a branch scope to a query. `all` (corporate) adds no predicate;
 * `branch` pins the query to one branch. Every branch-scoped read goes
 * through this so the rule lives in one place.
 */
export function applyBranchScope(
  qb: Knex.QueryBuilder,
  column: string,
  scope: BranchScope,
): Knex.QueryBuilder {
  if (scope.kind === 'branch') {
    qb.where(column, scope.branchId);
  }
  return qb;
}
