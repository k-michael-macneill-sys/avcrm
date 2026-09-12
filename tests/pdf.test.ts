import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { harness } from './helpers/harness';
import { makeContract, makeWorkOrder } from './helpers/fixtures';
import { call, login } from './helpers/server';
import { db } from './helpers/database';
import { renderInvoice, renderServiceReport } from '../src/services/pdf/documents';
import { pdfPages, pdfText } from './helpers/pdf';

/**
 * A PDF is bytes, so these read it back rather than trusting the call
 * returned. Everything that matters — the customer's name, the balance, a
 * photo that could not be embedded — is checked by finding it in the text of
 * the rendered page.
 */

describe('rendering the documents', () => {
  const invoiceInput = {
    invoice: {
      id: 'a709c614-0000-4000-8000-000000000000',
      billing_period_start: '2026-11-15',
      billing_period_end: '2026-12-15',
      amount_due: '425.00',
      amount_paid: '0.00',
      status: 'sent',
      due_date: '2026-12-01',
      sent_at: new Date('2026-11-16T12:00:00Z'),
    },
    customer: {
      first_name: 'Sam',
      last_name: 'Toussaint',
      email: 'sam@example.test',
      phone: null,
    },
    property: {
      address_line1: '5560 Cornwallis St',
      address_line2: null,
      city: 'Halifax',
      province: 'NS',
      postal_code: 'B3K 1B1',
    },
    branch: { name: 'Halifax' },
    contract: { billing_type: 'seasonal_upfront', terms_version: 'v1' },
    payments: [],
  };

  it('puts the customer, the address and the amount on the invoice', async () => {
    const text = pdfText(await renderInvoice(invoiceInput));

    assert.match(text, /Sam Toussaint/);
    assert.match(text, /5560 Cornwallis St/);
    assert.match(text, /\$425\.00/);
    assert.match(text, /Halifax/);
  });

  it('shows a balance only once something has been paid', async () => {
    const unpaid = pdfText(await renderInvoice(invoiceInput));
    assert.match(unpaid, /Total due/);
    // On an untouched invoice the balance is the total; saying it twice reads
    // as an error.
    assert.doesNotMatch(unpaid, /Balance owing/);

    const part = pdfText(
      await renderInvoice({
        ...invoiceInput,
        invoice: { ...invoiceInput.invoice, amount_paid: '200.00' },
        payments: [
          {
            processed_at: new Date('2026-11-20T12:00:00Z'),
            method: 'cheque',
            status: 'succeeded',
            amount: '200.00',
            failure_reason: null,
          },
        ],
      }),
    );
    assert.match(part, /Paid to date/);
    assert.match(part, /Balance owing/);
    assert.match(part, /\$225\.00/);
  });

  it('keeps a failed charge off the customer copy', async () => {
    const text = pdfText(
      await renderInvoice({
        ...invoiceInput,
        payments: [
          {
            processed_at: new Date('2026-11-20T12:00:00Z'),
            method: 'card_on_file',
            status: 'failed',
            amount: '425.00',
            failure_reason: 'Your card has insufficient funds.',
          },
        ],
      }),
    );

    // The office needs to know; the customer's bill is not where that belongs.
    assert.doesNotMatch(text, /insufficient funds/);
    assert.doesNotMatch(text, /Payments received/);
  });

  it('says when a photo could not be included rather than dropping it', async () => {
    const text = pdfText(
      await renderServiceReport({
        workOrder: {
          id: '95fbae17-0000-4000-8000-000000000000',
          service_type: 'snow_clearing',
          status: 'completed',
          scheduled_for: new Date('2026-12-01T09:00:00Z'),
          started_at: new Date('2026-12-01T09:30:00Z'),
          completed_at: new Date('2026-12-01T10:15:00Z'),
          operator_notes: 'Salted the walkway as well.',
          skip_reason: null,
        },
        customer: { first_name: 'Sam', last_name: 'Toussaint' },
        property: {
          address_line1: '5560 Cornwallis St',
          address_line2: null,
          city: 'Halifax',
          province: 'NS',
          postal_code: 'B3K 1B1',
          priority_flag: true,
          access_notes: 'Gate is on the left.',
        },
        branch: { name: 'Halifax' },
        operator: { first_name: 'Hana', last_name: 'Harbour' },
        photos: [
          {
            photo_type: 'before',
            taken_at: new Date('2026-12-01T09:31:00Z'),
            latitude: '44.648600',
            longitude: '-63.585200',
            image: null,
          },
        ],
      }),
    );

    assert.match(text, /Salted the walkway/);
    assert.match(text, /Gate is on the left/);
    assert.match(text, /Priority property/);
    assert.match(text, /Hana Harbour/);
    // A gap in a record is worse than a note about it.
    assert.match(text, /could not be included/);
  });
});

