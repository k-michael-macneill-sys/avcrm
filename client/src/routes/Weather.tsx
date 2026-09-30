import * as React from 'react';
import type { Branch } from '../../../src/types/models';
import { DataTable } from '@/components/DataTable';
import { ErrorNotice, Field, FieldList, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import * as api from '@/lib/api';
import { count, date, stamp } from '@/lib/format';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';

interface Settings {
  enabled: boolean;
  threshold_cm: number;
  check_hour: number;
  service_hour: number;
  provider: string;
}

interface RunView {
  id: string;
  branch_name: string;
  service_date: string;
  region: string;
  snowfall_cm: string;
  threshold_cm: string;
  triggered: boolean;
  notified: number;
  updated_at: string;
}

interface RegionForecast {
  region: string;
  customers: number;
  snowfall_cm: number | null;
  triggered: boolean;
  already_alerted: boolean;
  error: string | null;
}

interface BranchCheck {
  branch_name: string;
  service_date: string;
  window_from: string;
  window_to: string;
  threshold_cm: number;
  regions: RegionForecast[];
}

const clock = (hour: number) => `${hour % 12 === 0 ? 12 : hour % 12}${hour < 12 ? 'am' : 'pm'}`;

/**
 * The weather bot, in the Operations Console. It runs by itself every
 * evening; this page shows its rules, what it decided, and lets the office
 * look at tonight's forecast region by region without sending anything.
 */
export function Weather(): JSX.Element {
  const { data, loading, error } = useQuery(
    () =>
      Promise.all([
        api.get<Settings>('/weather/settings'),
        api.get<RunView[]>('/weather/runs'),
        api.get<Branch[]>('/branches'),
      ]),
    [],
  );

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [settings, runs, branches] = data;

  return (
    <>
      <PageHeader title="Weather Alerts" subtitle="Tells customers to move their cars the night before a clearing" />

      <Section title="How it works" className="mb-4">
        <FieldList>
          <Field label="Status">{settings.enabled ? 'On' : 'Off (WEATHER_ALERTS_ENABLED=false)'}</Field>
          <Field label="Trigger">More than {settings.threshold_cm} cm of snow</Field>
          <Field label="Window">
            {clock(settings.check_hour)} to {clock(settings.service_hour)} next morning
          </Field>
          <Field label="Checks">Hourly from {clock(settings.check_hour)}, each branch’s own time</Field>
          <Field label="Forecast">{settings.provider}, by postal region</Field>
        </FieldList>
        <p className="mt-4 text-sm text-muted-foreground">
          Every active customer in a region where the snow crosses the line gets, by text or email as they prefer:
        </p>
        <blockquote className="mt-2 border-l-2 border-primary pl-3 text-sm text-foreground">
          Snowfall notice: Our team is scheduled to service your drive tomorrow morning. Please park all vehicles
          outside the driveway tonight so we can perform a full clearance.
        </blockquote>
        <p className="mt-2 text-xs text-muted-foreground">
          Each region is alerted at most once per morning. A region below the line is checked again every hour until
          midnight, because the late forecast is the one that counts.
        </p>
      </Section>

      <ForecastCheck branches={branches} />

      <Section title="Recent decisions">
        <DataTable
          rowKey={(row) => row.id}
          rows={runs}
          emptyMessage="Nothing decided yet. The first check runs this evening."
          columns={[
            { header: 'Morning', cell: (row) => date(row.service_date) },
            { header: 'Branch', cell: (row) => row.branch_name },
            { header: 'Region', cell: (row) => <code>{row.region}</code> },
            { header: 'Snow', numeric: true, cell: (row) => `${Number(row.snowfall_cm).toFixed(1)} cm` },
            {
              header: 'Result',
              cell: (row) => <StatusPill status={row.triggered ? 'alerted' : 'below_threshold'} />,
            },
            { header: 'Notified', numeric: true, cell: (row) => count(row.notified) },
            { header: 'Checked', cell: (row) => stamp(row.updated_at) },
          ]}
        />
      </Section>
    </>
  );
}

function ForecastCheck({ branches }: { branches: Branch[] }): JSX.Element {
  const [branch, setBranch] = React.useState(branches[0]?.id ?? '');
  const [result, setResult] = React.useState<BranchCheck | null>(null);
  const { run, pending, error } = useSubmit();

  return (
    <Section title="Tonight’s forecast" className="mb-4">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="weather-branch">Branch</Label>
          <Select value={branch} onValueChange={setBranch}>
            <SelectTrigger id="weather-branch" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button
          type="button"
          variant="secondary"
          disabled={pending || !branch}
          onClick={() =>
            run(async () => setResult(await api.post<BranchCheck>('/weather/check', { branch_id: branch, send: false })))
          }
        >
          {pending ? 'Checking…' : 'Check forecast'}
        </Button>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
      {result ? (
        <>
          <p className="mb-3 text-xs text-muted-foreground">
            {result.branch_name}, for the morning of {date(result.service_date)}: snow from{' '}
            {result.window_from.replace('T', ' ')} to {result.window_to.replace('T', ' ')}. Looking only — nothing is sent
            from here.
          </p>
          <DataTable
            rowKey={(row) => row.region}
            rows={result.regions}
            emptyMessage="No active customers with a postal code in this branch."
            columns={[
              { header: 'Region', cell: (row) => <code>{row.region}</code> },
              { header: 'Customers', numeric: true, cell: (row) => count(row.customers) },
              {
                header: 'Snow',
                numeric: true,
                cell: (row) => (row.snowfall_cm === null ? '—' : `${row.snowfall_cm.toFixed(1)} cm`),
              },
              {
                header: 'Result',
                cell: (row) =>
                  row.error ? (
                    <span className="text-xs text-critical">{row.error}</span>
                  ) : row.already_alerted ? (
                    <span className="text-xs text-muted-foreground">Already alerted</span>
                  ) : (
                    <StatusPill status={row.triggered ? 'alerted' : 'below_threshold'} />
                  ),
              },
            ]}
          />
        </>
      ) : null}
    </Section>
  );
}
