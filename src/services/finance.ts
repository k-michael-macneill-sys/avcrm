import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import { EXPENSE_CATEGORY_INFO } from './expenses';
import { billingPeriods, today } from './invoices';
import {
  contractRevenueByMonth,
  roundCents,
  SEASON_LENGTH,
  seasonFor,
  type Season,
} from './projectionModel';

/**
 * The top-line money: what was billed, what came in, what went out on
 * expenses, and what is left.
 *
 * Revenue is bucketed by the billing period it pays for, the same way the
 * Reports page does it, so the two never disagree about a month. Expenses are
 * bucketed by the date on the receipt.
 *
 * Narrowing to a branch drops company-wide expenses (those filed against no
 * branch): a branch's own figures should not carry the head office's rent.
 */

export interface FinanceWindow {
  branch_id?: string;
  /** Inclusive YYYY-MM-DD. */
  from?: string;
  /** Inclusive YYYY-MM-DD. */
  to?: string;
}

export interface FinanceTotals {
  invoiced: string;
  collected: string;
  outstanding: string;
  overdue: string;
  expenses: string;
  /** Collected less expenses: the cash the business actually kept. */
  net_cash: string;
  /** Invoiced less expenses: the profit once everyone has paid. */
  net_invoiced: string;
  /** net_cash as a share of collected. Null while nothing is collected. */
  margin: number | null;
  expense_count: number;
  receipts_missing: number;
}

export interface FinanceMonth {
  month: string;
  invoiced: string;
  collected: string;
  expenses: string;
  net: string;
}

export interface FinanceCategory {
  category: string;
  label: string;
  cra_line: string;
  total: string;
  count: number;
}

export interface FinanceSummary {
  totals: FinanceTotals;
  monthly: FinanceMonth[];
  by_category: FinanceCategory[];
}

/** Sums arrive as numeric strings; do the arithmetic in cents. */
function cents(value: string | number | null | undefined): number {
  return Math.round(Number(value ?? 0) * 100);
}

function dollars(value: number): string {
  return (value / 100).toFixed(2);
}

export async function financialSummary(
  window: FinanceWindow,
  db: Knex = defaultDb,
): Promise<FinanceSummary> {
  const invoices = db('invoices').whereNot('status', 'void');
  if (window.branch_id) invoices.where('branch_id', window.branch_id);
  if (window.from) invoices.where('billing_period_start', '>=', window.from);
  if (window.to) invoices.where('billing_period_start', '<=', window.to);

  const expenses = db('expenses');
  if (window.branch_id) expenses.where('branch_id', window.branch_id);
  if (window.from) expenses.where('spent_on', '>=', window.from);
  if (window.to) expenses.where('spent_on', '<=', window.to);

  const [revenueMonths, expenseMonths, categories, [revenueTotals], [expenseTotals]] =
    await Promise.all([
      invoices
        .clone()
        .select(db.raw(`to_char(billing_period_start, 'YYYY-MM') as month`))
        .sum({ invoiced: 'amount_due', collected: 'amount_paid' })
        .groupByRaw('1') as Promise<{ month: string; invoiced: string; collected: string }[]>,
      expenses
        .clone()
        .select(db.raw(`to_char(spent_on, 'YYYY-MM') as month`))
        .sum({ total: 'amount' })
        .groupByRaw('1') as Promise<{ month: string; total: string }[]>,
      expenses
        .clone()
        .select('category')
        .sum({ total: 'amount' })
        .count({ count: '*' })
        .groupBy('category') as Promise<{ category: string; total: string; count: string }[]>,
      invoices
        .clone()
        .select(
          db.raw('coalesce(sum(amount_due), 0) as invoiced'),
          db.raw('coalesce(sum(amount_paid), 0) as collected'),
          db.raw(
            `coalesce(sum(amount_due - amount_paid) filter (where status in ('sent', 'overdue')), 0) as outstanding`,
          ),
          db.raw(
            `coalesce(sum(amount_due - amount_paid) filter (where status = 'overdue'), 0) as overdue`,
          ),
        ) as Promise<Record<string, string>[]>,
      expenses
        .clone()
        .select(
          db.raw('coalesce(sum(amount), 0) as total'),
          db.raw('count(*) as count'),
          db.raw('count(*) filter (where receipt_key is null) as missing'),
        ) as Promise<Record<string, string>[]>,
    ]);

  const months = new Map<string, { invoiced: number; collected: number; expenses: number }>();
  const bucket = (month: string) => {
    const existing = months.get(month);
    if (existing) return existing;
    const fresh = { invoiced: 0, collected: 0, expenses: 0 };
    months.set(month, fresh);
    return fresh;
  };
  for (const row of revenueMonths) {
    const b = bucket(row.month);
    b.invoiced += cents(row.invoiced);
    b.collected += cents(row.collected);
  }
  for (const row of expenseMonths) {
    bucket(row.month).expenses += cents(row.total);
  }

  const collected = cents(revenueTotals?.collected);
  const invoiced = cents(revenueTotals?.invoiced);
  const spent = cents(expenseTotals?.total);
  const info = new Map(EXPENSE_CATEGORY_INFO.map((c) => [c.code as string, c]));

  return {
    totals: {
      invoiced: dollars(invoiced),
      collected: dollars(collected),
      outstanding: dollars(cents(revenueTotals?.outstanding)),
      overdue: dollars(cents(revenueTotals?.overdue)),
      expenses: dollars(spent),
      net_cash: dollars(collected - spent),
      net_invoiced: dollars(invoiced - spent),
      margin: collected > 0 ? (collected - spent) / collected : null,
      expense_count: Number(expenseTotals?.count ?? 0),
      receipts_missing: Number(expenseTotals?.missing ?? 0),
    },
    monthly: [...months.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, m]) => ({
        month,
        invoiced: dollars(m.invoiced),
        collected: dollars(m.collected),
        expenses: dollars(m.expenses),
        net: dollars(m.collected - m.expenses),
      })),
    by_category: categories
      .map((row) => ({
        category: row.category,
        label: info.get(row.category)?.label ?? row.category,
        cra_line: info.get(row.category)?.cra_line ?? '',
        total: dollars(cents(row.total)),
        count: Number(row.count),
      }))
      .sort((a, b) => cents(b.total) - cents(a.total)),
  };
}