describe('downloading the documents', () => {
  const h = harness();

  async function sentInvoice() {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const token = await login(h.server(), world.emails.corporate);

    const created = await call(h.server(), 'POST', '/invoices', {
      token,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-01-01',
        billing_period_end: '2027-01-31',
        amount_due: 149.5,
        due_date: '2027-01-15',
      },
    });
    await call(h.server(), 'POST', `/invoices/${created.body.data.id}/send`, { token });
    return { token, contract, invoice: created.body.data };
  }

  it('answers with a PDF a browser can show', async () => {
    const { token, invoice } = await sentInvoice();
    const reply = await fetch(`${h.server().url}/invoices/${invoice.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });

    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('content-type'), 'application/pdf');
    assert.match(reply.headers.get('content-disposition') ?? '', /inline; filename="invoice-/);
    // An invoice names a customer and what they owe: never a shared cache.
    assert.match(reply.headers.get('cache-control') ?? '', /private/);

    const bytes = Buffer.from(await reply.arrayBuffer());
    assert.equal(bytes.subarray(0, 4).toString(), '%PDF');
    assert.equal(pdfPages(bytes), 1);
    assert.match(pdfText(bytes), /Harold Bell/);
  });

  it('keeps the rendered copy and hands it back next time', async () => {
    const { token, invoice } = await sentInvoice();
    await call(h.server(), 'GET', `/invoices/${invoice.id}/pdf`, { token });

    const stored = await db('invoices').where({ id: invoice.id }).first();
    assert.ok(stored?.pdf_url, 'the key is kept on the invoice');

    await call(h.server(), 'GET', `/invoices/${invoice.id}/pdf`, { token });
    const uploads = await db('uploads').where({ purpose: 'invoice_pdf' });
    assert.equal(uploads.length, 1, 'a second download re-renders nothing');
  });

  it('renders it again once a payment has changed the total', async () => {
    const { token, invoice } = await sentInvoice();
    await call(h.server(), 'GET', `/invoices/${invoice.id}/pdf`, { token });

    await call(h.server(), 'POST', `/invoices/${invoice.id}/payments`, {
      token,
      body: { amount: 149.5, method: 'cheque', status: 'succeeded' },
    });

    const reply = await fetch(`${h.server().url}/invoices/${invoice.id}/pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    const text = pdfText(Buffer.from(await reply.arrayBuffer()));

    // Nobody should be handed a bill that disagrees with the screen.
    assert.match(text, /Paid in full/);
    assert.equal((await db('uploads').where({ purpose: 'invoice_pdf' })).length, 2);
  });

  it('reports on a finished visit, and refuses another branch', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const id = await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
      status: 'completed',
      completed_at: new Date(),
    });

    const token = await login(h.server(), world.emails.operator);
    const reply = await fetch(`${h.server().url}/work-orders/${id}/report.pdf`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(reply.status, 200);
    assert.match(pdfText(Buffer.from(await reply.arrayBuffer())), /212 Johnson St/);

    const otherBranch = await login(h.server(), world.emails.halifaxOperator);
    const refused = await call(h.server(), 'GET', `/work-orders/${id}/report.pdf`, {
      token: otherBranch,
    });
    assert.equal(refused.status, 404);
  });

  it('will not hand a document to someone with no session', async () => {
    const { invoice } = await sentInvoice();
    const reply = await call(h.server(), 'GET', `/invoices/${invoice.id}/pdf`);
    assert.equal(reply.status, 401);
  });
});
