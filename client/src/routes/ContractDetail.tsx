import { Link, useParams } from 'react-router-dom';
import type {
  CardSetup,
  ChecklistRequirement,
  Contract,
  ContractChecklistItem,
  Customer,
  Invoice,
  Property,
  WorkOrder,
} from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { FileImage } from '@/components/FileWidgets';
import { Field, FieldList, Loading, ErrorNotice } from '@/components/Misc';
import { Button } from '@/components/ui/button';
import { useAuth } from '@/auth/AuthContext';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';
import * as api from '@/lib/api';
import { date, money, stamp } from '@/lib/format';

interface ContractDetailModel extends Contract {
  checklist: ContractChecklistItem[];
}

const EMPTY_PAGE = { data: [] as Invoice[], meta: { page: 1, page_size: 0, total: 0, total_pages: 0 } };

export function ContractDetail(): JSX.Element {
  const { id = '' } = useParams();
  const { isCorporate } = useAuth();

  const { data, loading, error, reload } = useQuery(async () => {
    const contract = await api.get<ContractDetailModel>(`/contracts/${id}`);
    const [property, customer, requirements, visits, cards, invoices] = await Promise.all([
      api.get<Property>(`/properties/${contract.property_id}`),
      api.get<Customer>(`/customers/${contract.customer_id}`),
      api.get<ChecklistRequirement[]>('/checklist-requirements'),
      api.list<WorkOrder>('/work-orders', { contract_id: id, page_size: 50 }),
      api.list<CardSetup>('/card-setups', { contract_id: id, page_size: 20 }),
      isCorporate ? api.list<Invoice>('/invoices', { contract_id: id, page_size: 50 }) : Promise.resolve(EMPTY_PAGE),
    ]);
    return { contract, property, customer, requirements, visits, cards, invoices };
  }, [id, isCorporate]);

  const { run, pending, error: actionError } = useSubmit(reload);

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const { contract, property, customer, requirements, visits, cards, invoices } = data;
  const requirementOf = (code: string): ChecklistRequirement | undefined =>
    requirements.find((r) => r.code === code);
  const isActive = contract.status === 'active';

  return (
    <>
      <PageHeader
        title={property.address_line1}
        subtitle={`${customer.first_name} ${customer.last_name} — signed ${stamp(contract.signed_at)}`}
      />

      <Section title="Contract" className="mb-4">
        <FieldList>
          <Field label="Status">
            <StatusPill status={contract.status} />
          </Field>
          <Field label="Terms version">{contract.terms_version}</Field>
          <Field label="Payment method">
            {contract.payment_method_last4
              ? `${contract.payment_method_brand ?? 'card'} ••••${contract.payment_method_last4}`
              : 'none on file'}
          </Field>
          <Field label="Signed from">{contract.signed_ip ?? '—'}</Field>
          <Field label="Signed at">
            {contract.signed_lat && contract.signed_lng
              ? `${contract.signed_lat}, ${contract.signed_lng}`
              : 'no coordinates'}
          </Field>
          <Field label="Quote">
            <Link className="text-primary hover:underline" to={`/quotes/${contract.quote_id}`}>
              View the quote
            </Link>
          </Field>
        </FieldList>

        <div className="mt-4">
          <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
            Signature
          </p>
          <FileImage
            fileKey={contract.signature_image_url}
            alt="The signature captured at the door"
            className="block w-full max-w-[340px] rounded-md border border-border bg-white p-1.5"
          />
        </div>

        {actionError ? <ErrorNotice message={actionError} /> : null}
        {isActive ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              type="button"
              disabled={pending}
              onClick={() => run(() => api.patch(`/contracts/${id}/status`, { status: 'completed' }))}
            >
              Mark completed
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => run(() => api.patch(`/contracts/${id}/status`, { status: 'cancelled' }))}
            >
              Cancel contract
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-sm text-muted-foreground">A {contract.status} contract is final.</p>
        )}
      </Section>

      <CardSection id={id} contract={contract} setups={cards.data} isActive={isActive} run={run} pending={pending} />

      <Section title="Signature checklist" className="mb-4">
        <DataTable
          rowKey={(row) => row.item_code}
          rows={contract.checklist}
          emptyMessage="No checklist on this contract."
          columns={[
            { header: 'Item', cell: (row) => requirementOf(row.item_code)?.label ?? row.item_code },
            {
              header: 'Required',
              cell: (row) => (requirementOf(row.item_code)?.is_required ? 'Required' : 'Optional'),
            },
            { header: 'Ticked', cell: (row) => (row.checked ? 'Yes' : 'No') },
            { header: 'When', cell: (row) => stamp(row.checked_at) },
            {
              header: '',
              cell: (row) =>
                isActive && !row.checked && !requirementOf(row.item_code)?.is_required ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="secondary"
                    disabled={pending}
                    onClick={() =>
                      run(() =>
                        api.patch(`/contracts/${id}/checklist/${row.item_code}`, { checked: true }),
                      )
                    }
                  >
                    Tick
                  </Button>
                ) : null,
            },
          ]}
        />
      </Section>

      <Section title="Visits" className="mb-4">
        <DataTable
          rowKey={(row) => row.id}
          rows={visits.data}
          emptyMessage="No visits booked against this contract."
          columns={[
            {
              header: 'Scheduled',
              cell: (row) => (
                <Link className="text-primary hover:underline" to={`/work-orders/${row.id}`}>
                  {stamp(row.scheduled_for)}
                </Link>
              ),
            },
            { header: 'Service', cell: (row) => row.service_type.replace(/_/g, ' ') },
            { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
          ]}
        />
      </Section>

      {isCorporate ? (
        <Section title="Invoices">
          <DataTable
            rowKey={(row) => row.id}
            rows={invoices.data}
            emptyMessage="Nothing billed against this contract yet."
            columns={[
              {
                header: 'Period',
                cell: (row) => (
                  <Link className="text-primary hover:underline" to={`/invoices/${row.id}`}>
                    {date(row.billing_period_start)} – {date(row.billing_period_end)}
                  </Link>
                ),
              },
              { header: 'Due', numeric: true, cell: (row) => money(row.amount_due) },
              { header: 'Paid', numeric: true, cell: (row) => money(row.amount_paid) },
              { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
            ]}
          />
        </Section>
      ) : null}
    </>
  );
}

