import { useNavigate, useSearchParams, Link } from 'react-router-dom';
import { CUSTOMER_STATUSES, PREFERRED_CONTACTS } from '../../../src/types/models';
import type { Branch, Customer } from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Disclosure } from '@/components/Disclosure';
import { InlineForm } from '@/components/InlineForm';
import { Loading, ErrorNotice } from '@/components/Misc';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/auth/AuthContext';
import { useQuery } from '@/lib/useQuery';
import * as api from '@/lib/api';
import { stamp } from '@/lib/format';

export function Customers(): JSX.Element {
  const { isCorporate } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const search = params.get('search') ?? '';

  const { data, loading, error, reload } = useQuery(
    () =>
      Promise.all([
        api.list<Customer>('/customers', { status, search, page_size: 50 }),
        isCorporate ? api.get<Branch[]>('/branches') : Promise.resolve<Branch[]>([]),
      ]),
    [status, search, isCorporate],
  );

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [customers, branches] = data;

  return (
    <>
      <PageHeader
        title="Customers"
        subtitle={`${customers.meta.total} on the books`}
        actions={
          isCorporate ? (
            <Disclosure label="New customer">
              <NewCustomerForm branches={branches} onDone={reload} />
            </Disclosure>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="search">Search</Label>
          <Input
            id="search"
            type="search"
            defaultValue={search}
            placeholder="Name, email or phone"
            onBlur={(e) => setParam('search', e.target.value.trim())}
            onKeyDown={(e) => {
              if (e.key === 'Enter') setParam('search', e.currentTarget.value.trim());
            }}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="status">Status</Label>
          <Select value={status} onValueChange={(v) => setParam('status', v === 'any' ? '' : v)}>
            <SelectTrigger id="status" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any status</SelectItem>
              {CUSTOMER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        rowKey={(row) => row.id}
        rows={customers.data}
        emptyMessage={
          search || status ? 'No customers match those filters.' : 'No customers yet. Add the first one above.'
        }
        onRowClick={(row) => navigate(`/customers/${row.id}`)}
        columns={[
          {
            header: 'Name',
            cell: (row) => (
              <Link className="text-primary hover:underline" to={`/customers/${row.id}`}>
                {row.first_name} {row.last_name}
              </Link>
            ),
          },
          { header: 'Email', cell: (row) => row.email ?? '—' },
          { header: 'Phone', cell: (row) => row.phone ?? '—' },
          { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
          { header: 'Added', cell: (row) => stamp(row.created_at) },
        ]}
      />
    </>
  );
}

function NewCustomerForm({ branches, onDone }: { branches: Branch[]; onDone: () => void }): JSX.Element {
  const navigate = useNavigate();
  return (
    <InlineForm
      submitLabel="Add customer"
      specs={[
        { name: 'first_name', label: 'First name', required: true },
        { name: 'last_name', label: 'Last name', required: true },
        { name: 'email', label: 'Email', type: 'email' },
        { name: 'phone', label: 'Phone' },
        {
          name: 'preferred_contact',
          label: 'Preferred contact',
          type: 'select',
          options: PREFERRED_CONTACTS.map((c) => ({ value: c, label: c })),
        },
        {
          name: 'branch_id',
          label: 'Branch',
          type: 'select',
          options: branches.map((b) => ({ value: b.id, label: b.name })),
        },
        {
          name: 'status',
          label: 'Status',
          type: 'select',
          options: CUSTOMER_STATUSES.map((s) => ({ value: s, label: s })),
        },
      ]}
      onSubmit={async (values) => {
        const created = await api.post<Customer>('/customers', {
          first_name: values.first_name,
          last_name: values.last_name,
          email: values.email || null,
          phone: values.phone || null,
          preferred_contact: values.preferred_contact,
          branch_id: values.branch_id,
          status: values.status,
        });
        navigate(`/customers/${created.id}`);
      }}
      onDone={onDone}
    />
  );
}
