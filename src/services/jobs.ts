import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { Job, JobStatus } from '../types/models';
import { badRequest, notFound } from '../utils/errors';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';

export interface JobFilters {
  status?: JobStatus;
  customer_id?: string;
  /** ISO timestamps bounding scheduled_date. */
  scheduled_from?: string;
  scheduled_to?: string;
}

export interface JobInput {
  customer_id: string;
  status: JobStatus;
  scheduled_date: string | null;
  notes: string | null;
}

export async function listJobs(
  branchId: string,
  filters: JobFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<Job>> {
  const base = db('jobs').where({ branch_id: branchId });

  if (filters.status) base.andWhere({ status: filters.status });
  if (filters.customer_id) base.andWhere({ customer_id: filters.customer_id });
  if (filters.scheduled_from) base.andWhere('scheduled_date', '>=', filters.scheduled_from);
  if (filters.scheduled_to) base.andWhere('scheduled_date', '<=', filters.scheduled_to);

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'scheduled_date', order: 'asc', nulls: 'last' },
        { column: 'id', order: 'asc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('*'),
    base.clone().count<{ count: string }[]>({ count: '*' }).first(),
  ]);

  return paginated(rows, Number(countRow?.count ?? 0), pagination);
}

export async function getJob(
  id: string,
  branchId: string,
  db: Knex = defaultDb,
): Promise<Job> {
  const job = await db('jobs').where({ id, branch_id: branchId }).first();
  if (!job) {
    throw notFound('Job not found');
  }
  return job;
}

export async function createJob(
  branchId: string,
  input: JobInput,
  db: Knex = defaultDb,
): Promise<Job> {
  const customer = await db('customers')
    .where({ id: input.customer_id, branch_id: branchId })
    .first('id');
  if (!customer) {
    throw badRequest('customer_id does not match a customer in this branch');
  }

  // The DB check constraint requires completed jobs to carry a completed_date.
  const completed_date = input.status === 'completed' ? new Date() : null;

  const [job] = await db('jobs')
    .insert({
      branch_id: branchId,
      customer_id: input.customer_id,
      status: input.status,
      scheduled_date: input.scheduled_date ? new Date(input.scheduled_date) : null,
      completed_date,
      notes: input.notes,
    })
    .returning('*');

  if (!job) {
    throw new Error('Insert returned no job row');
  }
  return job;
}

export async function updateJobStatus(
  id: string,
  branchId: string,
  status: JobStatus,
  db: Knex = defaultDb,
): Promise<Job> {
  const [job] = await db('jobs')
    .where({ id, branch_id: branchId })
    .update({
      status,
      completed_date: status === 'completed' ? new Date() : null,
    })
    .returning('*');

  if (!job) {
    throw notFound('Job not found');
  }
  return job;
}