export interface FinanceProjection {
  season: Season;
  /** Customers marked active, as the Customers list counts them. */
  active_customers: number;
  /** Active customers with an active contract that bills this season. */
  contracted_customers: number;
  active_operators: number;
  /** The contracts' revenue, November to March. */
  monthly_revenue: string[];
  base_revenue: string;
  /** base_revenue per contracted customer; zero while there are none. */
  average_contract_value: string;
}

interface ProjectedContract {
  customer_id: string;
  billing_type: 'monthly' | 'seasonal_upfront';
  discounted_price: string;
  recurring_price: string | null;
  season_start: string;
  season_end: string;
}

/**
 * What the season looks like on the contracts already signed: every active
 * contract of an active customer that has not ended before the season starts,
 * billed the way the invoices will bill it (see contractRevenueByMonth).
 */
export async function financialProjection(
  options: { branch_id?: string; today?: string },
  db: Knex = defaultDb,
): Promise<FinanceProjection> {
  const season = seasonFor(options.today ?? today());

  const customers = db('customers').where({ status: 'active' });
  const contracts = db('contracts')
    .join('customers', 'customers.id', 'contracts.customer_id')
    .join('quotes', 'quotes.id', 'contracts.quote_id')
    .where('contracts.status', 'active')
    .andWhere('customers.status', 'active')
    .andWhere('quotes.season_end', '>=', season.start)
    .select(
      'contracts.customer_id',
      'quotes.billing_type',
      'quotes.discounted_price',
      'quotes.recurring_price',
      db.raw(`to_char(quotes.season_start, 'YYYY-MM-DD') as season_start`),
      db.raw(`to_char(quotes.season_end, 'YYYY-MM-DD') as season_end`),
    );
  const operators = db('users').where({ role: 'operator', is_active: true });
  if (options.branch_id) {
    customers.where('branch_id', options.branch_id);
    contracts.where('customers.branch_id', options.branch_id);
    operators.where('branch_id', options.branch_id);
  }

  const [[customerCount], rows, [operatorCount]] = await Promise.all([
    customers.count({ count: '*' }) as Promise<{ count: string }[]>,
    contracts as Promise<ProjectedContract[]>,
    operators.count({ count: '*' }) as Promise<{ count: string }[]>,
  ]);

  const months = new Array<number>(SEASON_LENGTH).fill(0);
  const contracted = new Set<string>();
  for (const row of rows) {
    contracted.add(row.customer_id);
    const revenue = contractRevenueByMonth({
      billing_type: row.billing_type,
      discounted_price: Number(row.discounted_price),
      recurring_price: row.recurring_price === null ? null : Number(row.recurring_price),
      periods: billingPeriods(row.season_start, row.season_end).length,
    });
    revenue.forEach((amount, i) => {
      months[i] = roundCents((months[i] ?? 0) + amount);
    });
  }
  const base = roundCents(months.reduce((sum, m) => sum + m, 0));

  return {
    season,
    active_customers: Number(customerCount?.count ?? 0),
    contracted_customers: contracted.size,
    active_operators: Number(operatorCount?.count ?? 0),
    monthly_revenue: months.map((m) => m.toFixed(2)),
    base_revenue: base.toFixed(2),
    average_contract_value: (contracted.size > 0 ? base / contracted.size : 0).toFixed(2),
  };
}
