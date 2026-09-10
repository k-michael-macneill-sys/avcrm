import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import { applyBranchScope } from '../utils/scope';

/**
 * Roll-up reporting. Corporate sees every branch, which is the cross-branch
 * comparison; narrowing to one with ?branch_id= gives that branch's own
 * roll-up. Same query either way — the scope is the only difference.
 *
 * Two things worth being straight about:
 *
 * 1. This is a revenue roll-up, not a P&L. Nothing in the schema records a
 *    cost — no operator pay, no fuel, no salt, no vehicle. A margin computed
 *    here would be a number we made up, so there isn't one. Costs need their
 *    own tables before the other half of a P&L can exist.
 *
 * 2. Every figure is built from a handful of grouped aggregates, one per
 *    domain, stitched together in TypeScript. That is deliberately not one
 *    enormous CTE: each query below can be read, run and checked on its own,
 *    and the count stays flat however many branches there are.
 *
 * Which date each metric is filtered on differs by domain, because the
 * question differs. It is named on each query and documented in the README.
 */

export interface ReportWindow {
  /** Inclusive YYYY-MM-DD. */
  from?: string;
  /** Inclusive YYYY-MM-DD. */
  to?: string;
}

export interface BranchSummary {
  branch_id: string;
  branch_name: string;
  province: string;
  customers: {
    total: number;
    lead: number;
    active: number;
    churned: number;
  };
  pipeline: {
    quotes: number;
    draft: number;
    presented: number;
    accepted: number;
    declined: number;
    expired: number;
    /** Accepted as a share of answered quotes. Null while none are answered. */
    win_rate: number | null;
  };
  contracts: {
    active: number;
    cancelled: number;
    completed: number;
  };
  revenue: {
    invoiced: string;
    collected: string;
    outstanding: string;
    overdue: string;
    invoices: number;
  };
  service: {
    scheduled: number;
    completed: number;
    skipped: number;
  };
  reviews: {
    asked: number;
    answered: number;
    average_rating: number | null;
    /** Answers of 4 or 5, the ones sent to the public review page. */
    promoters: number;
  };
  crew: {
    approved: number;
    pending: number;
    suspended: number;
  };
}

export async function branchSummary(
  scope: BranchScope,
  window: ReportWindow,
  db: Knex = defaultDb,
): Promise<BranchSummary[]> {
  // The skeleton comes from branches, not from activity, so a branch that
  // sold nothing this month shows as zeroes instead of vanishing from the
  // comparison.
  const branches = (await applyBranchScope(db('branches'), 'id', scope)
    .orderBy('name', 'asc')
    .select('id', 'name', 'province')) as {
    id: string;
    name: string;
    province: string;
  }[];

  if (branches.length === 0) return [];
  const ids = branches.map((branch) => branch.id);

  const [customers, quotes, contracts, revenue, service, reviews, crew] =
    await Promise.all([
      customerCounts(ids, window, db),
      quoteCounts(ids, window, db),
      contractCounts(ids, window, db),
      revenueTotals(ids, window, db),
      serviceCounts(ids, window, db),
      reviewTotals(ids, window, db),
      crewCounts(ids, db),
    ]);

  return branches.map((branch) => {
    const quote = quotes.get(branch.id) ?? {};
    const answered =
      (quote.accepted ?? 0) + (quote.declined ?? 0) + (quote.expired ?? 0);
    const customer = customers.get(branch.id) ?? {};
    const contract = contracts.get(branch.id) ?? {};
    const visits = service.get(branch.id) ?? {};
    const money = revenue.get(branch.id);
    const review = reviews.get(branch.id);
    const operators = crew.get(branch.id) ?? {};

    return {
      branch_id: branch.id,
      branch_name: branch.name,
      province: branch.province,
      customers: {
        total: (customer.lead ?? 0) + (customer.active ?? 0) + (customer.churned ?? 0),
        lead: customer.lead ?? 0,
        active: customer.active ?? 0,
        churned: customer.churned ?? 0,
      },
      pipeline: {
        quotes:
          (quote.draft ?? 0) +
          (quote.presented ?? 0) +
          (quote.accepted ?? 0) +
          (quote.declined ?? 0) +
          (quote.expired ?? 0),
        draft: quote.draft ?? 0,
        presented: quote.presented ?? 0,
        accepted: quote.accepted ?? 0,
        declined: quote.declined ?? 0,
        expired: quote.expired ?? 0,
        // Open quotes are not losses yet, so they stay out of the
        // denominator: this is accepted over answered, not over sent.
        win_rate: answered === 0 ? null : round((quote.accepted ?? 0) / answered, 4),
      },
      contracts: {
        active: contract.active ?? 0,
        cancelled: contract.cancelled ?? 0,
        completed: contract.completed ?? 0,
      },
      revenue: {
        invoiced: money?.invoiced ?? '0.00',
        collected: money?.collected ?? '0.00',
        outstanding: money?.outstanding ?? '0.00',
        overdue: money?.overdue ?? '0.00',
        invoices: money?.invoices ?? 0,
      },
      service: {
        scheduled: visits.scheduled ?? 0,
        completed: visits.completed ?? 0,
        skipped: visits.skipped ?? 0,
      },
      reviews: {
        asked: review?.asked ?? 0,
        answered: review?.answered ?? 0,
        average_rating: review?.average_rating ?? null,
        promoters: review?.promoters ?? 0,
      },
      crew: {
        approved: operators.approved ?? 0,
        pending: (operators.pending ?? 0) + (operators.docs_submitted ?? 0),
        suspended: operators.suspended ?? 0,
      },
    };
  });
}

