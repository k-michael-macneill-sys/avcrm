import * as React from 'react';
import { Plus, X } from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { Branch } from '../../../src/types/models';
import {
  baseProjection,
  scenarioReport,
  SEASON_LENGTH,
  type ScenarioInput,
  type ScenarioReport,
  type Season,
} from '../../../src/services/projectionModel';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { Hero, StatRow, StatTile } from '@/components/Stat';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/auth/AuthContext';
import * as api from '@/lib/api';
import { compactMoney, count, money, percent } from '@/lib/format';
import { useQuery } from '@/lib/useQuery';
import { cn } from '@/lib/utils';

interface Projection {
  season: Season;
  active_customers: number;
  contracted_customers: number;
  active_operators: number;
  monthly_revenue: string[];
  base_revenue: string;
  average_contract_value: string;
}

interface Position {
  id: number;
  label: string;
  monthly: string;
}

const ALL = 'all';
/** Per account, so a shared tablet keeps ADMIN's crew and a branch's apart. */
const positionsKey = (userId: string | undefined): string => `avcrm.projection.operators.${userId ?? 'anon'}`;

/** A typed figure as a number; blank or nonsense counts as nothing. */
function amount(value: string): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function savedPositions(key: string): Position[] | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Position[];
    return Array.isArray(parsed) && parsed.length > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function freshPositions(operators: number): Position[] {
  return Array.from({ length: Math.max(1, operators) }, (_, i) => ({
    id: i + 1,
    label: `Operator ${i + 1}`,
    monthly: '',
  }));
}

const axisMoney = (v: number): string => {
  const abs = Math.abs(v);
  const sign = v < 0 ? '−' : '';
  return abs >= 1000 ? `${sign}$${abs / 1000}k` : `${sign}$${abs}`;
};

/**
 * Financial Projections: the season (1 November – 31 March) on the contracts
 * already signed, against what the crew costs, and below it a What-If model
 * for trying other numbers.
 */
