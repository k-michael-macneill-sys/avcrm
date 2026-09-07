import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { Contract } from '../types/models';
import { badRequest, notFound } from '../utils/errors';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';

export interface ContractFilters {
  customer_id?: string;
  /** Only contracts covering this date (defaults off). */
  active_on?: string;
}

export interface ContractInput {
  customer_id: string;
  price: number;
  start_date: string;
  end_date: string;
  auto_renew: boolean;
  terms: string | null;
}

/** Contracts belong to a customer, so branch scoping goes through a join. */
function scoped(db: Knex, branchId: string) {
  return db('contracts')
    .join('customers', 'customers.id', 'contracts.customer_id')
    .where('customers.branch_id', branchId);
}

export async function listContracts(
  branchId: string,
  filters: ContractFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<Contract>> {
  const base = scoped(db, branchId);

  if (filters.customer_id) base.andWhere('contracts.customer_id', filters.customer_id);
  if (filters.active_on) {
    base
      .andWhere('contracts.start_date', '<=', filters.active_on)
      .andWhere('contracts.end_date', '>=', filters.active_on);
  }

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'contracts.start_date', order: 'desc' },
        { column: 'contracts.id', order: 'desc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('contracts.*'),
    base.clone().count<{ count: string }[]>({ count: 'contracts.id' }).first(),
  ]);

  return paginated(rows as Contract[], Number(countRow?.count ?? 0), pagination);
}

export async function getContract(
  id: string,
  branchId: string,
  db: Knex = defaultDb,
): Promise<Contract> {
  const contract = await scoped(db, branchId)
    .andWhere('contracts.id', id)
    .first('contracts.*');
  if (!contract) {
    throw notFound('Contract not found');
  }
  return contract as Contract;
}

export async function createContract(
  branchId: string,
  input: ContractInput,
  db: Knex = defaultDb,
): Promise<Contract> {
  return db.transaction(async (trx) => {
    const customer = await trx('customers')
      .where({ id: input.customer_id, branch_id: branchId })
      .first('id');
    if (!customer) {
      throw badRequest('customer_id does not match a customer in this branch');
    }

    const [contract] = await trx('contracts')
      .insert({
        customer_id: input.customer_id,
        price: input.price.toFixed(2),
        start_date: input.start_date,
        end_date: input.end_date,
        auto_renew: input.auto_renew,
        terms: input.terms,
      })
      .returning('*');

    if (!contract) {
      throw new Error('Insert returned no contract row');
    }

    // Signing a contract is what makes a customer "active".
    await trx('customers')
      .where({ id: input.customer_id })
      .update({ contract_status: 'active' });

    return contract;
  });
}
