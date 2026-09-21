import { Link, useSearchParams } from 'react-router-dom';
import { INVOICE_STATUSES } from '../../../src/types/models';
import type { Invoice } from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Loading, ErrorNotice } from '@/components/Misc';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQuery } from '@/lib/useQuery';
import * as api from '@/lib/api';
import { date, money } from '@/lib/format';

export function Invoices(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const outstanding = params.get('outstanding') === 'true';

  const { data: invoices, loading, error } = useQuery(
    () => api.list<Invoice>('/invoices', { status, outstanding: outstanding ? true : undefined, page_size: 100 }),
    [status, outstanding],
  );

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!invoices) return <Loading />;

  const owed = invoices.data.reduce((sum, row) => sum + (Number(row.amount_due) - Number(row.amount_paid)), 0);

  return (
    <>
      <PageHeader title="Invoices" subtitle={`${invoices.meta.total} shown · ${money(owed)} outstanding`} />

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="status">Status</Label>
          <Select value={status} onValueChange={(v) => setParam('status', v === 'any' ? '' : v)}>
            <SelectTrigger id="status" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="any">Any status</SelectItem>
              {INVOICE_STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {s}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="outstanding">Show</Label>
          <Select value={outstanding ? 'true' : 'everything'} onValueChange={(v) => setParam('outstanding', v === 'true' ? 'true' : '')}>
            <SelectTrigger id="outstanding" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="everything">Everything</SelectItem>
              <SelectItem value="true">Still owing</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        rowKey={(row) => row.id}
        rows={invoices.data}
        emptyMessage="No invoices match those filters."
        columns={[
          {
            header: 'Period',
            cell: (row) => (
              <Link className="text-primary hover:underline" to={`/invoices/${row.id}`}>
                {date(row.billing_period_start)} – {date(row.billing_period_end)}
              </Link>
            ),
          },
          { header: 'Due', cell: (row) => date(row.due_date) },
          { header: 'Amount', numeric: true, cell: (row) => money(row.amount_due) },
          { header: 'Paid', numeric: true, cell: (row) => money(row.amount_paid) },
          { header: 'Owing', numeric: true, cell: (row) => money(Number(row.amount_due) - Number(row.amount_paid)) },
          { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
        ]}
      />
    </>
  );
}