export function Projections(): JSX.Element {
  const { isCorporate, user } = useAuth();
  const storageKey = positionsKey(user?.id);
  const [branch, setBranch] = React.useState('');
  const { data, loading, error } = useQuery(
    () =>
      Promise.all([
        api.get<Projection>('/finance/projection', { branch_id: branch || undefined }),
        api.get<Branch[]>('/branches'),
      ]),
    [branch],
  );

  const [positions, setPositions] = React.useState<Position[] | null>(() => savedPositions(storageKey));
  React.useEffect(() => {
    if (!positions && data) setPositions(freshPositions(data[0].active_operators));
  }, [positions, data]);
  React.useEffect(() => {
    if (!positions) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(positions));
    } catch {
      // Remembering the figures is a convenience; the page works without it.
    }
  }, [positions, storageKey]);

  const monthlySalaries = (positions ?? []).reduce((sum, p) => sum + Math.max(0, amount(p.monthly)), 0);
  const monthlyRevenue = React.useMemo(() => (data?.[0].monthly_revenue ?? []).map(Number), [data]);
  const base = React.useMemo(
    () => baseProjection(monthlyRevenue, monthlySalaries),
    [monthlyRevenue, monthlySalaries],
  );

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [projection, branches] = data;
  // A branch's own sign-in only ever sees its own branch.
  const branchName = isCorporate ? branches.find((b) => b.id === branch)?.name : branches[0]?.name;

  const updatePosition = (id: number, patch: Partial<Position>): void =>
    setPositions((current) => (current ?? []).map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const addPosition = (): void =>
    setPositions((current) => {
      const list = current ?? [];
      const id = Math.max(0, ...list.map((p) => p.id)) + 1;
      return [...list, { id, label: `Operator ${list.length + 1}`, monthly: '' }];
    });
  const removePosition = (id: number): void =>
    setPositions((current) => (current ?? []).filter((p) => p.id !== id));

  return (
    <>
      <PageHeader
        title="Projections"
        subtitle={`${projection.season.label} season · Nov 1 – Mar 31${branchName ? ` · ${branchName}` : ' · every branch'}`}
      />

      {isCorporate ? (
        <div className="mb-4 flex flex-wrap items-end gap-3">
          <div className="flex flex-col gap-1">
            <Label htmlFor="proj-branch">Branch</Label>
            <Select value={branch || ALL} onValueChange={(v) => setBranch(v === ALL ? '' : v)}>
              <SelectTrigger id="proj-branch" className="w-44">
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
      ) : null}

      <Hero
        label="Base net profit by March 31"
        value={money(base.net)}
        note={`${money(base.revenue)} contracted less ${money(base.labor)} in operator pay${
          base.margin === null ? '' : ` · ${percent(base.margin)} margin`
        }`}
      />

      <StatRow>
        <StatTile
          label="Active customers"
          value={count(projection.active_customers)}
          note={`${count(projection.contracted_customers)} with a contract this season`}
        />
        <StatTile
          label="Projected revenue"
          value={compactMoney(base.revenue)}
          note={`${money(projection.average_contract_value)} average contract`}
        />
        <StatTile
          label="Labour expense"
          value={compactMoney(base.labor)}
          note={`${money(monthlySalaries)} a month × ${SEASON_LENGTH}`}
        />
      </StatRow>

      <div className="mb-4 grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-4 max-[900px]:grid-cols-1">
        <Section title="Operator salaries">
          <div className="flex flex-col gap-2">
            {(positions ?? []).map((p) => (
              <div key={p.id} className="flex items-center gap-2">
                <Input
                  aria-label="Position"
                  className="min-w-0 flex-1"
                  value={p.label}
                  onChange={(e) => updatePosition(p.id, { label: e.target.value })}
                />
                <div className="relative w-32 shrink-0">
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    $
                  </span>
                  <Input
                    aria-label={`${p.label} monthly salary`}
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    placeholder="0"
                    className="pl-6 text-right"
                    value={p.monthly}
                    onChange={(e) => updatePosition(p.id, { monthly: e.target.value })}
                  />
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`Remove ${p.label}`}
                  disabled={(positions ?? []).length <= 1}
                  onClick={() => removePosition(p.id)}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
          <div className="mt-3 flex flex-wrap items-center justify-between gap-2">
            <Button variant="secondary" size="sm" onClick={addPosition}>
              <Plus className="h-4 w-4" /> Add operator
            </Button>
            <p className="text-sm">
              <span className="text-muted-foreground">Total </span>
              <span className="font-semibold tabular-nums">{money(monthlySalaries)}</span>
              <span className="text-muted-foreground"> / month</span>
            </p>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            $ per month for each position, or put the whole crew's cost on one line.
          </p>
        </Section>

        <Section title="The season, cumulative">
          <div className="h-72 w-full">
            <ResponsiveContainer>
              <LineChart data={base.months} margin={{ left: 8, right: 16, top: 8 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" vertical={false} />
                <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis
                  stroke="hsl(var(--muted-foreground))"
                  fontSize={12}
                  tickLine={false}
                  axisLine={false}
                  tickFormatter={axisMoney}
                />
                <ReferenceLine y={0} stroke="hsl(var(--muted-foreground) / 0.5)" />
                <Tooltip
                  contentStyle={{
                    background: 'hsl(var(--popover))',
                    border: '1px solid hsl(var(--border))',
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  itemStyle={{ color: 'hsl(var(--foreground))' }}
                  formatter={(value: number, name: string, item: { payload?: { margin: number | null } }) =>
                    name === 'Net margin' && item.payload?.margin !== null && item.payload?.margin !== undefined
                      ? [`${money(value)} (${percent(item.payload.margin)})`, name]
                      : [money(value), name]
                  }
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line
                  type="monotone"
                  dataKey="cumulative_revenue"
                  name="Revenue"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="cumulative_labor"
                  name="Labour cost"
                  stroke="hsl(var(--serious))"
                  strokeWidth={2}
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
                <Line
                  type="monotone"
                  dataKey="cumulative_net"
                  name="Net margin"
                  stroke="hsl(var(--good))"
                  strokeWidth={2}
                  strokeDasharray="5 4"
                  dot={{ r: 3 }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Revenue is each active contract billed as its invoices will be: a seasonal contract in November, a
            monthly one every month it runs.
          </p>
        </Section>
      </div>

      <WhatIf
        key={branch}
        projection={projection}
        monthlySalaries={monthlySalaries}
      />
    </>
  );
}

interface ScenarioFields {
  target_customers: string;
  average_contract_value: string;
  churn_rate: string;
  cancellation_fee: string;
  other_monthly_expenses: string;
}

const FIELDS: { key: keyof ScenarioFields; label: string; prefix?: string; suffix?: string; step: string }[] = [
  { key: 'target_customers', label: 'Target customers', suffix: '#', step: '1' },
  { key: 'average_contract_value', label: 'Average contract value', prefix: '$', step: 'any' },
  { key: 'churn_rate', label: 'Churn rate', suffix: '%', step: 'any' },
  { key: 'cancellation_fee', label: 'Cancellation fee', prefix: '$', step: 'any' },
  { key: 'other_monthly_expenses', label: 'Other monthly expenses', prefix: '$', step: 'any' },
];

/** The What-If generator: try other numbers against the same crew cost. */
function WhatIf({
  projection,
  monthlySalaries,
}: {
  projection: Projection;
  monthlySalaries: number;
}): JSX.Element {
  const [fields, setFields] = React.useState<ScenarioFields>(() => ({
    target_customers: String(projection.active_customers),
    average_contract_value: Number(projection.average_contract_value) > 0 ? projection.average_contract_value : '',
    churn_rate: '',
    cancellation_fee: '',
    other_monthly_expenses: '',
  }));
  const [result, setResult] = React.useState<{ input: ScenarioInput; report: ScenarioReport } | null>(null);
  const reportRef = React.useRef<HTMLDivElement>(null);

  const input: ScenarioInput = {
    target_customers: amount(fields.target_customers),
    average_contract_value: amount(fields.average_contract_value),
    churn_rate: amount(fields.churn_rate),
    cancellation_fee: amount(fields.cancellation_fee),
    other_monthly_expenses: amount(fields.other_monthly_expenses),
    monthly_salaries: monthlySalaries,
  };
  const stale =
    result !== null && (Object.keys(input) as (keyof ScenarioInput)[]).some((k) => input[k] !== result.input[k]);

  const generate = (event: React.FormEvent): void => {
    event.preventDefault();
    setResult({ input, report: scenarioReport(input) });
    requestAnimationFrame(() => reportRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }));
  };

  return (
    <Section title="What-If scenario">
      <form onSubmit={generate}>
        <div className="grid grid-cols-[repeat(auto-fit,minmax(170px,1fr))] gap-3">
          {FIELDS.map((f) => (
            <div key={f.key} className="flex flex-col gap-1">
              <Label htmlFor={`wi-${f.key}`}>{f.label}</Label>
              <div className="relative">
                {f.prefix ? (
                  <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    {f.prefix}
                  </span>
                ) : null}
                <Input
                  id={`wi-${f.key}`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={f.key === 'churn_rate' ? 100 : undefined}
                  step={f.step}
                  placeholder="0"
                  className={cn(f.prefix && 'pl-6', f.suffix && 'pr-8')}
                  value={fields[f.key]}
                  onChange={(e) => setFields((current) => ({ ...current, [f.key]: e.target.value }))}
                />
                {f.suffix ? (
                  <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">
                    {f.suffix}
                  </span>
                ) : null}
              </div>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <Button type="submit" size="lg">
            Generate Report
          </Button>
          <p className="text-xs text-muted-foreground">
            Operator salaries come from above: {money(monthlySalaries)} a month.
          </p>
        </div>
      </form>

      {result ? (
        <div ref={reportRef} className="mt-5">
          <ScenarioCard report={result.report} stale={stale} />
        </div>
      ) : null}
    </Section>
  );
}

function ScenarioCard({ report, stale }: { report: ScenarioReport; stale: boolean }): JSX.Element {
  const profit = report.net >= 0;
  const rows: [string, string, string?][] = [
    ['Service revenue', money(report.gross_service_revenue), `${fmtCustomers(report.effective_customers)} customers stay`],
    ['Cancellation fees', money(report.cancellation_fee_income), `${fmtCustomers(report.churned_customers)} cancel`],
    ['Total revenue', money(report.total_revenue)],
    ['Total labour', money(report.total_labor), 'Operator salaries × 5'],
    ['Total operating expenses', money(report.total_operating), 'Other monthly expenses × 5'],
    ['Net margin', percent(report.margin)],
  ];

  return (
    <div className="rounded-xl border border-border bg-background/40 p-5">
      {stale ? (
        <p className="mb-3 text-xs text-warning">The inputs have changed since this report. Generate it again to update.</p>
      ) : null}
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Projected net {profit ? 'profit' : 'loss'} by March 31
      </p>
      <p
        className={cn(
          'my-1 text-[40px] font-semibold leading-tight tracking-tight tabular-nums',
          profit ? 'text-good' : 'text-critical',
        )}
      >
        {money(report.net)}
      </p>

      <table className="mt-3 w-full text-sm">
        <tbody>
          {rows.map(([label, value, note]) => (
            <tr key={label} className="border-t border-border">
              <td className="py-2 pr-3">
                {label}
                {note ? <span className="block text-xs text-muted-foreground">{note}</span> : null}
              </td>
              <td className="py-2 text-right font-medium tabular-nums">{value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function fmtCustomers(n: number): string {
  return Number.isInteger(n) ? count(n) : n.toLocaleString(undefined, { maximumFractionDigits: 1 });
}