type CountsByStatus = Map<string, Record<string, number>>;

/** Turns (branch_id, status, count) rows into a lookup. */
function tally(rows: { branch_id: string; status: string; count: string }[]): CountsByStatus {
  const out: CountsByStatus = new Map();
  for (const row of rows) {
    const branch = out.get(row.branch_id) ?? {};
    branch[row.status] = Number(row.count);
    out.set(row.branch_id, branch);
  }
  return out;
}

/** Customers are counted by when the rep first put them on the books. */
async function customerCounts(
  ids: string[],
  window: ReportWindow,
  db: Knex,
): Promise<CountsByStatus> {
  const query = db('customers')
    .whereIn('branch_id', ids)
    .groupBy('branch_id', 'status')
    .select('branch_id', 'status')
    .count({ count: '*' });

  applyStampWindow(query, 'created_at', window);
  return tally((await query) as never);
}

/** Quotes are counted by when they were written. */
async function quoteCounts(
  ids: string[],
  window: ReportWindow,
  db: Knex,
): Promise<CountsByStatus> {
  const query: Knex.QueryBuilder = db('quotes')
    .join('properties', 'properties.id', 'quotes.property_id')
    .join('customers', 'customers.id', 'properties.customer_id');

  query
    .whereIn('customers.branch_id', ids)
    .groupBy('customers.branch_id', 'quotes.status')
    .select('customers.branch_id as branch_id', 'quotes.status as status')
    .count({ count: 'quotes.id' });

  applyStampWindow(query, 'quotes.created_at', window);
  return tally((await query) as never);
}

/** Contracts are counted by when they were signed. */
async function contractCounts(
  ids: string[],
  window: ReportWindow,
  db: Knex,
): Promise<CountsByStatus> {
  const query: Knex.QueryBuilder = db('contracts').join(
    'customers',
    'customers.id',
    'contracts.customer_id',
  );

  query
    .whereIn('customers.branch_id', ids)
    .groupBy('customers.branch_id', 'contracts.status')
    .select('customers.branch_id as branch_id', 'contracts.status as status')
    .count({ count: 'contracts.id' });

  applyStampWindow(query, 'contracts.signed_at', window);
  return tally((await query) as never);
}

/** Visits are counted by the day they were on the board for. */
async function serviceCounts(
  ids: string[],
  window: ReportWindow,
  db: Knex,
): Promise<CountsByStatus> {
  const query = db('work_orders')
    .whereIn('branch_id', ids)
    .groupBy('branch_id', 'status')
    .select('branch_id', 'status')
    .count({ count: '*' });

  applyStampWindow(query, 'scheduled_for', window);
  return tally((await query) as never);
}

/** Operators as they stand today. A head count has no date window. */
async function crewCounts(ids: string[], db: Knex): Promise<CountsByStatus> {
  const rows = await db('users')
    .whereIn('branch_id', ids)
    .andWhere({ role: 'operator', is_active: true })
    .groupBy('branch_id', 'onboarding_status')
    .select('branch_id', 'onboarding_status as status')
    .count({ count: '*' });

  return tally(rows as never);
}

