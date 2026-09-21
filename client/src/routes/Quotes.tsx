import { Link, useSearchParams } from 'react-router-dom';
import { QUOTE_STATUSES } from '../../../src/types/models';
import type { Quote } from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Loading, ErrorNotice } from '@/components/Misc';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQuery } from '@/lib/useQuery';
import * as api from '@/lib/api';
import { date, money, stamp } from '@/lib/format';

export function Quotes(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';

  const { data: quotes, loading, error } = useQuery(
    () => api.list<Quote>('/quotes', { status, page_size: 50 }),
    [status],
  );

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!quotes) return <Loading />;

  return (
    <>
      <PageHeader title="Quotes" subtitle={`${quotes.meta.total} written`} />

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
            {QUOTE_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {s}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <DataTable
        rowKey={(row) => row.id}
        rows={quotes.data}
        emptyMessage="No quotes match those filters."
        columns={[
          {
            header: 'Quote',
            cell: (row) => (
              <Link className="text-primary hover:underline" to={`/quotes/${row.id}`}>
                {stamp(row.created_at)}
              </Link>
            ),
          },
          { header: 'Billing', cell: (row) => row.billing_type.replace(/_/g, ' ') },
          { header: 'List', numeric: true, cell: (row) => money(row.initial_price) },
          { header: 'Sold at', numeric: true, cell: (row) => money(row.discounted_price) },
          { header: 'Season', cell: (row) => `${date(row.season_start)} – ${date(row.season_end)}` },
          { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
        ]}
      />
    </>
  );
}
