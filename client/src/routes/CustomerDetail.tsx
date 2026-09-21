import { Link, useParams } from 'react-router-dom';
import type { Contract, Customer, Property, Quote } from '../../../src/types/models';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { DataTable } from '@/components/DataTable';
import { StatusPill } from '@/components/StatusPill';
import { Disclosure } from '@/components/Disclosure';
import { InlineForm } from '@/components/InlineForm';
import { Field, FieldList, Loading, ErrorNotice } from '@/components/Misc';
import { useQuery } from '@/lib/useQuery';
import * as api from '@/lib/api';
import { date, money, stamp } from '@/lib/format';

export function CustomerDetail(): JSX.Element {
  const { id = '' } = useParams();
  const { data, loading, error, reload } = useQuery(
    () =>
      Promise.all([
        api.get<Customer>(`/customers/${id}`),
        api.list<Property>(`/customers/${id}/properties`, { page_size: 50 }),
        api.list<Quote>('/quotes', { customer_id: id, page_size: 50 }),
        api.list<Contract>('/contracts', { customer_id: id, page_size: 50 }),
      ]),
    [id],
  );

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [customer, properties, quotes, contracts] = data;
  const addressOf = (propertyId: string): string =>
    properties.data.find((p) => p.id === propertyId)?.address_line1 ?? '—';

  return (
    <>
      <PageHeader
        title={`${customer.first_name} ${customer.last_name}`}
        subtitle={customer.email ?? customer.phone ?? 'No contact on file'}
      />

      <Section title="Details" className="mb-4">
        <FieldList>
          <Field label="Status">
            <StatusPill status={customer.status} />
          </Field>
          <Field label="Email">{customer.email ?? '—'}</Field>
          <Field label="Phone">{customer.phone ?? '—'}</Field>
          <Field label="Preferred contact">{customer.preferred_contact}</Field>
          <Field label="Added">{stamp(customer.created_at)}</Field>
        </FieldList>
        {customer.notes ? (
          <p className="mt-3 rounded-lg bg-accent/40 px-3 py-2 text-sm text-secondary-foreground">
            {customer.notes}
          </p>
        ) : null}
      </Section>

      <Section title="Properties" className="mb-4">
        <DataTable
          rowKey={(row) => row.id}
          rows={properties.data}
          emptyMessage="No properties on this customer yet."
          columns={[
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
              cell: (row) => (row.priority_flag ? <StatusPill status="priority" /> : '—'),
            },
          ]}
        />
        <Disclosure label="Add property">
          <InlineForm
            submitLabel="Add property"
            specs={[
              { name: 'address_line1', label: 'Address', required: true },
              { name: 'city', label: 'City', required: true },
              { name: 'province', label: 'Province', required: true },
              { name: 'postal_code', label: 'Postal code', required: true },
              {
                name: 'driveway_size_cars',
                label: 'Driveway (cars)',
                type: 'select',
                options: ['1', '2', '3', '4', '5', '6'].map((n) => ({ value: n, label: n === '6' ? '6+' : n })),
                value: '2',
              },
              { name: 'access_notes', label: 'Access notes', type: 'textarea' },
            ]}
            onSubmit={(values) =>
              api.post<Property>('/properties', {
                customer_id: customer.id,
                address_line1: values.address_line1,
                city: values.city,
                province: values.province,
                postal_code: values.postal_code,
                driveway_size_cars: Number(values.driveway_size_cars),
                access_notes: values.access_notes || null,
              })
            }
            onDone={reload}
          />
        </Disclosure>
      </Section>

      <Section title="Quotes" className="mb-4">
        <DataTable
          rowKey={(row) => row.id}
          rows={quotes.data}
          emptyMessage="Nothing quoted for this customer yet."
          columns={[
            { header: 'Property', cell: (row) => addressOf(row.property_id) },
            { header: 'Billing', cell: (row) => row.billing_type.replace(/_/g, ' ') },
            { header: 'Price', numeric: true, cell: (row) => money(row.discounted_price) },
            { header: 'Season', cell: (row) => `${date(row.season_start)} – ${date(row.season_end)}` },
            {
              header: 'Status',
              cell: (row) => (
                <Link to={`/quotes/${row.id}`}>
                  <StatusPill status={row.status} />
                </Link>
              ),
            },
          ]}
        />
      </Section>

      <Section title="Contracts">
        <DataTable
          rowKey={(row) => row.id}
          rows={contracts.data}
          emptyMessage="Nothing signed for this customer yet."
          columns={[
            { header: 'Property', cell: (row) => addressOf(row.property_id) },
            { header: 'Signed', cell: (row) => stamp(row.signed_at) },
            { header: 'Terms', cell: (row) => row.terms_version },
            {
              header: 'Status',
              cell: (row) => (
                <Link to={`/contracts/${row.id}`}>
                  <StatusPill status={row.status} />
                </Link>
              ),
            },
          ]}
        />
      </Section>
    </>
  );
}
