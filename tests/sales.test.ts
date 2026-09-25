import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generateInvoicesForContract } from '../src/services/invoices';
import { db } from './helpers/database';
import { makeCustomer, season } from './helpers/fixtures';
import { harness } from './helpers/harness';
import { call, login } from './helpers/server';

/** A real 1x1 PNG, so the signature check sees what a canvas would send. */
const SIGNATURE_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=';

let postalCounter = 0;

/** Everything the three wizard pages send, with a fresh address each time. */
function deal(overrides: { quote?: Record<string, unknown>; customer?: Record<string, unknown> } = {}) {
  postalCounter += 1;
  return {
    customer: {
      first_name: 'Dana',
      last_name: 'Doorstep',
      email: `dana${postalCounter}@example.test`,
      phone: '613-555-0199',
      preferred_contact: 'email',
      ...overrides.customer,
    },
    property: {
      address_line1: `${100 + postalCounter} Wizard Way`,
      address_line2: 'Unit 2',
      city: 'Kingston',
      province: 'ON',
      postal_code: `K7L ${String(postalCounter).padStart(3, '0')}`,
      access_notes: 'Gate code 1234. Pile snow left.',
    },
    quote: {
      billing_type: 'monthly',
      initial_price: 159,
      discounted_price: 129,
      recurring_price: 109,
      ...season(),
      notes: 'Clear before 7am on the first visit.',
      addon_salt: true,
      addon_vehicle: false,
      addon_stairs: true,
      ...overrides.quote,
    },
  };
}

describe('opening a deal from the sales wizard', () => {
  const h = harness();

  it('creates the customer, property and presented quote in one go', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.sales);

    const reply = await call(h.server(), 'POST', '/sales/deals', { token, body: deal() });

    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const { customer, property, quote } = reply.body.data;
    // A rep's deal lands in their own branch without them naming it.
    assert.equal(customer.branch_id, world.branches.kingston);
    // Not a customer until they sign.
    assert.equal(customer.status, 'lead');
    assert.equal(property.address_line2, 'Unit 2');
    // The permanent notes live on the property, for every future visit.
    assert.equal(property.access_notes, 'Gate code 1234. Pile snow left.');
    assert.equal(quote.status, 'presented');
    assert.equal(quote.recurring_price, '109.00');
    assert.equal(quote.addon_salt, true);
    assert.equal(quote.addon_vehicle, false);
    assert.equal(quote.addon_stairs, true);
    assert.equal(quote.notes, 'Clear before 7am on the first visit.');
  });

  it('leaves nothing behind when the last step fails', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.sales);
    const body = deal({ customer: { last_name: 'Halfway' } });
    // Passes validation, then trips the discount check in the database.
    body.quote.discounted_price = 200;

    const reply = await call(h.server(), 'POST', '/sales/deals', { token, body });

    assert.equal(reply.status, 400);
    const orphan = await db('customers').where({ last_name: 'Halfway' }).first();
    assert.equal(orphan, undefined, 'the customer insert should have rolled back');
  });

  it('refuses a recurring price on seasonal billing', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.sales);

    const reply = await call(h.server(), 'POST', '/sales/deals', {
      token,
      body: deal({ quote: { billing_type: 'seasonal_upfront', recurring_price: 99 } }),
    });

    assert.equal(reply.status, 400);
    assert.match(JSON.stringify(reply.body), /seasonal is one payment/);
  });

  it('writes a deal against a lead already on file, and signing makes them active', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.sales);
    const lead = await makeCustomer(world.branches.kingston, world.users.sales);
    await db('customers').where({ id: lead.customer_id }).update({ status: 'lead' });

    const { customer: _unused, ...rest } = deal();
    const opened = await call(h.server(), 'POST', '/sales/deals', {
      token,
      body: { ...rest, customer_id: lead.customer_id },
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.data.customer.id, lead.customer_id);

    const signed = await call(h.server(), 'POST', '/contracts', {
      token,
      body: {
        quote_id: opened.body.data.quote.id,
        signature_image_url: 'signatures/2026/01/lead.png',
        terms_version: 'v1',
        checklist: [],
      },
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));

    const after = await db('customers').where({ id: lead.customer_id }).first('status');
    assert.equal(after?.status, 'active');
  });

  it('bills the first month at the discounted price and the rest at the recurring price', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.sales);
    const opened = await call(h.server(), 'POST', '/sales/deals', { token, body: deal() });
    const quoteId = opened.body.data.quote.id;

    const signed = await call(h.server(), 'POST', '/contracts', {
      token,
      body: {
        quote_id: quoteId,
        signature_image_url: 'signatures/2026/01/monthly.png',
        terms_version: 'v1',
        checklist: [],
      },
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));

    // As of the last day of the season, every period is due.
    const raised = await generateInvoicesForContract(signed.body.data.id, season().season_end);
    const amounts = raised
      .sort((a, b) => String(a.billing_period_start).localeCompare(String(b.billing_period_start)))
      .map((invoice) => invoice.amount_due);

    assert.equal(amounts.length, 5);
    assert.deepEqual(amounts, ['129.00', '109.00', '109.00', '109.00', '109.00']);
  });

  it('settles cash taken at the door against a seasonal contract', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.sales);
    const opened = await call(h.server(), 'POST', '/sales/deals', {
      token,
      body: deal({
        quote: {
          billing_type: 'seasonal_upfront',
          initial_price: 600,
          discounted_price: 550,
          recurring_price: null,
        },
      }),
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));

    const signed = await call(h.server(), 'POST', '/contracts', {
      token,
      body: {
        quote_id: opened.body.data.quote.id,
        signature_image_url: 'signatures/2026/01/seasonal.png',
        terms_version: 'v1',
        checklist: [],
      },
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));

    const settled = await call(
      h.server(),
      'POST',
      `/sales/contracts/${signed.body.data.id}/collected-payment`,
      { token, body: { method: 'cash' } },
    );

    assert.equal(settled.status, 201, JSON.stringify(settled.body));
    assert.equal(settled.body.data.status, 'paid');
    assert.equal(settled.body.data.amount_paid, '550.00');
    const payment = await db('payments').where({ invoice_id: settled.body.data.id }).first();
    assert.equal(payment?.method, 'cash');
  });
});

