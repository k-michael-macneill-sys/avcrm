import * as api from '../api.js';
import { filterBar, labelled, pageHeader, select } from '../components.js';
import { field, fieldList, fragment, h, link, section, table } from '../dom.js';
import { buildForm, disclosure, errorLine, submitter } from '../form.js';
import { date, money, statusPill, stamp } from '../format.js';
import * as router from '../router.js';
import { INVOICE_STATUSES, PAYMENT_METHODS } from '../../src/types/models.js';
import type { Customer, Invoice, Payment } from '../../src/types/models.js';

interface InvoiceDetail extends Invoice {
  payments: Payment[];
}

export async function renderInvoices(root: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  const status = query.get('status') ?? '';
  const outstanding = query.get('outstanding') === 'true';

  const invoices = await api.list<Invoice>('/invoices', {
    status,
    outstanding: outstanding ? true : undefined,
    page_size: 100,
  });

  const owed = invoices.data.reduce(
    (sum, row) => sum + (Number(row.amount_due) - Number(row.amount_paid)),
    0,
  );

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(location.search);
    if (value) next.set(key, value);
    else next.delete(key);
    const qs = next.toString();
    router.navigate(`/invoices${qs ? `?${qs}` : ''}`, true);
  };

  root.appendChild(
    fragment(
      pageHeader('Invoices', `${invoices.meta.total} shown · ${money(owed)} outstanding`),
      filterBar(
        labelled(
          'Status',
          select(
            [
              { value: '', label: 'Any status' },
              ...INVOICE_STATUSES.map((s) => ({ value: s, label: s })),
            ],
            status,
            (value) => setParam('status', value),
          ),
        ),
        labelled(
          'Show',
          select(
            [
              { value: '', label: 'Everything' },
              { value: 'true', label: 'Still owing' },
            ],
            outstanding ? 'true' : '',
            (value) => setParam('outstanding', value),
          ),
        ),
      ),
      table<Invoice>(
        [
          {
            header: 'Period',
            cell: (row) =>
              link(
                `/invoices/${row.id}`,
                `${date(row.billing_period_start)} – ${date(row.billing_period_end)}`,
              ),
          },
          { header: 'Due', cell: (row) => date(row.due_date) },
          { header: 'Amount', numeric: true, cell: (row) => money(row.amount_due) },
          { header: 'Paid', numeric: true, cell: (row) => money(row.amount_paid) },
          {
            header: 'Owing',
            numeric: true,
            cell: (row) => money(Number(row.amount_due) - Number(row.amount_paid)),
          },
          { header: 'Status', cell: (row) => statusPill(row.status) },
        ],
        invoices.data,
        'No invoices match those filters.',
      ),
    ),
  );
}

export async function renderInvoice(root: HTMLElement, params: string[]): Promise<void> {
  const id = params[0] ?? '';
  const invoice = await api.get<InvoiceDetail>(`/invoices/${id}`);
  const customer = await api.get<Customer>(`/customers/${invoice.customer_id}`);

  const error = errorLine();
  const run = submitter(error, () => router.render());
  const owing = Number(invoice.amount_due) - Number(invoice.amount_paid);
  const payable = ['sent', 'overdue', 'paid'].includes(invoice.status);

  root.appendChild(
    fragment(
      pageHeader(
        `${money(invoice.amount_due)} — ${customer.first_name} ${customer.last_name}`,
        `${date(invoice.billing_period_start)} to ${date(invoice.billing_period_end)}`,
      ),
      section(
        'Invoice',
        fieldList(
          field('Status', statusPill(invoice.status)),
          field('Due date', date(invoice.due_date)),
          field('Amount', money(invoice.amount_due)),
          field('Paid', money(invoice.amount_paid)),
          field('Owing', money(owing)),
          field('Sent', stamp(invoice.sent_at)),
          field('Contract', link(`/contracts/${invoice.contract_id}`, 'View the contract')),
        ),
        error,
        h(
          'div',
          { class: 'actions' },
          invoice.status === 'draft'
            ? run(
                'Send to customer',
                () => api.post(`/invoices/${id}/send`),
                'primary',
              )
            : null,
          invoice.status !== 'void' && invoice.status !== 'paid'
            ? run('Void', () => api.post(`/invoices/${id}/void`), 'danger')
            : null,
        ),
      ),
      section(
        'Payments',
        table<Payment>(
          [
            { header: 'Method', cell: (row) => row.method.replace(/_/g, ' ') },
            { header: 'Amount', numeric: true, cell: (row) => money(row.amount) },
            { header: 'Status', cell: (row) => statusPill(row.status) },
            { header: 'Processed', cell: (row) => stamp(row.processed_at) },
            { header: 'Note', cell: (row) => row.failure_reason ?? '' },
            {
              header: '',
              cell: (row) =>
                api.isCorporate() && row.status === 'succeeded'
                  ? run(
                      'Refund',
                      () => api.post(`/payments/${row.id}/refund`),
                      'danger',
                    )
                  : null,
            },
          ],
          invoice.payments,
          'Nothing paid against this invoice yet.',
        ),
        payable ? paymentPanel(id, owing) : h('p', { class: 'empty' }, `A ${invoice.status} invoice takes no payment.`),
      ),
    ),
  );
}

function paymentPanel(invoiceId: string, owing: number): HTMLElement {
  return disclosure('Record payment', () => {
    const error = errorLine();
    const form = buildForm([
      {
        name: 'amount',
        label: 'Amount',
        type: 'number',
        step: '0.01',
        value: owing > 0 ? owing.toFixed(2) : '0.00',
      },
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
    ]);

    const run = submitter(error, () => router.render());

    return h(
      'div',
      { class: 'card' },
      form.node,
      error,
      h(
        'div',
        { class: 'actions' },
        run(
          'Record it',
          async () => {
            const values = form.values();
            await api.post(`/invoices/${invoiceId}/payments`, {
              amount: Number(values.amount),
              method: values.method,
              status: values.status,
              failure_reason: values.failure_reason || null,
              provider_transaction_id: values.provider_transaction_id || null,
            });
          },
          'primary',
        ),
      ),
    );
  });
}
