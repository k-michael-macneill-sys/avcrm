import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import { EXPENSE_CATEGORY_INFO } from './expenses';

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
