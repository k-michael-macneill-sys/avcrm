import * as React from 'react';
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

      {invoice.status === 'sent' || invoice.status === 'overdue' ? <PayLink invoiceId={id} /> : null}

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

/**
 * The link the customer was emailed, for when they would rather have it by
 * text or read out over the phone. Fetched on demand: asking makes the token
 * if the invoice has never had one.
 */
function PayLink({ invoiceId }: { invoiceId: string }): JSX.Element {
  const [link, setLink] = React.useState<{ url: string; takes_payments: boolean } | null>(null);
  const [note, setNote] = React.useState('');
  const [pending, setPending] = React.useState(false);

  const fetchLink = (): void => {
    setPending(true);
    api
      .get<{ url: string; takes_payments: boolean }>(`/invoices/${invoiceId}/pay-link`)
      .then(setLink)
      .catch((err: unknown) => setNote(err instanceof api.ApiError ? err.full : String(err)))
      .finally(() => setPending(false));
  };

  const copy = (): void => {
    if (!link) return;
    navigator.clipboard.writeText(link.url).then(
      () => setNote('Copied.'),
      () => setNote('Could not copy — select the link and copy it by hand.'),
    );
  };

  return (
    <Section title="Customer payment link" className="mb-4">
      {link ? (
        <>
          <p className="mb-2 break-all font-mono text-xs">{link.url}</p>
          {link.takes_payments ? null : (
            <p className="mb-2 text-xs text-muted-foreground">
              No card processor is switched on, so the customer can view this invoice but not pay it
              online. Connect Square under Settings.
            </p>
          )}
          <Button type="button" size="sm" variant="secondary" onClick={copy}>
            Copy link
          </Button>
        </>
      ) : (
        <>
          <p className="mb-2 text-xs text-muted-foreground">
            The same link that goes out in the invoice email. The customer can pay from it without
            an account.
          </p>
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={fetchLink}>
            Show the link
          </Button>
        </>
      )}
      {note ? <p className="mt-2 text-xs text-muted-foreground" aria-live="polite">{note}</p> : null}
    </Section>
  );
}
