import { Link, useParams } from 'react-router-dom';
import { PAYMENT_METHODS } from '../../../src/types/models';
import type { Customer, Invoice, Payment } from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Disclosure } from '@/components/Disclosure';
import { InlineForm } from '@/components/InlineForm';
import { DownloadButton } from '@/components/FileWidgets';
import { Field, FieldList, Loading, ErrorNotice } from '@/components/Misc';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/auth/AuthContext';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';
import * as api from '@/lib/api';
import { date, money, stamp } from '@/lib/format';

interface InvoiceDetailModel extends Invoice {
  payments: Payment[];
}

export function InvoiceDetail(): JSX.Element {
  const { id = '' } = useParams();
  const { isCorporate } = useAuth();

  const { data, loading, error, reload } = useQuery(async () => {
    const invoice = await api.get<InvoiceDetailModel>(`/invoices/${id}`);
    const customer = await api.get<Customer>(`/customers/${invoice.customer_id}`);
    return { invoice, customer };
  }, [id]);

  const { run, pending, error: actionError } = useSubmit(reload);

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const { invoice, customer } = data;
  const owing = Number(invoice.amount_due) - Number(invoice.amount_paid);
  const payable = ['sent', 'overdue', 'paid'].includes(invoice.status);

  return (
    <>
      <PageHeader
        title={`${money(invoice.amount_due)} — ${customer.first_name} ${customer.last_name}`}
        subtitle={`${date(invoice.billing_period_start)} to ${date(invoice.billing_period_end)}`}
      />

      <Section title="Invoice" className="mb-4">
        <FieldList>
          <Field label="Status">
            <StatusPill status={invoice.status} />
          </Field>
          <Field label="Due date">{date(invoice.due_date)}</Field>
          <Field label="Amount">{money(invoice.amount_due)}</Field>
          <Field label="Paid">{money(invoice.amount_paid)}</Field>
          <Field label="Owing">{money(owing)}</Field>
          <Field label="Sent">{stamp(invoice.sent_at)}</Field>
          <Field label="Contract">
            <Link className="text-primary hover:underline" to={`/contracts/${invoice.contract_id}`}>
              View the contract
            </Link>
          </Field>
        </FieldList>

        {actionError ? <ErrorNotice message={actionError} /> : null}
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <DownloadButton path={`/invoices/${id}/pdf`} fileName={`invoice-${id.slice(0, 8)}.pdf`} label="Download the invoice" />
          {invoice.status === 'draft' ? (
            <Button type="button" disabled={pending} onClick={() => run(() => api.post(`/invoices/${id}/send`))}>
              Send to customer
            </Button>
          ) : null}
          {invoice.status !== 'void' && invoice.status !== 'paid' ? (
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => run(() => api.post(`/invoices/${id}/void`))}
            >
              Void
            </Button>
          ) : null}
        </div>
      </Section>

      <Section title="Payments">
        <DataTable
          rowKey={(row) => row.id}
          rows={invoice.payments}
          emptyMessage="Nothing paid against this invoice yet."
          columns={[
            { header: 'Method', cell: (row) => row.method.replace(/_/g, ' ') },
            { header: 'Amount', numeric: true, cell: (row) => money(row.amount) },
            { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
            { header: 'Processed', cell: (row) => stamp(row.processed_at) },
            { header: 'Note', cell: (row) => row.failure_reason ?? '' },
            {
              header: '',
              cell: (row) =>
                isCorporate && row.status === 'succeeded' ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={pending}
                    onClick={() => run(() => api.post(`/payments/${row.id}/refund`))}
                  >
                    Refund
                  </Button>
                ) : null,
            },
          ]}
        />
        {payable ? (
          <Disclosure label="Record payment">
            <InlineForm
              submitLabel="Record it"
              specs={[
                { name: 'amount', label: 'Amount', type: 'number', step: '0.01', value: owing > 0 ? owing.toFixed(2) : '0.00' },
                {
                  name: 'method',
                  label: 'Method',
                  type: 'select',
                  options: PAYMENT_METHODS.map((m) => ({ value: m, label: m.replace(/_/g, ' ') })),
                },
                {
                  name: 'status',
                  label: 'Outcome',
                  type: 'select',
                  options: [
                    { value: 'succeeded', label: 'succeeded' },
                    { value: 'failed', label: 'failed' },
                    { value: 'pending', label: 'pending' },
                  ],
                },
                { name: 'failure_reason', label: 'Failure reason', placeholder: 'if it failed' },
                { name: 'provider_transaction_id', label: 'Processor reference' },
              ]}
              onSubmit={(values) =>
                api.post(`/invoices/${id}/payments`, {
                  amount: Number(values.amount),
                  method: values.method,
                  status: values.status,
                  failure_reason: values.failure_reason || null,
                  provider_transaction_id: values.provider_transaction_id || null,
                })
              }
              onDone={reload}
            />
          </Disclosure>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">A {invoice.status} invoice takes no payment.</p>
        )}
      </Section>
    </>
  );
}