/**
 * The card on file, and the way to get one.
 *
 * There is deliberately nowhere here to type a card number. The rep presses
 * a button, the customer gets a link, and the card is typed into the
 * processor's page — so no card number and no CVV is ever read out at a
 * doorstep, and none of it passes through this screen.
 */
function CardSection({
  id,
  contract,
  setups,
  isActive,
  run,
  pending,
}: {
  id: string;
  contract: ContractDetailModel;
  setups: CardSetup[];
  isActive: boolean;
  run: (action: () => Promise<unknown>) => void;
  pending: boolean;
}): JSX.Element {
  const open = setups.find((s) => s.status === 'sent');

  return (
    <Section title="Card on file" className="mb-4">
      {contract.payment_method_last4 ? (
        <FieldList>
          <Field label="Saved card">
            {contract.payment_method_brand ?? 'card'} ••••{contract.payment_method_last4}
          </Field>
          <Field label="Billing">Charged automatically when an invoice is sent.</Field>
        </FieldList>
      ) : (
        <p className="text-sm text-muted-foreground">
          No card yet. Sending a request emails or texts the customer a link to the processor's own
          page — they type the card themselves, so nobody here has to ask for a number or a CVV.
        </p>
      )}

      {isActive && !contract.payment_method_last4 ? (
        <div className="mt-3">
          <Button
            type="button"
            disabled={pending}
            onClick={() => run(() => api.post('/card-setups', { contract_id: id }))}
          >
            {open ? 'Send the link again' : 'Ask the customer for a card'}
          </Button>
        </div>
      ) : null}

      {setups.length > 0 ? (
        <div className="mt-3">
          <DataTable
            rowKey={(row) => row.id}
            rows={setups}
            columns={[
              { header: 'Requested', cell: (row) => stamp(row.created_at) },
              { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
              {
                header: 'Card',
                cell: (row) =>
                  row.payment_method_last4
                    ? `${row.payment_method_brand ?? 'card'} ••••${row.payment_method_last4}`
                    : '—',
              },
              {
                header: 'Link',
                cell: (row) =>
                  row.status === 'sent' ? (
                    <a
                      className="text-primary hover:underline"
                      href={row.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open on this device
                    </a>
                  ) : null,
              },
              {
                header: '',
                cell: (row) =>
                  row.status === 'sent' ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="secondary"
                      disabled={pending}
                      onClick={() => run(() => api.post(`/card-setups/${row.id}/refresh`))}
                    >
                      Check
                    </Button>
                  ) : null,
              },
            ]}
          />
        </div>
      ) : null}
    </Section>
  );
}
