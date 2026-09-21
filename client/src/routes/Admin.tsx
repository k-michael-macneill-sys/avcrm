import type { Branch, PublicUser } from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { DataTable } from '@/components/DataTable';
import { InlineForm } from '@/components/InlineForm';
import { Loading, ErrorNotice } from '@/components/Misc';
import { useQuery } from '@/lib/useQuery';
import * as api from '@/lib/api';

/**
 * Where the company itself is set up: its branches, and the people who work
 * in them.
 *
 * Corporate only, and it is the only way an account comes into existence.
 * Self-signup is off by default (see ALLOW_SELF_REGISTRATION), because an
 * endpoint that mints accounts has no business facing the internet on a
 * system holding customers' names and addresses. Somebody's account exists
 * before they arrive, created here by the person who hired them.
 */

const PROVINCES = ['AB', 'BC', 'MB', 'NB', 'NL', 'NS', 'NT', 'NU', 'ON', 'PE', 'QC', 'SK', 'YT'];

/**
 * Three practical roles over the two the database has.
 *
 * A branch manager is a corporate user tied to one branch and named as that
 * branch's manager — corporate because they need the branch's numbers, tied
 * to a branch because that is whose crew they run.
 */
type Position = 'operator' | 'branch_manager' | 'corporate';

const POSITIONS: { value: Position; label: string; help: string }[] = [
  {
    value: 'operator',
    label: 'Operator — clears driveways',
    help: 'Sees their own branch and only the visits assigned to them. Cannot be given work until their documents are approved.',
  },
  {
    value: 'branch_manager',
    label: 'Branch manager — runs one branch',
    help: 'Full access, and named as that branch’s manager, so they get the notices when a charge fails or an operator’s papers lapse.',
  },
  {
    value: 'corporate',
    label: 'Corporate — sees every branch',
    help: 'The whole company: every branch’s numbers, every invoice, and the settings.',
  },
];

function branchName(branches: Branch[], id: string | null): string {
  if (id === null) return 'Every branch';
  return branches.find((b) => b.id === id)?.name ?? 'Unknown';
}

function positionOf(user: PublicUser, branches: Branch[]): string {
  if (user.role === 'operator') return 'Operator';
  const managed = branches.find((b) => b.manager_user_id === user.id);
  if (managed) return `Manager, ${managed.name}`;
  return 'Corporate';
}

export function Admin(): JSX.Element {
  const { data, loading, error, reload } = useQuery(
    () =>
      Promise.all([
        api.get<Branch[]>('/branches'),
        api.list<PublicUser>('/users', { page_size: '100' }),
      ]),
    [],
  );

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [branches, users] = data;

  return (
    <>
      <PageHeader title="Company" subtitle="Branches, and the people who work in them" />
      <BranchCard branches={branches} onDone={reload} />
      <PeopleCard branches={branches} users={users.data} onDone={reload} />
    </>
  );
}

function BranchCard({ branches, onDone }: { branches: Branch[]; onDone: () => void }): JSX.Element {
  return (
    <Section title="Branches" className="mb-4">
      <DataTable
        rowKey={(row) => row.id}
        rows={branches}
        emptyMessage="No branches yet. Add the first one below."
        columns={[
          { header: 'Branch', cell: (b) => b.name },
          { header: 'Province', cell: (b) => b.province },
          { header: 'Manager', cell: (b) => (b.manager_user_id ? 'Named' : '—') },
          { header: 'Status', cell: (b) => b.status },
        ]}
      />

      <h3 className="mb-2 mt-4 text-sm font-semibold text-foreground">Add a branch</h3>
      <InlineForm
        submitLabel="Add branch"
        specs={[
          { name: 'name', label: 'Branch name', required: true, placeholder: 'Kingston' },
          {
            name: 'province',
            label: 'Province',
            type: 'select',
            required: true,
            options: PROVINCES.map((p) => ({ value: p, label: p })),
          },
          {
            name: 'timezone',
            label: 'Timezone',
            value: 'America/Toronto',
            help: 'Decides when a scheduled visit falls, and when the nightly jobs consider a day to have ended.',
          },
        ]}
        onSubmit={(values) =>
          api.post('/branches', {
            name: values.name,
            province: values.province,
            timezone: values.timezone || 'America/Toronto',
          })
        }
        onDone={onDone}
      />
    </Section>
  );
}

function PeopleCard({
  branches,
  users,
  onDone,
}: {
  branches: Branch[];
  users: PublicUser[];
  onDone: () => void;
}): JSX.Element {
  if (branches.length === 0) {
    return (
      <Section title="People">
        <p className="text-sm text-muted-foreground">Add a branch first — an operator has to belong to one.</p>
      </Section>
    );
  }

  return (
    <Section title="People">
      <DataTable
        rowKey={(row) => row.id}
        rows={users}
        emptyMessage="Nobody yet."
        columns={[
          { header: 'Name', cell: (u) => `${u.first_name} ${u.last_name}` },
          { header: 'Email', cell: (u) => u.email },
          { header: 'Position', cell: (u) => positionOf(u, branches) },
          { header: 'Branch', cell: (u) => branchName(branches, u.branch_id) },
          { header: 'Active', cell: (u) => (u.is_active ? 'Yes' : 'No') },
        ]}
      />

      <h3 className="mb-2 mt-4 text-sm font-semibold text-foreground">Add someone</h3>
      <InlineForm
        submitLabel="Add person"
        specs={[
          { name: 'first_name', label: 'First name', required: true },
          { name: 'last_name', label: 'Last name', required: true },
          { name: 'email', label: 'Email', type: 'email', required: true },
          { name: 'phone', label: 'Phone', placeholder: '613-555-0101' },
          {
            name: 'position',
            label: 'Position',
            type: 'select',
            required: true,
            options: POSITIONS.map((p) => ({ value: p.value, label: p.label })),
            help: POSITIONS.map((p) => `${p.label.split('—')[0]?.trim()}: ${p.help}`).join(' '),
          },
          {
            name: 'branch_id',
            label: 'Branch',
            type: 'select',
            required: true,
            options: branches.map((b) => ({ value: b.id, label: `${b.name} (${b.province})` })),
            help: 'Ignored for a corporate account, which sees every branch.',
          },
          {
            name: 'password',
            label: 'Temporary password',
            type: 'password',
            required: true,
            help: 'Give it to them directly and have them change it. At least 8 characters.',
          },
        ]}
        onSubmit={async (values) => {
          const position = values.position as Position;
          // Corporate sees every branch, so tying the account to one would
          // only narrow it. A manager keeps their branch: it is whose crew
          // they run, and PATCH /branches checks the manager belongs to it.
          const branchId = position === 'corporate' ? null : (values.branch_id ?? null);

          const created = await api.post<PublicUser>('/users', {
            email: values.email,
            password: values.password,
            first_name: values.first_name,
            last_name: values.last_name,
            phone: values.phone || null,
            role: position === 'operator' ? 'operator' : 'corporate',
            branch_id: branchId,
          });

          if (position === 'branch_manager' && branchId) {
            await api.patch(`/branches/${branchId}`, { manager_user_id: created.id });
          }
        }}
        onDone={onDone}
      />
    </Section>
  );
}
