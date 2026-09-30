import * as React from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Branch } from '../../../src/types/models';
import { DataTable } from '@/components/DataTable';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { Hero, StatRow, StatTile } from '@/components/Stat';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import * as api from '@/lib/api';
import { compactMoney, count, money, percent } from '@/lib/format';
import { useQuery } from '@/lib/useQuery';

interface FinanceSummary {
  totals: {
    invoiced: string;
    collected: string;
    outstanding: string;
    overdue: string;
    expenses: string;
    net_cash: string;
    net_invoiced: string;
    margin: number | null;
    expense_count: number;
    receipts_missing: number;
  };
  monthly: { month: string; invoiced: string; collected: string; expenses: string; net: string }[];
  by_category: { category: string; label: string; cra_line: string; total: string; count: number }[];
}

const ALL = 'all';

/**
 * The Business Console's front page: what came in, what went out, and what is
 * left — over a window that is always on the screen.
 */
export function Financials(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const from = params.get('from') ?? '';
  const to = params.get('to') ?? '';
  const branch = params.get('branch_id') ?? '';

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const { data, loading, error } = useQuery(
    () =>
      Promise.all([
        api.get<FinanceSummary>('/finance/summary', {
          from: from || undefined,
          to: to || undefined,
          branch_id: branch || undefined,
        }),
        api.get<Branch[]>('/branches'),
      ]),
    [from, to, branch],
  );

  const chartData = React.useMemo(
    () =>
      (data?.[0].monthly ?? []).map((m) => ({
        month: m.month,
        collected: Number(m.collected),
        expenses: Number(m.expenses),
      })),
    [data],
  );

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [summary, branches] = data;
  const { totals } = summary;
  const branchName = branches.find((b) => b.id === branch)?.name;
  const window = from || to ? `${from || 'the beginning'} to ${to || 'today'}` : 'Everything to date';

  return (
    <>
      <PageHeader title="Financials" subtitle={`${window}${branchName ? ` · ${branchName}` : ' · every branch'}`} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="fin-from">From</Label>
          <Input id="fin-from" type="date" value={from} onChange={(e) => setParam('from', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="fin-to">To</Label>
          <Input id="fin-to" type="date" value={to} onChange={(e) => setParam('to', e.target.value)} />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="fin-branch">Branch</Label>
          <Select value={branch || ALL} onValueChange={(v) => setParam('branch_id', v === ALL ? '' : v)}>
            <SelectTrigger id="fin-branch" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>Every branch</SelectItem>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <Hero
        label="Net cash"
        value={money(totals.net_cash)}
        note={`${money(totals.collected)} collected less ${money(totals.expenses)} in expenses${
          totals.margin === null ? '' : ` · ${percent(totals.margin)} margin`
        }`}
      />

      <StatRow>
        <StatTile label="Invoiced" value={compactMoney(totals.invoiced)} note={`${money(totals.net_invoiced)} after expenses`} />
        <StatTile label="Collected" value={compactMoney(totals.collected)} />
        <StatTile label="Outstanding" value={compactMoney(totals.outstanding)} note={`${money(totals.overdue)} overdue`} />
        <StatTile
          label="Expenses"
          value={compactMoney(totals.expenses)}
          note={
            totals.receipts_missing > 0
              ? `${count(totals.receipts_missing)} without a receipt`
              : `${count(totals.expense_count)} entries`
          }
        />
      </StatRow>

      {chartData.length > 0 ? (
        <Section title="Collected against expenses, by month" className="mb-4">
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
                  itemStyle={{ color: 'hsl(var(--foreground))' }}
                  formatter={(value: number) => money(value)}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="collected" name="Collected" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                <Bar dataKey="expenses" name="Expenses" fill="hsl(var(--muted-foreground) / 0.45)" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </Section>
      ) : null}

      <div className="grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <Section title="By month">
          <DataTable
            rowKey={(row) => row.month}
            rows={summary.monthly}
            emptyMessage="Nothing billed or spent in this window."
            columns={[
              { header: 'Month', cell: (row) => row.month },
              { header: 'Collected', numeric: true, cell: (row) => money(row.collected) },
              { header: 'Expenses', numeric: true, cell: (row) => money(row.expenses) },
              {
                header: 'Net',
                numeric: true,
                cell: (row) => (
                  <span className={Number(row.net) < 0 ? 'text-critical' : undefined}>{money(row.net)}</span>
                ),
              },
            ]}
          />
        </Section>

        <Section title="Expenses by category">
          <DataTable
            rowKey={(row) => row.category}
            rows={summary.by_category}
            emptyMessage="No expenses logged in this window."
            columns={[
              { header: 'Category', cell: (row) => row.label },
              { header: 'T2125', cell: (row) => <span className="text-muted-foreground">{row.cra_line}</span> },
              { header: 'Entries', numeric: true, cell: (row) => count(row.count) },
              { header: 'Total', numeric: true, cell: (row) => money(row.total) },
            ]}
          />
          <p className="mt-3 text-xs text-muted-foreground">
            From the <Link className="text-primary hover:underline" to="/business/bookkeeping">bookkeeping</Link> log.
            Revenue is counted by the month it was billed for, as on Reports; expenses by the date on the receipt.
          </p>
        </Section>
      </div>
    </>
  );
}
