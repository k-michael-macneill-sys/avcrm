import * as api from '../api.js';
import { filterBar, labelled, pageHeader, select } from '../components.js';
import { fieldList, field, fragment, h, link, section, table } from '../dom.js';
import { buildForm, disclosure, errorLine, submitter } from '../form.js';
import { date, fullName, money, statusPill, stamp } from '../format.js';
import * as router from '../router.js';
import { CUSTOMER_STATUSES, PREFERRED_CONTACTS } from '../../src/types/models.js';
import type { Branch, Contract, Customer, Property, Quote } from '../../src/types/models.js';

/** Query state for the list, kept in the URL so a filtered view is shareable. */
function params(): URLSearchParams {
  return new URLSearchParams(location.search);
}

function setParam(key: string, value: string): void {
  const next = params();
  if (value) next.set(key, value);
  else next.delete(key);
  const qs = next.toString();
  router.navigate(`/customers${qs ? `?${qs}` : ''}`, true);
}

export async function renderCustomers(root: HTMLElement): Promise<void> {
  const query = params();
  const status = query.get('status') ?? '';
  const search = query.get('search') ?? '';

  const [customers, branches] = await Promise.all([
    api.list<Customer>('/customers', { status, search, page_size: 50 }),
    api.isCorporate()
      ? api.get<Branch[]>('/branches')
      : Promise.resolve<Branch[]>([]),
  ]);

  const searchBox = h('input', {
    type: 'search',
    value: search,
    placeholder: 'Name, email or phone',
  });
  searchBox.addEventListener('change', () => setParam('search', searchBox.value.trim()));

  root.appendChild(
    fragment(
      pageHeader(
        'Customers',
        `${customers.meta.total} on the books`,
        api.isCorporate() ? newCustomerPanel(branches) : null,
      ),
      filterBar(
        labelled('Search', searchBox),
        labelled(
          'Status',
          select(
            [
              { value: '', label: 'Any status' },
              ...CUSTOMER_STATUSES.map((s) => ({ value: s, label: s })),
            ],
            status,
            (value) => setParam('status', value),
          ),
        ),
      ),
      table<Customer>(
        [
          {
            header: 'Name',
            cell: (row) => link(`/customers/${row.id}`, fullName(row)),
          },
          { header: 'Email', cell: (row) => row.email ?? '—' },
          { header: 'Phone', cell: (row) => row.phone ?? '—' },
          { header: 'Status', cell: (row) => statusPill(row.status) },
          { header: 'Added', cell: (row) => stamp(row.created_at) },
        ],
        customers.data,
        search || status
          ? 'No customers match those filters.'
          : 'No customers yet. Add the first one above.',
      ),
    ),
  );
}

function newCustomerPanel(branches: Branch[]): HTMLElement {
  return disclosure('New customer', () => {
    const error = errorLine();
    const form = buildForm([
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
          'Add customer',
          async () => {
            const values = form.values();
            const created = await api.post<Customer>('/customers', {
              first_name: values.first_name,
              last_name: values.last_name,
              email: values.email || null,
              phone: values.phone || null,
              preferred_contact: values.preferred_contact,
              branch_id: values.branch_id,
              status: values.status,
            });
            router.navigate(`/customers/${created.id}`);
          },
          'primary',
        ),
      ),
    );
  });
}

export async function renderCustomer(root: HTMLElement, params: string[]): Promise<void> {
  const id = params[0] ?? '';
  const [customer, properties, quotes, contracts] = await Promise.all([
    api.get<Customer>(`/customers/${id}`),
    api.list<Property>(`/customers/${id}/properties`, { page_size: 50 }),
    api.list<Quote>('/quotes', { customer_id: id, page_size: 50 }),
    api.list<Contract>('/contracts', { customer_id: id, page_size: 50 }),
  ]);

  const addressOf = (propertyId: string) =>
    properties.data.find((p) => p.id === propertyId)?.address_line1 ?? '—';

  root.appendChild(
    fragment(
      pageHeader(fullName(customer), customer.email ?? customer.phone ?? 'No contact on file'),
      section(
        'Details',
        fieldList(
          field('Status', statusPill(customer.status)),
          field('Email', customer.email ?? '—'),
          field('Phone', customer.phone ?? '—'),
          field('Preferred contact', customer.preferred_contact),
          field('Added', stamp(customer.created_at)),
        ),
        customer.notes ? h('p', { class: 'notes' }, customer.notes) : null,
      ),
      section(
        'Properties',
        table<Property>(
          [
            { header: 'Address', cell: (row) => row.address_line1 },
            { header: 'City', cell: (row) => `${row.city}, ${row.province}` },
            { header: 'Postal', cell: (row) => row.postal_code },
            {
              header: 'Driveway',
              numeric: true,
              cell: (row) =>
                row.driveway_size_cars === null
                  ? '—'
                  : `${row.driveway_size_cars}${row.driveway_size_cars === 6 ? '+' : ''} cars`,
            },
            {
              header: 'Priority',
              cell: (row) => (row.priority_flag ? statusPill('priority') : '—'),
            },
          ],
          properties.data,
          'No properties on this customer yet.',
        ),
        newPropertyPanel(customer.id),
      ),
      section(
        'Quotes',
        table<Quote>(
          [
            { header: 'Property', cell: (row) => addressOf(row.property_id) },
            { header: 'Billing', cell: (row) => row.billing_type.replace(/_/g, ' ') },
            { header: 'Price', numeric: true, cell: (row) => money(row.discounted_price) },
            { header: 'Season', cell: (row) => `${date(row.season_start)} – ${date(row.season_end)}` },
            {
              header: 'Status',
              cell: (row) => link(`/quotes/${row.id}`, statusPill(row.status)),
            },
          ],
          quotes.data,
          'Nothing quoted for this customer yet.',
        ),
      ),
      section(
        'Contracts',
        table<Contract>(
          [
            { header: 'Property', cell: (row) => addressOf(row.property_id) },
            { header: 'Signed', cell: (row) => stamp(row.signed_at) },
            { header: 'Terms', cell: (row) => row.terms_version },
            {
              header: 'Status',
              cell: (row) => link(`/contracts/${row.id}`, statusPill(row.status)),
            },
          ],
          contracts.data,
          'Nothing signed for this customer yet.',
        ),
      ),
    ),
  );
}

function newPropertyPanel(customerId: string): HTMLElement {
  return disclosure('Add property', () => {
    const error = errorLine();
    const form = buildForm([
      { name: 'address_line1', label: 'Address', required: true },
      { name: 'city', label: 'City', required: true, value: 'Kingston' },
      { name: 'province', label: 'Province', required: true, value: 'ON' },
      { name: 'postal_code', label: 'Postal code', required: true },
      {
        name: 'driveway_size_cars',
        label: 'Driveway (cars)',
        type: 'select',
        options: ['1', '2', '3', '4', '5', '6'].map((n) => ({
          value: n,
          label: n === '6' ? '6+' : n,
        })),
        value: '2',
      },
      { name: 'access_notes', label: 'Access notes', type: 'textarea' },
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
          'Add property',
          async () => {
            const values = form.values();
            await api.post<Property>('/properties', {
              customer_id: customerId,
              address_line1: values.address_line1,
              city: values.city,
              province: values.province,
              postal_code: values.postal_code,
              driveway_size_cars: Number(values.driveway_size_cars),
              access_notes: values.access_notes || null,
            });
          },
          'primary',
        ),
      ),
    );
  });
}