describe('signing by emailed link', () => {
  const h = harness();

  async function sentLink() {
    const world = h.world();
    const token = await login(h.server(), world.emails.sales);
    const opened = await call(h.server(), 'POST', '/sales/deals', { token, body: deal() });
    const quoteId = opened.body.data.quote.id as string;

    const sent = await call(h.server(), 'POST', `/sales/quotes/${quoteId}/signing-request`, {
      token,
    });
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    const url = sent.body.data.url as string;
    const linkToken = url.split('/app/sign/')[1] ?? '';
    return { quoteId, linkToken, customerId: opened.body.data.customer.id as string };
  }

  it('emails the customer their link', async () => {
    const { customerId } = await sentLink();

    const queued = await db('message_log')
      .where({ customer_id: customerId, template_code: 'signing_request' })
      .first();
    assert.ok(queued, 'a signing_request email should be queued');
    assert.equal(queued.channel, 'email');
  });

  it('shows the customer what they are signing, with no login', async () => {
    const { linkToken } = await sentLink();

    const reply = await call(h.server(), 'GET', `/public/sign/${linkToken}`);

    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(reply.body.data.recurring_price, '109.00');
    assert.equal(reply.body.data.addon_salt, true);
    // No checklist boxes are collected anywhere in the app any more.
    assert.deepEqual(reply.body.data.checklist, []);
  });

  it('turns their signature into a contract, and the link then stops working', async () => {
    const { linkToken, quoteId } = await sentLink();
    const body = {
      signature_png: SIGNATURE_PNG,
      confirmed: [],
    };

    const first = await call(h.server(), 'POST', `/public/sign/${linkToken}`, { body });
    assert.equal(first.status, 201, JSON.stringify(first.body));

    const contract = await db('contracts').where({ quote_id: quoteId }).first();
    assert.ok(contract, 'the contract should exist');
    const upload = await db('uploads').where({ key: contract.signature_image_url }).first();
    assert.equal(upload?.status, 'stored');
    // Nobody on staff signed this.
    assert.equal(upload?.uploaded_by_user_id, null);

    const again = await call(h.server(), 'POST', `/public/sign/${linkToken}`, { body });
    assert.equal(again.status, 409);
    const view = await call(h.server(), 'GET', `/public/sign/${linkToken}`);
    assert.equal(view.status, 409);
  });

  it('refuses something that is not a PNG', async () => {
    const { linkToken } = await sentLink();

    const reply = await call(h.server(), 'POST', `/public/sign/${linkToken}`, {
      body: {
        signature_png: `data:image/png;base64,${Buffer.from('<script>alert(1)</script>').toString('base64')}`,
        confirmed: [],
      },
    });
    assert.equal(reply.status, 400);
  });

  it('refuses a made-up link', async () => {
    const reply = await call(h.server(), 'GET', '/public/sign/not-a-real-token-at-all');
    assert.equal(reply.status, 401);
  });

  it('replaces an outstanding link when a new one is sent', async () => {
    const world = h.world();
    const { quoteId, linkToken } = await sentLink();
    const token = await login(h.server(), world.emails.sales);

    await call(h.server(), 'POST', `/sales/quotes/${quoteId}/signing-request`, { token });

    const stale = await call(h.server(), 'GET', `/public/sign/${linkToken}`);
    assert.equal(stale.status, 401);
  });
});

describe('who sells and who clears', () => {
  const h = harness();

  it('refuses to let an operator sign a customer up', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.operator);

    const deal_ = await call(h.server(), 'POST', '/sales/deals', { token, body: deal() });
    assert.equal(deal_.status, 403);

    const lead = await call(h.server(), 'POST', '/customers', {
      token,
      body: { first_name: 'No', last_name: 'Sale', email: 'no@example.test' },
    });
    assert.equal(lead.status, 403);
  });

  it('still lets an operator read the property they are clearing', async () => {
    const world = h.world();
    const made = await makeCustomer(world.branches.kingston, world.users.sales);
    const token = await login(h.server(), world.emails.operator);

    const reply = await call(h.server(), 'GET', `/properties/${made.property_id}`, { token });
    assert.equal(reply.status, 200);
  });

  it('refuses to let a sales rep dispatch or work a visit', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.sales);

    const reply = await call(h.server(), 'POST', '/work-orders', {
      token,
      body: { contract_id: '00000000-0000-4000-8000-000000000000', scheduled_for: new Date().toISOString() },
    });
    assert.equal(reply.status, 403);
  });

  it('keeps a rep to their own branch', async () => {
    const world = h.world();
    const elsewhere = await makeCustomer(world.branches.halifax, world.users.halifaxSales);
    const token = await login(h.server(), world.emails.sales);

    const reply = await call(h.server(), 'GET', `/customers/${elsewhere.customer_id}`, { token });
    assert.equal(reply.status, 404);
  });

  it('will not create a sales rep without a branch', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.corporate);

    const reply = await call(h.server(), 'POST', '/users', {
      token,
      body: {
        email: 'drifter@example.test',
        password: 'Password123!',
        first_name: 'No',
        last_name: 'Branch',
        role: 'sales',
      },
    });
    assert.equal(reply.status, 400);
    assert.match(JSON.stringify(reply.body), /sales rep must belong to a branch/);
  });
});
