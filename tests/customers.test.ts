import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeCustomer, makeQuote } from './helpers/fixtures';
import { call, login } from './helpers/server';

describe('customers and the addresses they own', () => {
  const h = harness();

  const newCustomer = {
    first_name: 'Wanda',
    last_name: 'Walker',
    email: 'wanda@example.test',
    phone: '613-555-0999',
    preferred_contact: 'email',
  };

  it('files a new customer against the branch of whoever is signed in', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const reply = await call(h.server(), 'POST', '/customers', {
      token,
      body: newCustomer,
    });

    assert.equal(reply.status, 201);
    // The branch comes from who is signed in, not from the request body.
    assert.equal(reply.body.data.branch_id, h.world().branches.kingston);
    assert.equal(reply.body.data.created_by_user_id, h.world().users.sales);
  });

  it('warns before a rep signs an address that is already on the books', async () => {
    const world = h.world();
    await makeCustomer(world.branches.kingston, world.users.sales, {
      address_line1: '212 Johnson St',
    });

    const token = await login(h.server(), world.emails.sales);
    const check = await call(
      h.server(),
      'GET',
      '/properties/check-duplicate?address_line1=212%20Johnson%20St&postal_code=K7L%201Y4',
      { token },
    );

    assert.equal(check.status, 200);
    // The warning names who already has it, so the rep can say so at the door
    // rather than just being stopped.
    assert.equal(check.body.data.duplicate.customer_name, 'Harold Bell');
    assert.equal(check.body.data.duplicate.branch_name, 'Kingston');
  });

  it('refuses the duplicate itself, with the existing one in the error', async () => {
    const world = h.world();
    const existing = await makeCustomer(world.branches.kingston, world.users.sales);

    const token = await login(h.server(), world.emails.sales);
    const reply = await call(h.server(), 'POST', '/properties', {
      token,
      body: {
        customer_id: existing.customer_id,
        address_line1: '212 Johnson St',
        city: 'Kingston',
        province: 'ON',
        postal_code: 'K7L 1Y4',
        driveway_size_cars: 2,
      },
    });

    assert.equal(reply.status, 409);
    assert.equal(reply.body.error.details.property_id, existing.property_id);
    assert.equal(reply.body.error.details.branch_name, 'Kingston');
  });

  it('deletes a customer nobody has signed', async () => {
    const world = h.world();
    const made = await makeCustomer(world.branches.kingston, world.users.sales);

    const token = await login(h.server(), world.emails.sales);
    const reply = await call(h.server(), 'DELETE', `/customers/${made.customer_id}`, { token });

    assert.equal(reply.status, 204);
    assert.equal(await db('customers').where({ id: made.customer_id }).first(), undefined);
  });

  it('refuses to delete one with a contract, rather than failing at the database', async () => {
    const world = h.world();
    const made = await makeCustomer(world.branches.kingston, world.users.sales);
    const quote = await makeQuote(made.property_id, world.users.sales, { status: 'accepted' });
    await db('contracts').insert({
      quote_id: quote,
      customer_id: made.customer_id,
      property_id: made.property_id,
      signature_image_url: 'signatures/2026/01/test.png',
      signed_at: new Date(),
      terms_version: 'v1',
      status: 'active',
    });

    const token = await login(h.server(), world.emails.sales);
    const reply = await call(h.server(), 'DELETE', `/customers/${made.customer_id}`, { token });

    // A foreign key violation is a 409 with an explanation, never a 500.
    assert.equal(reply.status, 409);
    assert.match(reply.body.error.message.toLowerCase(), /contract|in use|referenc/);
  });
  it('tells a rep an address is taken without saying whose it is', async () => {
    const world = h.world();
    await makeCustomer(world.branches.halifax, world.users.halifaxOperator, {
      first_name: 'Sam',
      last_name: 'Toussaint',
      address_line1: '5560 Cornwallis St',
    });

    const token = await login(h.server(), world.emails.sales);
    const check = await call(
      h.server(),
      'GET',
      '/properties/check-duplicate?address_line1=5560%20Cornwallis%20St&postal_code=K7L%201Y4',
      { token },
    );

    const duplicate = check.body.data.duplicate;
    // Enough to stop the rep signing it, and to say who to call — but another
    // branch's customer list is not theirs to read.
    assert.equal(duplicate.in_your_scope, false);
    assert.equal(duplicate.branch_name, 'Halifax');
    assert.equal('customer_name' in duplicate, false);
  });
});