interface RevenueRow {
  branch_id: string;
  invoiced: string;
  collected: string;
  outstanding: string;
  overdue: string;
  invoices: number;
}

/**
 * Money, by the period it belongs to rather than the day the invoice row was
 * written — so January's revenue is January's work, whenever it was billed.
 *
 * Void invoices are excluded from every figure: a cancelled bill is not
 * revenue that went missing, it is a bill that never existed.
 */
async function revenueTotals(
  ids: string[],
  window: ReportWindow,
  db: Knex,
): Promise<Map<string, RevenueRow>> {
  const query = db('invoices')
    .whereIn('branch_id', ids)
    .groupBy('branch_id')
    .select('branch_id')
    .select(
      db.raw(`coalesce(sum(amount_due) filter (where status <> 'void'), 0) as invoiced`),
      db.raw(`coalesce(sum(amount_paid) filter (where status <> 'void'), 0) as collected`),
      db.raw(
        `coalesce(sum(amount_due - amount_paid) filter (where status in ('sent', 'overdue')), 0) as outstanding`,
      ),
      db.raw(
        `coalesce(sum(amount_due - amount_paid) filter (where status = 'overdue'), 0) as overdue`,
      ),
      db.raw(`count(*) filter (where status <> 'void') as invoices`),
    );

  applyDateWindow(query, 'billing_period_start', window);

  const rows = (await query) as unknown as Record<string, string>[];
  const out = new Map<string, RevenueRow>();

  for (const row of rows) {
    out.set(row.branch_id as string, {
      branch_id: row.branch_id as string,
      invoiced: money(row.invoiced),
      collected: money(row.collected),
      outstanding: money(row.outstanding),
      overdue: money(row.overdue),
      invoices: Number(row.invoices),
    });
  }
  return out;
}

interface ReviewRow {
  asked: number;
  answered: number;
  average_rating: number | null;
  promoters: number;
}

/** Reviews are counted by when we asked, not when they got round to it. */
async function reviewTotals(
  ids: string[],
  window: ReportWindow,
  db: Knex,
): Promise<Map<string, ReviewRow>> {
  const query = db('review_requests')
    .whereIn('branch_id', ids)
    .groupBy('branch_id')
    .select('branch_id')
    .select(
      db.raw('count(*) as asked'),
      db.raw('count(rating_response) as answered'),
      db.raw('avg(rating_response) as average_rating'),
      db.raw('count(*) filter (where rating_response >= 4) as promoters'),
    );

  applyStampWindow(query, 'sent_at', window);

  const rows = (await query) as unknown as Record<string, string | null>[];
  const out = new Map<string, ReviewRow>();

  for (const row of rows) {
    out.set(row.branch_id as string, {
      asked: Number(row.asked),
      answered: Number(row.answered),
      average_rating:
        row.average_rating === null ? null : round(Number(row.average_rating), 2),
      promoters: Number(row.promoters),
    });
  }
  return out;
}

export interface MonthlyRevenue {
  month: string;
  branch_id: string;
  branch_name: string;
  invoiced: string;
  collected: string;
  outstanding: string;
  invoices: number;
}

/** The same money as the summary, bucketed by billing period. */
export async function monthlyRevenue(
  scope: BranchScope,
  window: ReportWindow,
  db: Knex = defaultDb,
): Promise<MonthlyRevenue[]> {
  const query = applyBranchScope(
    db('invoices').join('branches', 'branches.id', 'invoices.branch_id'),
    'invoices.branch_id',
    scope,
  )
    .groupByRaw("to_char(date_trunc('month', billing_period_start), 'YYYY-MM'), invoices.branch_id, branches.name")
    .select(
      db.raw(
        "to_char(date_trunc('month', billing_period_start), 'YYYY-MM') as month",
      ),
      'invoices.branch_id as branch_id',
      'branches.name as branch_name',
    )
    .select(
      db.raw(`coalesce(sum(amount_due) filter (where invoices.status <> 'void'), 0) as invoiced`),
      db.raw(`coalesce(sum(amount_paid) filter (where invoices.status <> 'void'), 0) as collected`),
      db.raw(
        `coalesce(sum(amount_due - amount_paid) filter (where invoices.status in ('sent', 'overdue')), 0) as outstanding`,
      ),
      db.raw(`count(*) filter (where invoices.status <> 'void') as invoices`),
    )
    .orderByRaw("1 asc, 3 asc");

  applyDateWindow(query, 'billing_period_start', window);

  const rows = (await query) as unknown as Record<string, string>[];
  return rows.map((row) => ({
    month: row.month as string,
    branch_id: row.branch_id as string,
    branch_name: row.branch_name as string,
    invoiced: money(row.invoiced),
    collected: money(row.collected),
    outstanding: money(row.outstanding),
    invoices: Number(row.invoices),
  }));
}

