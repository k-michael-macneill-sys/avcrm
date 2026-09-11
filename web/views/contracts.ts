import * as api from '../api.js';
import { filterBar, labelled, pageHeader, select } from '../components.js';
import { field, fieldList, fragment, h, link, section, table } from '../dom.js';
import { errorLine, submitter } from '../form.js';
import { date, money, statusPill, stamp } from '../format.js';
import * as router from '../router.js';
import { fileImage } from '../upload.js';
import { CONTRACT_STATUSES } from '../../src/types/models.js';
import type {
  CardSetup,
  ChecklistRequirement,
  Contract,
  ContractChecklistItem,
  Customer,
  Invoice,
  Property,
  WorkOrder,
} from '../../src/types/models.js';

interface ContractDetail extends Contract {
  checklist: ContractChecklistItem[];
}

export async function renderContracts(root: HTMLElement): Promise<void> {
  const query = new URLSearchParams(location.search);
  const status = query.get('status') ?? '';

  const contracts = await api.list<Contract>('/contracts', { status, page_size: 50 });

  root.appendChild(
    fragment(
      pageHeader('Contracts', `${contracts.meta.total} signed`),
      filterBar(
        labelled(
          'Status',
          select(
            [
              { value: '', label: 'Any status' },
              ...CONTRACT_STATUSES.map((s) => ({ value: s, label: s })),
            ],
            status,
            (value) => {
              const next = new URLSearchParams(location.search);
              if (value) next.set('status', value);
              else next.delete('status');
              const qs = next.toString();
              router.navigate(`/contracts${qs ? `?${qs}` : ''}`, true);
            },
          ),
        ),
      ),
      table<Contract>(
        [
          {
            header: 'Signed',
            cell: (row) => link(`/contracts/${row.id}`, stamp(row.signed_at)),
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
          { header: 'Status', cell: (row) => statusPill(row.status) },
        ],
        contracts.data,
        'Nothing signed yet.',
      ),
    ),
  );
}

export async function renderContract(root: HTMLElement, params: string[]): Promise<void> {
  const id = params[0] ?? '';
  const contract = await api.get<ContractDetail>(`/contracts/${id}`);
  const [property, customer, requirements, visits, cards, invoices] = await Promise.all([
    api.get<Property>(`/properties/${contract.property_id}`),
    api.get<Customer>(`/customers/${contract.customer_id}`),
    api.get<ChecklistRequirement[]>('/checklist-requirements'),
    api.list<WorkOrder>('/work-orders', { contract_id: id, page_size: 50 }),
    api.list<CardSetup>('/card-setups', { contract_id: id, page_size: 20 }),
    api.isCorporate()
      ? api.list<Invoice>('/invoices', { contract_id: id, page_size: 50 })
      : Promise.resolve({ data: [], meta: { page: 1, page_size: 0, total: 0, total_pages: 0 } }),
  ]);

  const error = errorLine();
  const run = submitter(error, () => router.render());
  const requirementOf = (code: string) => requirements.find((r) => r.code === code);
  const isActive = contract.status === 'active';

  root.appendChild(
    fragment(
      pageHeader(
        property.address_line1,
        `${customer.first_name} ${customer.last_name} — signed ${stamp(contract.signed_at)}`,
      ),
      section(
        'Contract',
        fieldList(
          field('Status', statusPill(contract.status)),
          field('Terms version', contract.terms_version),
          field(
            'Payment method',
            contract.payment_method_last4
              ? `${contract.payment_method_brand ?? 'card'} ••••${contract.payment_method_last4}`
              : 'none on file',
          ),
          field('Signed from', contract.signed_ip ?? '—'),
          field(
            'Signed at',
            contract.signed_lat && contract.signed_lng
              ? `${contract.signed_lat}, ${contract.signed_lng}`
              : 'no coordinates',
          ),
          field('Quote', link(`/quotes/${contract.quote_id}`, 'View the quote')),
        ),
        h(
          'div',
          { class: 'sig-shown' },
          h('p', { class: 'sig-label' }, 'Signature'),
          fileImage(
            contract.signature_image_url,
            'The signature captured at the door',
            'sig-image',
          ),
        ),
        error,
        isActive
          ? h(
              'div',
              { class: 'actions' },
              run('Mark completed', () =>
                api.patch(`/contracts/${id}/status`, { status: 'completed' }),
              ),
              run(
                'Cancel contract',
                () => api.patch(`/contracts/${id}/status`, { status: 'cancelled' }),
                'danger',
              ),
            )
          : h('p', { class: 'empty' }, `A ${contract.status} contract is final.`),
      ),
      cardSection(id, contract, cards.data, isActive, run),
      section(
        'Signature checklist',
        table<ContractChecklistItem>(
          [
            {
              header: 'Item',
              cell: (row) => requirementOf(row.item_code)?.label ?? row.item_code,
            },
            {
              header: 'Required',
              cell: (row) => (requirementOf(row.item_code)?.is_required ? 'Required' : 'Optional'),
            },
            { header: 'Ticked', cell: (row) => (row.checked ? 'Yes' : 'No') },
            { header: 'When', cell: (row) => stamp(row.checked_at) },
            {
              header: '',
              cell: (row) =>
                isActive && !row.checked && !requirementOf(row.item_code)?.is_required
                  ? run('Tick', () =>
                      api.patch(`/contracts/${id}/checklist/${row.item_code}`, {
                        checked: true,
                      }),
                    )
                  : null,
            },
          ],
          contract.checklist,
          'No checklist on this contract.',
        ),
      ),
      section(
        'Visits',
        table<WorkOrder>(
          [
            {
              header: 'Scheduled',
              cell: (row) => link(`/work-orders/${row.id}`, stamp(row.scheduled_for)),
            },
            { header: 'Service', cell: (row) => row.service_type.replace(/_/g, ' ') },
            { header: 'Status', cell: (row) => statusPill(row.status) },
          ],
          visits.data,
          'No visits booked against this contract.',
        ),
      ),
      api.isCorporate()
        ? section(
            'Invoices',
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
                { header: 'Due', numeric: true, cell: (row) => money(row.amount_due) },
                { header: 'Paid', numeric: true, cell: (row) => money(row.amount_paid) },
                { header: 'Status', cell: (row) => statusPill(row.status) },
              ],
              invoices.data,
              'Nothing billed against this contract yet.',
            ),
          )
        : null,
    ),
  );
}

