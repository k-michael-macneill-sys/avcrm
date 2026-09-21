import { Link, useSearchParams } from 'react-router-dom';
import { SERVICE_TYPES, WORK_ORDER_STATUSES } from '../../../src/types/models';
import type { Contract, Property, PublicUser, WorkOrder } from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Disclosure } from '@/components/Disclosure';
import { InlineForm } from '@/components/InlineForm';
import { Loading, ErrorNotice } from '@/components/Misc';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useAuth } from '@/auth/AuthContext';
import { useQuery } from '@/lib/useQuery';
import * as api from '@/lib/api';
import { relative, stamp } from '@/lib/format';

export function WorkOrders(): JSX.Element {
  const { user, isCorporate } = useAuth();
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const mine = params.get('mine') === 'true';

  const { data, loading, error, reload } = useQuery(
    () =>
      Promise.all([
        api.list<WorkOrder>('/work-orders', {
          status,
          assigned_user_id: mine && user ? user.id : undefined,
          page_size: 100,
        }),
        isCorporate ? api.get<PublicUser[]>('/operators') : Promise.resolve<PublicUser[]>([]),
      ]),
    [status, mine, isCorporate, user?.id],
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

  const [visits, operators] = data;
  const operatorName = (userId: string | null): string => {
    if (!userId) return 'Unassigned';
    const found = operators.find((o) => o.id === userId);
    return found ? `${found.first_name} ${found.last_name}` : 'Assigned';
  };

  return (
    <>
      <PageHeader
        title="Dispatch"
        subtitle={`${visits.meta.total} visits on the board`}
        actions={
          isCorporate ? (
            <Disclosure label="New visit">
              <NewVisitForm onDone={reload} />
            </Disclosure>
          ) : undefined
        }
      />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="status">Status</Label>
          <Select value={status} onValueChange={(v) => setParam('status', v === 'any' ? '' : v)}>
            <SelectTrigger id="status" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any status</SelectItem>
              {WORK_ORDER_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s.replace(/_/g, ' ')}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="mine">Whose</Label>
          <Select value={mine ? 'true' : 'everyone'} onValueChange={(v) => setParam('mine', v === 'true' ? 'true' : '')}>
            <SelectTrigger id="mine" className="w-36">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everyone">Everyone</SelectItem>
              <SelectItem value="true">Mine</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        rowKey={(row) => row.id}
        rows={visits.data}
        emptyMessage="Nothing on the board for those filters."
        columns={[
          {
            header: 'When',
            cell: (row) => (
              <Link className="text-primary hover:underline" to={`/work-orders/${row.id}`}>
                {stamp(row.scheduled_for)}
              </Link>
            ),
          },
          { header: 'Due', cell: (row) => relative(row.scheduled_for) },
          { header: 'Service', cell: (row) => row.service_type.replace(/_/g, ' ') },
          { header: 'Operator', cell: (row) => (isCorporate ? operatorName(row.assigned_user_id) : '—') },
          { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
        ]}
      />
    </>
  );
}

function NewVisitForm({ onDone }: { onDone: () => void }): JSX.Element {
  const { data } = useQuery(
    () =>
      Promise.all([
        api.list<Contract>('/contracts', { status: 'active', page_size: 100 }),
        api.get<PublicUser[]>('/operators', { assignable: true }),
      ]),
    [],
  );
  const { data: properties } = useQuery(async () => {
    if (!data) return [];
    const [contracts] = data;
    return Promise.all(contracts.data.map((c) => api.get<Property>(`/properties/${c.property_id}`)));
  }, [data]);

  if (!data || !properties) return <Loading />;
  const [contracts, operators] = data;

  return (
    <InlineForm
      submitLabel="Book it"
      specs={[
        {
          name: 'contract_id',
          label: 'Property',
          type: 'select',
          options: contracts.data.map((contract, index) => ({
            value: contract.id,
            label: properties[index]?.address_line1 ?? contract.id,
          })),
        },
        {
          name: 'assigned_user_id',
          label: 'Operator',
          type: 'select',
          options: [
            { value: '', label: 'Unassigned' },
            ...operators.map((o) => ({ value: o.id, label: `${o.first_name} ${o.last_name}` })),
          ],
        },
        {
          name: 'service_type',
          label: 'Service',
          type: 'select',
          options: SERVICE_TYPES.map((s) => ({ value: s, label: s.replace(/_/g, ' ') })),
        },
        {
          name: 'scheduled_for',
          label: 'Scheduled for',
          type: 'datetime-local',
          value: new Date(Date.now() + 3_600_000).toISOString().slice(0, 16),
        },
      ]}
      onSubmit={(values) =>
        api.post<WorkOrder>('/work-orders', {
          contract_id: values.contract_id,
          assigned_user_id: values.assigned_user_id || null,
          service_type: values.service_type,
          scheduled_for: new Date(values.scheduled_for ?? '').toISOString(),
        })
      }
      onDone={onDone}
    />
  );
}