export interface OperatorScorecard {
  user_id: string;
  name: string;
  branch_id: string | null;
  branch_name: string | null;
  onboarding_status: string;
  completed: number;
  skipped: number;
  /** Ratings on the visits this operator finished. */
  reviews: number;
  average_rating: number | null;
}

/**
 * What each operator actually did, and what the customer said afterwards.
 *
 * A left join, so an approved operator with no work yet appears with zeroes
 * rather than being absent — the gap is the point of looking.
 */
export async function operatorScorecards(
  scope: BranchScope,
  window: ReportWindow,
  db: Knex = defaultDb,
): Promise<OperatorScorecard[]> {
  // The window belongs on the join, not the where clause: filtering visits in
  // the where clause would drop the operators who had none.
  const joinWindow = (qb: Knex.JoinClause) => {
    qb.on('work_orders.assigned_user_id', 'users.id');
    if (window.from) {
      qb.andOn('work_orders.scheduled_for', '>=', db.raw('?', [window.from]));
    }
    if (window.to) {
      qb.andOn('work_orders.scheduled_for', '<', db.raw('?', [nextDay(window.to)]));
    }
  };

  const query = applyBranchScope(db('users'), 'users.branch_id', scope)
    .andWhere({ role: 'operator' })
    .leftJoin('work_orders', joinWindow)
    // A visit has at most one review request, so this join cannot fan out.
    .leftJoin('review_requests', 'review_requests.work_order_id', 'work_orders.id')
    .leftJoin('branches', 'branches.id', 'users.branch_id')
    .groupBy('users.id', 'users.first_name', 'users.last_name', 'users.branch_id', 'users.onboarding_status', 'branches.name')
    .select(
      'users.id as user_id',
      'users.first_name',
      'users.last_name',
      'users.branch_id',
      'users.onboarding_status',
      'branches.name as branch_name',
    )
    .select(
      db.raw(`count(work_orders.id) filter (where work_orders.status = 'completed') as completed`),
      db.raw(`count(work_orders.id) filter (where work_orders.status = 'skipped') as skipped`),
      db.raw('count(review_requests.rating_response) as reviews'),
      db.raw('avg(review_requests.rating_response) as average_rating'),
    )
    .orderBy([
      { column: 'users.last_name', order: 'asc' },
      { column: 'users.first_name', order: 'asc' },
    ]);

  const rows = (await query) as unknown as Record<string, string | null>[];

  return rows.map((row) => ({
    user_id: row.user_id as string,
    name: `${row.first_name} ${row.last_name}`,
    branch_id: (row.branch_id as string | null) ?? null,
    branch_name: (row.branch_name as string | null) ?? null,
    onboarding_status: row.onboarding_status as string,
    completed: Number(row.completed),
    skipped: Number(row.skipped),
    reviews: Number(row.reviews),
    average_rating:
      row.average_rating === null ? null : round(Number(row.average_rating), 2),
  }));
}

/** Timestamps: inclusive from, inclusive to by way of the next day. */
function applyStampWindow(
  qb: Knex.QueryBuilder,
  column: string,
  window: ReportWindow,
): void {
  if (window.from) qb.andWhere(column, '>=', window.from);
  if (window.to) qb.andWhere(column, '<', nextDay(window.to));
}

/** Date columns compare directly, so both ends are inclusive as written. */
function applyDateWindow(
  qb: Knex.QueryBuilder,
  column: string,
  window: ReportWindow,
): void {
  if (window.from) qb.andWhere(column, '>=', window.from);
  if (window.to) qb.andWhere(column, '<=', window.to);
}

function nextDay(isoDate: string): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + 1);
  return date.toISOString().slice(0, 10);
}

/** numeric sums arrive as strings; money leaves as one too. */
function money(value: string | number | null | undefined): string {
  return Number(value ?? 0).toFixed(2);
}

function round(value: number, places: number): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}