type Run = ReturnType<typeof submitter>;

/**
 * The card on file, and the way to get one.
 *
 * There is deliberately nowhere here to type a card number. The rep presses a
 * button, the customer gets a link, and the card is typed into the processor's
 * page — so no card number and no CVV is ever read out at a doorstep, and none
 * of it passes through this screen.
 */
function cardSection(
  id: string,
  contract: ContractDetail,
  setups: CardSetup[],
  isActive: boolean,
  run: Run,
): HTMLElement {
  const open = setups.find((s) => s.status === 'sent');

  return section(
    'Card on file',
    contract.payment_method_last4
      ? fieldList(
          field(
            'Saved card',
            `${contract.payment_method_brand ?? 'card'} ••••${contract.payment_method_last4}`,
          ),
          field('Billing', 'Charged automatically when an invoice is sent.'),
        )
      : h(
          'p',
          { class: 'empty' },
          'No card yet. Sending a request emails or texts the customer a link to '
            + "the processor's own page — they type the card themselves, so nobody "
            + 'here has to ask for a number or a CVV.',
        ),
    isActive && !contract.payment_method_last4
      ? h(
          'div',
          { class: 'actions' },
          run(
            open ? 'Send the link again' : 'Ask the customer for a card',
            () => api.post('/card-setups', { contract_id: id }),
            'primary',
          ),
        )
      : null,
    setups.length
      ? table<CardSetup>(
          [
            { header: 'Requested', cell: (row) => stamp(row.created_at) },
            { header: 'Status', cell: (row) => statusPill(row.status) },
            {
              header: 'Card',
              cell: (row) =>
                row.payment_method_last4
                  ? `${row.payment_method_brand ?? 'card'} ••••${row.payment_method_last4}`
                  : '—',
            },
            {
              header: 'Link',
              // Not link(): this one leaves the app for the processor, so it
              // must not be prefixed or intercepted by the client router.
              cell: (row) =>
                row.status === 'sent'
                  ? h(
                      'a',
                      { href: row.url, target: '_blank', rel: 'noopener noreferrer' },
                      'Open on this device',
                    )
                  : null,
            },
            {
              header: '',
              // For when the rep is standing there and the webhook has not
              // landed yet.
              cell: (row) =>
                row.status === 'sent'
                  ? run('Check', () => api.post(`/card-setups/${row.id}/refresh`))
                  : null,
            },
          ],
          setups,
          'No card has been requested.',
        )
      : null,
  );
}
