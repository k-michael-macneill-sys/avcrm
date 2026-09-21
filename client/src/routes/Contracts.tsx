import { Link, useSearchParams } from 'react-router-dom';
import { CONTRACT_STATUSES } from '../../../src/types/models';
import type { Contract } from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Loading, ErrorNotice } from '@/components/Misc';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQuery } from '@/lib/useQuery';
import * as api from '@/lib/api';
import { stamp } from '@/lib/format';

export function Contracts(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';

  const { data: contracts, loading, error } = useQuery(
    () => api.list<Contract>('/contracts', { status, page_size: 50 }),
    [status],
  );

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!contracts) return <Loading />;

  return (
    <>
      <PageHeader title="Contracts" subtitle={`${contracts.meta.total} signed`} />

      <div className="mb-4 flex flex-col gap-1">
        <Label htmlFor="status">Status</Label>
        <Select
          value={status}
          onValueChange={(v) => {
            const next = new URLSearchParams(params);
            if (v === 'any') next.delete('status');
            else next.set('status', v);
            setParams(next, { replace: true });
          }}
        >
          <SelectTrigger id="status" className="w-48">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="any">Any status</SelectItem>
            {CONTRACT_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        rowKey={(row) => row.id}
        rows={contracts.data}
        emptyMessage="Nothing signed yet."
        columns={[
          {
            header: 'Signed',
            cell: (row) => (
              <Link className="text-primary hover:underline" to={`/contracts/${row.id}`}>
                {stamp(row.signed_at)}
              </Link>
            ),
          },
          { header: 'Terms', cell: (row) => row.terms_version },
          {
            header: 'Card',
            cell: (row) =>
              row.payment_method_last4
                ? `${row.payment_method_brand ?? 'card'} ••••${row.payment_method_last4}`
                : 'none on file',
          },
          { header: 'Signed from', cell: (row) => row.signed_ip ?? '—' },
          { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
        ]}
      />
    </>
  );
}
