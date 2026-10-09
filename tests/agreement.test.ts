import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PDFDocument } from 'pdf-lib';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { call, login } from './helpers/server';

/** A one-pixel PNG, so the signature bytes are real image bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

let n = 0;
/** The agreement as a rep fills it in, with a fresh address each time. */
function agreement(overrides: Record<string, string | boolean> = {}) {
  n += 1;
  return {
    customer_name: 'Harold Bell',
    customer_street: `${200 + n} Johnson St`,
    customer_city: 'Kingston',
    customer_province: 'ON',
    customer_postal: 'K7L 1Y4',
    customer_phone: '613-555-0201',
    phone_type_cell: true,
    customer_email: `harold${n}@example.test`,
    start_year: '26',
    end_year: '27',
    package: 'Premium',
    price_premium: '129.50',
    addon_de_ice: true,
    addon_deck: true,
    customer_notes: 'Gate code 1234.',
    ...overrides,
  };
}

describe('signing up on the PDF agreement', () => {
  const h = harness();

  async function signatureKey(token: string): Promise<string> {
    const target = await call(h.server(), 'POST', '/uploads', {
      token,
      body: { purpose: 'signature', content_type: 'image/png', file_name: 'signature.png' },
    });
    const put = await fetch(`${h.server().url}${target.body.data.upload_url}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    assert.equal(put.status, 201);
    return target.body.data.key as string;
  }

  it('serves the blank agreement to fill in', async () => {
    const reply = await fetch(`${h.server().url}/agreement-template.pdf`);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('content-type'), 'application/pdf');
  });

  it('turns the filled-in agreement into the customer, the address and a monthly quote', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const reply = await call(h.server(), 'POST', '/sales/agreement-deals', { token, body: { agreement: agreement() } });

    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const { customer, property, quote } = reply.body.data;
    assert.equal(customer.first_name, 'Harold');
    assert.equal(customer.last_name, 'Bell');
    assert.equal(customer.status, 'lead');
    assert.equal(property.access_notes, 'Gate code 1234.');
    assert.equal(quote.billing_type, 'monthly');
    assert.equal(quote.recurring_price, '129.50');
    assert.equal(quote.package, 'premium');
    assert.deepEqual(quote.addons, ['de_ice', 'deck']);
    assert.equal(quote.agreement_fields.customer_notes, 'Gate code 1234.');
    assert.equal(String(quote.season_start).slice(0, 10), '2026-11-01');
    assert.equal(String(quote.season_end).slice(0, 10), '2027-03-31');
  });

  it('runs an exact-dates agreement between the dates given, rather than the season', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const reply = await call(h.server(), 'POST', '/sales/agreement-deals', {
      token,
      body: {
        agreement: agreement({
          term_type: 'Exact dates',
          term_start: '2026-12-01',
          term_end: '2027-01-31',
          start_year: '',
          end_year: '',
        }),
      },
    });

    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const { quote } = reply.body.data;
    assert.equal(String(quote.season_start).slice(0, 10), '2026-12-01');
    assert.equal(String(quote.season_end).slice(0, 10), '2027-01-31');
    assert.equal(quote.agreement_fields.term_type, 'Exact dates');
  });

  it('refuses exact dates that end before they start, or run past a year', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    for (const [start, end] of [
      ['2027-01-31', '2026-12-01'],
      ['2026-12-01', '2028-01-01'],
      ['2026-12-01', ''],
    ]) {
      const reply = await call(h.server(), 'POST', '/sales/agreement-deals', {
        token,
        body: { agreement: agreement({ term_type: 'Exact dates', term_start: start!, term_end: end! }) },
      });
      assert.equal(reply.status, 400);
      const paths = reply.body.error.details.map((d: { path: string }) => d.path);
      assert.deepEqual(paths, ['agreement.term_end']);
    }
  });

  it('names everything missing from the agreement at once, and writes nothing', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const reply = await call(h.server(), 'POST', '/sales/agreement-deals', {
      token,
      body: { agreement: agreement({ customer_name: 'Harold', package: '', customer_email: '', customer_phone: '' }) },
    });

    assert.equal(reply.status, 400);
    const paths = reply.body.error.details.map((d: { path: string }) => d.path);
    assert.deepEqual(paths.sort(), ['agreement.customer_email', 'agreement.customer_name', 'agreement.package']);
    assert.equal(await db('customers').where({ first_name: 'Harold' }).first(), undefined);
  });

  it('keeps the signed, filled-in, flattened PDF with the contract when signed in person', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const opened = await call(h.server(), 'POST', '/sales/agreement-deals', { token, body: { agreement: agreement() } });

    const signed = await call(h.server(), 'POST', '/contracts', {
      token,
      body: {
        quote_id: opened.body.data.quote.id,
        signature_image_url: await signatureKey(token),
        provider_signature_image_url: await signatureKey(token),
        terms_version: 'v1',
        checklist: [],
      },
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));
    assert.match(signed.body.data.pdf_url, /^contracts\//);
    assert.ok(signed.body.data.provider_signature_url);

    const file = await fetch(`${h.server().url}/files/${signed.body.data.pdf_url}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(file.status, 200);
    const pdf = await PDFDocument.load(Buffer.from(await file.arrayBuffer()));
    assert.equal(pdf.getPageCount(), 2);
    // Flattened: the values are printed on the page, not editable fields.
    assert.equal(pdf.getForm().getFields().length, 0);
  });

  it('shows the same agreement on the emailed link, and keeps the signed PDF from there too', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const opened = await call(h.server(), 'POST', '/sales/agreement-deals', { token, body: { agreement: agreement() } });
    const sent = await call(h.server(), 'POST', `/sales/quotes/${opened.body.data.quote.id}/signing-request`, { token });
    const link = String(sent.body.data.url).split('/app/sign/')[1] ?? '';

    const view = await call(h.server(), 'GET', `/public/sign/${link}`);
    assert.equal(view.status, 200);
    assert.equal(view.body.data.agreement.package, 'Premium');
    assert.equal(view.body.data.agreement.price_premium, '129.50');

    const done = await call(h.server(), 'POST', `/public/sign/${link}`, {
      body: { signature_png: `data:image/png;base64,${PNG.toString('base64')}`, confirmed: [] },
    });
    assert.equal(done.status, 201, JSON.stringify(done.body));
    const contract = await db('contracts').where({ id: done.body.data.contract_id }).first();
    assert.match(contract?.pdf_url ?? '', /^contracts\//);
  });

  it('carries the lead over rather than duplicating them', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.sales);
    const [lead] = await db('customers')
      .insert({
        branch_id: world.branches.kingston,
        first_name: 'Old',
        last_name: 'Name',
        email: 'old@example.test',
        preferred_contact: 'email',
        status: 'lead',
      })
      .returning('*');
    assert.ok(lead);

    const reply = await call(h.server(), 'POST', '/sales/agreement-deals', {
      token,
      body: { customer_id: lead.id, agreement: agreement({ customer_name: 'Olive Newname' }) },
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.data.customer.id, lead.id);
    const after = await db('customers').where({ id: lead.id }).first();
    assert.equal(after?.last_name, 'Newname');
  });
});
