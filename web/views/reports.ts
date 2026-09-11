import * as api from '../api.js';
import { filterBar, labelled, pageHeader } from '../components.js';
import { fragment, h, section, table } from '../dom.js';
import { count, money, percent } from '../format.js';
import * as router from '../router.js';

interface BranchSummary {
  branch_id: string;
  branch_name: string;
  province: string;
  customers: { total: number; lead: number; active: number; churned: number };
  pipeline: {
    quotes: number;
    presented: number;
    accepted: number;
    declined: number;
    win_rate: number | null;
  };
  contracts: { active: number; cancelled: number; completed: number };
  revenue: {
    invoiced: string;
    collected: string;
    outstanding: string;
    overdue: string;
    invoices: number;
  };
  service: { scheduled: number; completed: number; skipped: number };
  reviews: { asked: number; answered: number; average_rating: number | null; promoters: number };
  crew: { approved: number; pending: number; suspended: number };
}

interface MonthlyRevenue {
  month: string;
  branch_name: string;
  invoiced: string;
  collected: string;
  outstanding: string;
  invoices: number;
}

interface OperatorScorecard {
  user_id: string;
  name: string;
  branch_name: string | null;
  onboarding_status: string;
  completed: number;
  skipped: number;
  reviews: number;
  average_rating: number | null;
}

interface Envelope<T> {
  data: T;
  meta: { from: string | null; to: string | null };
}

/**
 * The roll-up, with its window on the screen rather than implied. Every
 * figure's definition lives in the README; the point here is that the dates
 * the numbers cover are never a mystery.
 */
export async function renderReports(root: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  const from = query.get('from') ?? '';
  const to = query.get('to') ?? '';

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.navigate(`/reports${qs ? `?${qs}` : ''}`, true);
  };

  const dateBox = (name: 'from' | 'to', value: string) => {
    const node = h('input', { type: 'date', value });
    node.addEventListener('change', () => setParam(name, node.value));
    return node;
  };

  const window = { from: from || undefined, to: to || undefined };

  const [summary, revenue, operators] = await Promise.all([
    api.get<BranchSummary[]>(
      api.withQuery('/reports/branch-summary', window),
    ) as Promise<BranchSummary[]>,
    fetchEnvelope<MonthlyRevenue[]>('/reports/revenue', window),
    fetchEnvelope<OperatorScorecard[]>('/reports/operators', window),
  ]);

  root.appendChild(
    fragment(
      pageHeader(
        'Reports',
        from || to
          ? `${from || 'the beginning'} to ${to || 'today'}`
          : 'Everything to date',
      ),
      filterBar(labelled('From', dateBox('from', from)), labelled('To', dateBox('to', to))),
      section(
        'Branches',
        table<BranchSummary>(
          [
            { header: 'Branch', cell: (row) => `${row.branch_name} (${row.province})` },
            { header: 'Customers', numeric: true, cell: (row) => count(row.customers.total) },
            { header: 'Quotes', numeric: true, cell: (row) => count(row.pipeline.quotes) },
            { header: 'Won', numeric: true, cell: (row) => percent(row.pipeline.win_rate) },
            { header: 'Active', numeric: true, cell: (row) => count(row.contracts.active) },
            { header: 'Invoiced', numeric: true, cell: (row) => money(row.revenue.invoiced) },
            { header: 'Collected', numeric: true, cell: (row) => money(row.revenue.collected) },
            { header: 'Overdue', numeric: true, cell: (row) => money(row.revenue.overdue) },
            { header: 'Visits', numeric: true, cell: (row) => count(row.service.completed) },
            {
              header: 'Rating',
              numeric: true,
              cell: (row) =>
                row.reviews.average_rating === null
                  ? '—'
                  : row.reviews.average_rating.toFixed(1),
            },
            {
              header: 'Crew',
              cell: (row) =>
                `${row.crew.approved} ready${row.crew.pending + row.crew.suspended > 0 ? `, ${row.crew.pending + row.crew.suspended} not` : ''}`,
            },
          ],
          summary,
          'No branches in scope.',
        ),
        h(
          'p',
          { class: 'empty footnote' },
          'Revenue only — nothing in the system records a cost, so there is no margin here to show.',
        ),
      ),
      section(
        'Revenue by billing month',
        table<MonthlyRevenue>(
          [
            { header: 'Month', cell: (row) => row.month },
            { header: 'Branch', cell: (row) => row.branch_name },
            { header: 'Invoices', numeric: true, cell: (row) => count(row.invoices) },
            { header: 'Invoiced', numeric: true, cell: (row) => money(row.invoiced) },
            { header: 'Collected', numeric: true, cell: (row) => money(row.collected) },
            { header: 'Outstanding', numeric: true, cell: (row) => money(row.outstanding) },
          ],
          revenue.data,
          'Nothing billed in this window.',
        ),
      ),
      section(
        'Operators',
        table<OperatorScorecard>(
          [
            { header: 'Operator', cell: (row) => row.name },
            { header: 'Branch', cell: (row) => row.branch_name ?? '—' },
            { header: 'Completed', numeric: true, cell: (row) => count(row.completed) },
            { header: 'Skipped', numeric: true, cell: (row) => count(row.skipped) },
            { header: 'Reviews', numeric: true, cell: (row) => count(row.reviews) },
            {
              header: 'Rating',
              numeric: true,
              cell: (row) =>
                row.average_rating === null ? '—' : row.average_rating.toFixed(1),
            },
          ],
          operators.data,
          'No operators in scope.',
        ),
      ),
    ),
  );
}

/** These endpoints answer with `{ data, meta }`, where meta echoes the window. */
async function fetchEnvelope<T>(
  path: string,
  query: Record<string, string | undefined>,
): Promise<Envelope<T>> {
  const response = await api.list<never>(api.withQuery(path, query));
  return response as unknown as Envelope<T>;
}
