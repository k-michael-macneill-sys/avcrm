import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { makeCustomer, season } from './helpers/fixtures';
import { harness } from './helpers/harness';
import { call, login } from './helpers/server';

/** A few streets in Kingston, and a box around them. */
const HOUSE = { latitude: 44.2312, longitude: -76.4861 };
const AROUND = 'north=44.24&south=44.22&east=-76.47&west=-76.50';
const FAR_AWAY = 'north=45.6&south=45.4&east=-73.4&west=-73.7';

let n = 0;
function knock(overrides: Record<string, unknown> = {}) {
  n += 1;
  return {
    latitude: HOUSE.latitude + n * 0.0001,
    longitude: HOUSE.longitude,
    address_line1: `${n} Map Lane`,
    city: 'Kingston',
    province: 'ON',
    postal_code: `K7L 9${String(n).padStart(2, '0')}`,
    status: 'not_home',
    ...overrides,
  };
}

describe('the leads map', () => {
  const h = harness();

  it('drops a pin and shows it only to a map looking at that spot', async () => {
    const token = await login(h.server(), h.world().emails.sales);

    const made = await call(h.server(), 'POST', '/leads/pins', { token, body: knock() });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.equal(made.body.data.status, 'not_home');

    const here = await call(h.server(), 'GET', `/leads/pins?${AROUND}`, { token });
    assert.ok(here.body.data.some((p: { id: string }) => p.id === made.body.data.id));
    assert.equal(here.body.data[0].created_by_name, 'Sam Seller');

    const there = await call(h.server(), 'GET', `/leads/pins?${FAR_AWAY}`, { token });
    assert.equal(there.body.data.length, 0);
  });

  it('turns a door into a lead with a name, filed at that house', async () => {
    const token = await login(h.server(), h.world().emails.sales);

    const made = await call(h.server(), 'POST', '/leads/pins', {
      token,
      body: knock({
        status: 'lead',
        notes: 'Come back after the first snowfall',
        lead: { first_name: 'Lee', last_name: 'Later', phone: '613-555-0142' },
      }),
    });

    assert.equal(made.status, 201, JSON.stringify(made.body));
    const customer = await db('customers').where({ id: made.body.data.customer_id }).first();
    assert.equal(customer?.status, 'lead');
    assert.equal(customer?.notes, 'Come back after the first snowfall');
    const property = await db('properties').where({ customer_id: customer?.id }).first();
    assert.ok(property, 'the lead should have their house attached');
    assert.equal(Number(property.latitude).toFixed(4), Number(made.body.data.latitude).toFixed(4));
  });

  it('refuses a lead with no way to reach them', async () => {
    const token = await login(h.server(), h.world().emails.sales);

    const reply = await call(h.server(), 'POST', '/leads/pins', {
      token,
      body: knock({ status: 'lead', lead: { first_name: 'No', last_name: 'Contact' } }),
    });
    assert.equal(reply.status, 400);
  });

  it('still takes the lead when their address is already on the books', async () => {
    const world = h.world();
    const existing = await makeCustomer(world.branches.kingston, world.users.sales);
    const property = (await db('properties').where({ id: existing.property_id }).first())!;
    const token = await login(h.server(), world.emails.sales);

    const made = await call(h.server(), 'POST', '/leads/pins', {
      token,
      body: knock({
        address_line1: property.address_line1,
        postal_code: property.postal_code,
        status: 'lead',
        lead: { first_name: 'Second', last_name: 'Household', email: 'second@example.test' },
      }),
    });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    assert.ok(made.body.data.customer_id);
  });

  it('counts another knock when a revisit changes how it went', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const made = await call(h.server(), 'POST', '/leads/pins', { token, body: knock() });

    const again = await call(h.server(), 'PATCH', `/leads/pins/${made.body.data.id}`, {
      token,
      body: { status: 'not_interested', notes: 'Has a plough guy' },
    });

    assert.equal(again.status, 200, JSON.stringify(again.body));
    assert.equal(again.body.data.status, 'not_interested');
    assert.equal(again.body.data.knock_count, 2);
    assert.equal(again.body.data.notes, 'Has a plough guy');
  });

  it("keeps each branch's pins to itself", async () => {
    const world = h.world();
    const kingston = await login(h.server(), world.emails.sales);
    const made = await call(h.server(), 'POST', '/leads/pins', { token: kingston, body: knock() });

    const halifax = await login(h.server(), world.emails.halifaxSales);
    const seen = await call(h.server(), 'GET', `/leads/pins?${AROUND}`, { token: halifax });
    assert.ok(!seen.body.data.some((p: { id: string }) => p.id === made.body.data.id));

    const edit = await call(h.server(), 'PATCH', `/leads/pins/${made.body.data.id}`, {
      token: halifax,
      body: { status: 'lead' },
    });
    assert.equal(edit.status, 404);
  });

  it('lets only the rep who dropped a pin, or the office, remove it', async () => {
    const world = h.world();
    const rep = await login(h.server(), world.emails.sales);
    const made = await call(h.server(), 'POST', '/leads/pins', { token: rep, body: knock() });

    const manager = await login(h.server(), world.emails.kingstonManager);
    const byOffice = await call(h.server(), 'DELETE', `/leads/pins/${made.body.data.id}`, {
      token: manager,
    });
    assert.equal(byOffice.status, 204);
  });

  it('keeps door-knocking pins away from operators, but shows them customers', async () => {
    const token = await login(h.server(), h.world().emails.operator);

    const pins = await call(h.server(), 'GET', `/leads/pins?${AROUND}`, { token });
    assert.equal(pins.status, 403);

    const customers = await call(h.server(), 'GET', `/leads/customers?${AROUND}`, { token });
    assert.equal(customers.status, 200);
  });

  it('moves a house from pin to customer once they sign, with what they pay for', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.sales);
    const pin = await call(h.server(), 'POST', '/leads/pins', { token, body: knock() });
    const at = pin.body.data;

    const opened = await call(h.server(), 'POST', '/sales/deals', {
      token,
      body: {
        lead_pin_id: at.id,
        customer: {
          first_name: 'Pinned',
          last_name: 'Customer',
          email: 'pinned@example.test',
          preferred_contact: 'email',
        },
        property: {
          address_line1: at.address_line1,
          city: 'Kingston',
          province: 'ON',
          postal_code: at.postal_code,
          latitude: Number(at.latitude),
          longitude: Number(at.longitude),
          access_notes: 'Dog in the yard until 8',
        },
        quote: {
          billing_type: 'monthly',
          initial_price: 150,
          discounted_price: 125,
          recurring_price: 110,
          ...season(),
          addon_salt: true,
          addon_stairs: true,
        },
      },
    });
    assert.equal(opened.status, 201, JSON.stringify(opened.body));

    // In sign-up but not signed: still a pin, now tied to them.
    const before = await call(h.server(), 'GET', `/leads/pins?${AROUND}`, { token });
    const linked = before.body.data.find((p: { id: string }) => p.id === at.id);
    assert.equal(linked?.customer_id, opened.body.data.customer.id);

    const signed = await call(h.server(), 'POST', '/contracts', {
      token,
      body: {
        quote_id: opened.body.data.quote.id,
        signature_image_url: 'signatures/2026/01/map.png',
        terms_version: 'v1',
        checklist: [],
      },
    });
    assert.equal(signed.status, 201, JSON.stringify(signed.body));

    const after = await call(h.server(), 'GET', `/leads/pins?${AROUND}`, { token });
    assert.ok(!after.body.data.some((p: { id: string }) => p.id === at.id), 'pin should drop off');

    const customers = await call(h.server(), 'GET', `/leads/customers?${AROUND}`, { token });
    const house = customers.body.data.find(
      (c: { customer_id: string }) => c.customer_id === opened.body.data.customer.id,
    );
    assert.ok(house, 'the signed house should be a customer pin');
    assert.equal(house.addon_salt, true);
    assert.equal(house.addon_stairs, true);
    assert.equal(house.addon_vehicle, false);
    assert.equal(house.access_notes, 'Dog in the yard until 8');
  });

  it('signs up a lead from the map at the house already on file for them', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const pin = await call(h.server(), 'POST', '/leads/pins', {
      token,
      body: knock({
        status: 'lead',
        lead: { first_name: 'Came', last_name: 'Back', email: 'came.back@example.test' },
      }),
    });
    const at = pin.body.data;
    const house = await db('properties').where({ customer_id: at.customer_id }).first();
    assert.ok(house);

    const opened = await call(h.server(), 'POST', '/sales/deals', {
      token,
      body: {
        customer_id: at.customer_id,
        lead_pin_id: at.id,
        property: {
          address_line1: at.address_line1,
          address_line2: 'Rear',
          city: 'Kingston',
          province: 'ON',
          postal_code: at.postal_code,
          access_notes: 'Side gate',
        },
        quote: { billing_type: 'monthly', initial_price: 130, discounted_price: 120, recurring_price: 105, ...season() },
      },
    });

    assert.equal(opened.status, 201, JSON.stringify(opened.body));
    assert.equal(opened.body.data.property.id, house.id, 'the lead\'s house should be reused');
    assert.equal(opened.body.data.property.access_notes, 'Side gate');
  });

  it('says the address is taken, rather than failing, when a deal repeats one', async () => {
    const world = h.world();
    const existing = await makeCustomer(world.branches.kingston, world.users.sales);
    const property = (await db('properties').where({ id: existing.property_id }).first())!;
    const token = await login(h.server(), world.emails.sales);

    const reply = await call(h.server(), 'POST', '/sales/deals', {
      token,
      body: {
        customer: { first_name: 'Same', last_name: 'House', email: 'same@example.test' },
        property: {
          address_line1: property.address_line1,
          city: property.city,
          province: property.province,
          postal_code: property.postal_code,
        },
        quote: { billing_type: 'monthly', initial_price: 120, discounted_price: 110, recurring_price: 100, ...season() },
      },
    });

    assert.equal(reply.status, 409, JSON.stringify(reply.body));
    assert.match(JSON.stringify(reply.body), /already on the books/);
    const orphan = await db('customers').where({ last_name: 'House', first_name: 'Same' }).first();
    assert.equal(orphan, undefined);
  });
});
