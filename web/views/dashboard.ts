import * as api from '../api.js';
import { hero, pageHeader, statRow, statTile } from '../components.js';
import { fragment, h, link, section, table } from '../dom.js';
import { count, date, money, percent, relative, statusPill } from '../format.js';
import type { Invoice, WorkOrder } from '../../src/types/models.js';

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

/**
 * Two different screens behind one route, because the two roles open the app
 * for different reasons: corporate wants the roll-up, an operator wants
 * today's work. Showing an operator a company revenue figure they cannot act
 * on — and that the API would refuse them anyway — is not a dashboard.
 */
export async function renderDashboard(root: HTMLElement): Promise<void> {
  if (api.isCorporate()) {
    await renderCorporateDashboard(root);
    return;
  }
  await renderOperatorDashboard(root);
}

async function renderCorporateDashboard(root: HTMLElement): Promise<void> {
  const [branches, upcoming, owing] = await Promise.all([
    api.get<BranchSummary[]>('/reports/branch-summary'),
    api.list<WorkOrder>('/work-orders', {
      status: 'scheduled',
      page_size: 6,
    }),
    api.list<Invoice>('/invoices', { outstanding: true, page_size: 6 }),
  ]);

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
      ratingSum:
        acc.ratingSum + (branch.reviews.average_rating ?? 0) * branch.reviews.answered,
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

  root.appendChild(
    fragment(
      pageHeader(
        'Dashboard',
        branches.length === 1
          ? `${branches[0]?.branch_name ?? ''} — everything to date`
          : `${branches.length} branches — everything to date`,
      ),
      hero(
        'Outstanding',
        money(total.outstanding),
        `of ${money(total.invoiced)} invoiced · ${money(total.overdue)} of it overdue`,
      ),
      statRow(
        statTile('Active contracts', count(total.active)),
        statTile('Visits completed', count(total.completed)),
        statTile(
          'Average rating',
          rating === null ? '—' : rating.toFixed(1),
          total.answered === 0 ? 'nobody has answered yet' : `${total.answered} answered`,
        ),
        statTile(
          'Crew ready',
          count(total.crew),
          total.pendingCrew > 0 ? `${total.pendingCrew} not assignable` : 'everyone cleared',
        ),
      ),
      section(
        branches.length === 1 ? 'Branch' : 'Branches',
        table<BranchSummary>(
          [
            {
              header: 'Branch',
              cell: (row) => `${row.branch_name} (${row.province})`,
            },
            { header: 'Customers', numeric: true, cell: (row) => count(row.customers.total) },
            {
              header: 'Won',
              numeric: true,
              cell: (row) => percent(row.pipeline.win_rate),
            },
            { header: 'Active', numeric: true, cell: (row) => count(row.contracts.active) },
            {
              header: 'Invoiced',
              numeric: true,
              cell: (row) => money(row.revenue.invoiced),
            },
            {
              header: 'Outstanding',
              numeric: true,
              cell: (row) => money(row.revenue.outstanding),
            },
            {
              header: 'Rating',
              numeric: true,
              cell: (row) =>
                row.reviews.average_rating === null
                  ? '—'
                  : row.reviews.average_rating.toFixed(1),
            },
          ],
          branches,
          'No branches yet.',
        ),
      ),
      h(
        'div',
        { class: 'split' },
        section(
          'Next on the board',
          table<WorkOrder>(
            [
              {
                header: 'When',
                cell: (row) => relative(row.scheduled_for),
              },
              {
                header: 'Visit',
                cell: (row) =>
                  link(`/work-orders/${row.id}`, row.service_type.replace(/_/g, ' ')),
              },
              { header: 'Status', cell: (row) => statusPill(row.status) },
            ],
            upcoming.data,
            'Nothing scheduled.',
          ),
        ),
        section(
          'Money to chase',
          table<Invoice>(
            [
              {
                header: 'Invoice',
                cell: (row) => link(`/invoices/${row.id}`, date(row.due_date)),
              },
              {
                header: 'Owing',
                numeric: true,
                cell: (row) => money(Number(row.amount_due) - Number(row.amount_paid)),
              },
              { header: 'Status', cell: (row) => statusPill(row.status) },
            ],
            owing.data,
            'Everything is settled.',
          ),
        ),
      ),
    ),
  );
}

async function renderOperatorDashboard(root: HTMLElement): Promise<void> {
  const user = api.currentUser();
  if (!user) throw new api.Unauthenticated('No session');

  const [mine, compliance] = await Promise.all([
    api.list<WorkOrder>('/work-orders', {
      assigned_user_id: user.id,
      page_size: 25,
    }),
    api.get<Compliance>(`/operators/${user.id}/compliance`),
  ]);

  const open = mine.data.filter((visit) =>
    ['scheduled', 'en_route', 'in_progress'].includes(visit.status),
  );
  const done = mine.data.filter((visit) => visit.status === 'completed').length;
  const expiring = compliance.items
    .filter((item) => item.status === 'approved' && item.expires_on)
    .sort((a, b) => (a.expires_on ?? '').localeCompare(b.expires_on ?? ''))[0];

  root.appendChild(
    fragment(
      pageHeader(`Morning, ${user.first_name}`, 'Your visits and your paperwork'),
      hero(
        'Visits still open',
        count(open.length),
        open.length === 0 ? 'nothing outstanding' : 'oldest first below',
      ),
      statRow(
        statTile('Completed', count(done)),
        statTile(
          'Assignable',
          compliance.assignable ? 'Yes' : 'No',
          compliance.assignable
            ? 'documents all in date'
            : `${compliance.missing_required.length} required document(s) outstanding`,
        ),
        statTile(
          'Next expiry',
          expiring?.expires_on ? date(expiring.expires_on) : '—',
          expiring?.label,
        ),
      ),
      section(
        'Your visits',
        table<WorkOrder>(
          [
            { header: 'When', cell: (row) => relative(row.scheduled_for) },
            {
              header: 'Visit',
              cell: (row) =>
                link(`/work-orders/${row.id}`, row.service_type.replace(/_/g, ' ')),
            },
            { header: 'Status', cell: (row) => statusPill(row.status) },
          ],
          mine.data,
          'Nothing assigned to you yet.',
        ),
      ),
      section(
        'Your documents',
        table<ComplianceItem>(
          [
            { header: 'Document', cell: (row) => row.label },
            { header: 'Status', cell: (row) => statusPill(row.status) },
            { header: 'Expires', cell: (row) => date(row.expires_on) },
            {
              header: 'Required',
              cell: (row) => (row.is_required ? 'Required' : 'Optional'),
            },
          ],
          compliance.items,
          'No requirements apply to your branch.',
        ),
      ),
    ),
  );
}
