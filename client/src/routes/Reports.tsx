import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { DataTable } from '@/components/DataTable';
import { Loading, ErrorNotice } from '@/components/Misc';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useQuery } from '@/lib/useQuery';
import * as api from '@/lib/api';
import { count, money, percent } from '@/lib/format';

interface BranchSummary {
  branch_id: string;
  branch_name: string;
  province: string;
  customers: { total: number; lead: number; active: number; churned: number };
  pipeline: { quotes: number; presented: number; accepted: number; declined: number; win_rate: number | null };
  contracts: { active: number; cancelled: number; completed: number };
  revenue: { invoiced: string; collected: string; outstanding: string; overdue: string; invoices: number };
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

async function fetchEnvelope<T>(
  path: string,
  query: Record<string, string | undefined>,
): Promise<Envelope<T>> {
  const response = await api.list<never>(api.withQuery(path, query));
  return response as unknown as Envelope<T>;
}

/**
 * The roll-up, with its window on the screen rather than implied. Every
 * figure's definition lives in the README; the point here is that the dates
 * the numbers cover are never a mystery.
 */
export function Reports(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const window = React.useMemo(() => ({ from: from || undefined, to: to || undefined }), [from, to]);

  const { data, loading, error } = useQuery(
    () =>
      Promise.all([
        api.get<BranchSummary[]>(api.withQuery('/reports/branch-summary', window)),
        fetchEnvelope<MonthlyRevenue[]>('/reports/revenue', window),
        fetchEnvelope<OperatorScorecard[]>('/reports/operators', window),
      ]),
    [from, to],
  );

  const setParam = (key: 'from' | 'to', value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [summary, revenue, operators] = data;

  // One row per month, summed across branches — the shape a monitoring chart
  // wants, distinct from the by-branch-and-month table below it.
  const byMonth = new Map<string, { month: string; invoiced: number; collected: number }>();
  for (const row of revenue.data) {
    const bucket = byMonth.get(row.month) ?? { month: row.month, invoiced: 0, collected: 0 };
    bucket.invoiced += Number(row.invoiced);
    bucket.collected += Number(row.collected);
    byMonth.set(row.month, bucket);
  }
  const chartData = [...byMonth.values()].sort((a, b) => a.month.localeCompare(b.month));

  return (
    <>
      <PageHeader
        title="Reports"
        subtitle={from || to ? `${from || 'the beginning'} to ${to || 'today'}` : 'Everything to date'}
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="from">From</Label>
          <Input id="from" type="date" value={from} onChange={(e) => setParam('from', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="to">To</Label>
          <Input id="to" type="date" value={to} onChange={(e) => setParam('to', e.target.value)} />
        </div>
      </div>

      {chartData.length > 0 ? (
        <Section title="Revenue by month" className="mb-4">
          <div className="h-64 w-full">
            <ResponsiveContainer>
              <BarChart data={chartData} margin={{ left: 8, right: 8, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={(v: number) => (v >= 1000 ? `$${v / 1000}k` : `$${v}`)}
                />
                <Tooltip
                  cursor={{ fill: 'hsl(var(--accent))' }}
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  formatter={(value: number) => money(value)}
                />
                <Bar dataKey="invoiced" name="Invoiced" fill="hsl(var(--primary) / 0.35)" radius={[4, 4, 0, 0]} />
                <Bar dataKey="collected" name="Collected" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      ) : null}

      <Section title="Branches" className="mb-4">
        <DataTable
          rowKey={(row) => row.branch_id}
          rows={summary}
          emptyMessage="No branches in scope."
          columns={[
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
              cell: (row) => (row.reviews.average_rating === null ? '—' : row.reviews.average_rating.toFixed(1)),
            },
            {
              header: 'Crew',
              cell: (row) =>
                `${row.crew.approved} ready${row.crew.pending + row.crew.suspended > 0 ? `, ${row.crew.pending + row.crew.suspended} not` : ''}`,
            },
          ]}
        />
        <p className="mt-3 text-xs text-muted-foreground">
          Revenue only — nothing in the system records a cost, so there is no margin here to show.
        </p>
      </Section>

      <Section title="Revenue by billing month" className="mb-4">
        <DataTable
          rowKey={(row) => `${row.month}-${row.branch_name}`}
          rows={revenue.data}
          emptyMessage="Nothing billed in this window."
          columns={[
            { header: 'Month', cell: (row) => row.month },
            { header: 'Branch', cell: (row) => row.branch_name },
            { header: 'Invoices', numeric: true, cell: (row) => count(row.invoices) },
            { header: 'Invoiced', numeric: true, cell: (row) => money(row.invoiced) },
            { header: 'Collected', numeric: true, cell: (row) => money(row.collected) },
            { header: 'Outstanding', numeric: true, cell: (row) => money(row.outstanding) },
          ]}
        />
      </Section>

      <Section title="Operators">
        <DataTable
          rowKey={(row) => row.user_id}
          rows={operators.data}
          emptyMessage="No operators in scope."
          columns={[
            { header: 'Operator', cell: (row) => row.name },
            { header: 'Branch', cell: (row) => row.branch_name ?? '—' },
            { header: 'Completed', numeric: true, cell: (row) => count(row.completed) },
            { header: 'Skipped', numeric: true, cell: (row) => count(row.skipped) },
            { header: 'Reviews', numeric: true, cell: (row) => count(row.reviews) },
            {
              header: 'Rating',
              numeric: true,
              cell: (row) => (row.average_rating === null ? '—' : row.average_rating.toFixed(1)),
            },
          ]}
        />
      </Section>
    </>
  );
}
