import { Link } from 'react-router-dom';
import type { Invoice, WorkOrder } from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { Hero, StatRow, StatTile } from '@/components/Stat';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Loading, ErrorNotice } from '@/components/Misc';
import { useAuth } from '@/auth/AuthContext';
import { useQuery } from '@/lib/useQuery';
import * as api from '@/lib/api';
import { count, date, money, percent, relative } from '@/lib/format';

/**
 * Two different screens behind one route, because the two roles open the app
 * for different reasons: corporate wants the roll-up, an operator wants
 * today's work. Showing an operator a company revenue figure they cannot act
 * on — and that the API would refuse them anyway — is not a dashboard.
 */
export function Dashboard(): JSX.Element {
  const { isCorporate } = useAuth();
  return isCorporate ? <CorporateDashboard /> : <OperatorDashboard />;
}

interface BranchSummary {
  branch_id: string;
  branch_name: string;
  province: string;
  customers: { total: number; lead: number; active: number; churned: number };
  pipeline: { quotes: number; accepted: number; win_rate: number | null };
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

function CorporateDashboard(): JSX.Element {
  const { data, loading, error } = useQuery(
    () =>
      Promise.all([
        api.get<BranchSummary[]>('/reports/branch-summary'),
        api.list<WorkOrder>('/work-orders', { status: 'scheduled', page_size: 6 }),
        api.list<Invoice>('/invoices', { outstanding: true, page_size: 6 }),
      ]),
    [],
  );

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [branches, upcoming, owing] = data;

  const total = branches.reduce(
    (acc, branch) => ({
      outstanding: acc.outstanding + Number(branch.revenue.outstanding),
      overdue: acc.overdue + Number(branch.revenue.overdue),
      invoiced: acc.invoiced + Number(branch.revenue.invoiced),
      active: acc.active + branch.contracts.active,
      completed: acc.completed + branch.service.completed,
      crew: acc.crew + branch.crew.approved,
      pendingCrew: acc.pendingCrew + branch.crew.pending + branch.crew.suspended,
      answered: acc.answered + branch.reviews.answered,
      ratingSum: acc.ratingSum + (branch.reviews.average_rating ?? 0) * branch.reviews.answered,
    }),
    {
      outstanding: 0,
      overdue: 0,
      invoiced: 0,
      active: 0,
      completed: 0,
      crew: 0,
      pendingCrew: 0,
      answered: 0,
      ratingSum: 0,
    },
  );

  const rating = total.answered > 0 ? total.ratingSum / total.answered : null;

  return (
    <>
      <PageHeader
        title="Dashboard"
        subtitle={
          branches.length === 1
            ? `${branches[0]?.branch_name ?? ''} — everything to date`
            : `${branches.length} branches — everything to date`
        }
      />
      <Hero
        label="Outstanding"
        value={money(total.outstanding)}
        note={`of ${money(total.invoiced)} invoiced · ${money(total.overdue)} of it overdue`}
      />
      <StatRow>
        <StatTile label="Active contracts" value={count(total.active)} />
        <StatTile label="Visits completed" value={count(total.completed)} />
        <StatTile
          label="Average rating"
          value={rating === null ? '—' : rating.toFixed(1)}
          note={total.answered === 0 ? 'nobody has answered yet' : `${total.answered} answered`}
        />
        <StatTile
          label="Crew ready"
          value={count(total.crew)}
          note={total.pendingCrew > 0 ? `${total.pendingCrew} not assignable` : 'everyone cleared'}
        />
      </StatRow>

      <Section title={branches.length === 1 ? 'Branch' : 'Branches'} className="mb-4">
        <DataTable
          rowKey={(row) => row.branch_id}
          rows={branches}
          emptyMessage="No branches yet."
          columns={[
            { header: 'Branch', cell: (row) => `${row.branch_name} (${row.province})` },
            { header: 'Customers', numeric: true, cell: (row) => count(row.customers.total) },
            { header: 'Won', numeric: true, cell: (row) => percent(row.pipeline.win_rate) },
            { header: 'Active', numeric: true, cell: (row) => count(row.contracts.active) },
            { header: 'Invoiced', numeric: true, cell: (row) => money(row.revenue.invoiced) },
            { header: 'Outstanding', numeric: true, cell: (row) => money(row.revenue.outstanding) },
            {
              header: 'Rating',
              numeric: true,
              cell: (row) =>
                row.reviews.average_rating === null ? '—' : row.reviews.average_rating.toFixed(1),
            },
          ]}
        />
      </Section>

      <div className="grid grid-cols-[repeat(auto-fit,minmax(300px,1fr))] gap-4">
        <Section title="Next on the board">
          <DataTable
            rowKey={(row) => row.id}
            rows={upcoming.data}
            emptyMessage="Nothing scheduled."
            columns={[
              { header: 'When', cell: (row) => relative(row.scheduled_for) },
              {
                header: 'Visit',
                cell: (row) => (
                  <Link className="text-primary hover:underline" to={`/work-orders/${row.id}`}>
                    {row.service_type.replace(/_/g, ' ')}
                  </Link>
                ),
              },
              { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
            ]}
          />
        </Section>
        <Section title="Money to chase">
          <DataTable
            rowKey={(row) => row.id}
            rows={owing.data}
            emptyMessage="Everything is settled."
            columns={[
              {
                header: 'Invoice',
                cell: (row) => (
                  <Link className="text-primary hover:underline" to={`/invoices/${row.id}`}>
                    {date(row.due_date)}
                  </Link>
                ),
              },
              {
                header: 'Owing',
                numeric: true,
                cell: (row) => money(Number(row.amount_due) - Number(row.amount_paid)),
              },
              { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
            ]}
          />
        </Section>
      </div>
    </>
  );
}

interface ComplianceItem {
  requirement_code: string;
  label: string;
  is_required: boolean;
  status: string;
  expires_on: string | null;
}

interface Compliance {
  assignable: boolean;
  onboarding_status: string;
  missing_required: string[];
  items: ComplianceItem[];
}

function OperatorDashboard(): JSX.Element {
  const { user } = useAuth();
  const { data, loading, error } = useQuery(
    () =>
      Promise.all([
        api.list<WorkOrder>('/work-orders', { assigned_user_id: user?.id, page_size: 25 }),
        api.get<Compliance>(`/operators/${user?.id}/compliance`),
      ]),
    [user?.id],
  );

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data || !user) return <Loading />;

  const [mine, compliance] = data;
  const open = mine.data.filter((visit) =>
    ['scheduled', 'en_route', 'in_progress'].includes(visit.status),
  );
  const done = mine.data.filter((visit) => visit.status === 'completed').length;
  const expiring = compliance.items
    .filter((item) => item.status === 'approved' && item.expires_on)
    .sort((a, b) => (a.expires_on ?? '').localeCompare(b.expires_on ?? ''))[0];

  return (
    <>
      <PageHeader title={`Morning, ${user.first_name}`} subtitle="Your visits and your paperwork" />
      <Hero
        label="Visits still open"
        value={count(open.length)}
        note={open.length === 0 ? 'nothing outstanding' : 'oldest first below'}
      />
      <StatRow>
        <StatTile label="Completed" value={count(done)} />
        <StatTile
          label="Assignable"
          value={compliance.assignable ? 'Yes' : 'No'}
          note={
            compliance.assignable
              ? 'documents all in date'
              : `${compliance.missing_required.length} required document(s) outstanding`
          }
        />
        <StatTile
          label="Next expiry"
          value={expiring?.expires_on ? date(expiring.expires_on) : '—'}
          note={expiring?.label}
        />
      </StatRow>

      <Section title="Your visits" className="mb-4">
        <DataTable
          rowKey={(row) => row.id}
          rows={mine.data}
          emptyMessage="Nothing assigned to you yet."
          columns={[
            { header: 'When', cell: (row) => relative(row.scheduled_for) },
            {
              header: 'Visit',
              cell: (row) => (
                <Link className="text-primary hover:underline" to={`/work-orders/${row.id}`}>
                  {row.service_type.replace(/_/g, ' ')}
                </Link>
              ),
            },
            { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
          ]}
        />
      </Section>

      <Section title="Your documents">
        <DataTable
          rowKey={(row) => row.requirement_code}
          rows={compliance.items}
          emptyMessage="No requirements apply to your branch."
          columns={[
            { header: 'Document', cell: (row) => row.label },
            { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
            { header: 'Expires', cell: (row) => date(row.expires_on) },
            { header: 'Required', cell: (row) => (row.is_required ? 'Required' : 'Optional') },
          ]}
        />
      </Section>
    </>
  );
}
