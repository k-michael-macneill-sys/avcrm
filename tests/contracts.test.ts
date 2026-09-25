import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeCustomer, makeQuote } from './helpers/fixtures';
import { call, login } from './helpers/server';

describe('signing a contract at the door', () => {
  const h = harness();

  const signature = 'signatures/2026/01/abc.png';

  /** Everything the gate wants, so a test can remove exactly one thing. */
  const goodSignature = (quoteId: string) => ({
    quote_id: quoteId,
    signature_image_url: signature,
    terms_version: 'v1',
    signed_lat: 44.2305,
    signed_lng: -76.4944,
    checklist: [],
  });

  async function sellable() {
    const world = h.world();
    const made = await makeCustomer(world.branches.kingston, world.users.sales);
    const quote = await makeQuote(made.property_id, world.users.sales, { status: 'presented' });
    const token = await login(h.server(), world.emails.sales);
    return { ...made, quote, token };
  }


  it('signs when they are, and records where it happened', async () => {
    const { quote, token } = await sellable();

    const reply = await call(h.server(), 'POST', '/contracts', {
      token,
      body: goodSignature(quote),
    });

    assert.equal(reply.status, 201);
    assert.equal(reply.body.data.status, 'active');
    // Taken from the connection, never from the body — that is what makes it
    // evidence rather than something the client typed.
    assert.ok(reply.body.data.signed_ip);
    assert.equal(reply.body.data.signed_lat, '44.230500');
  });

  it('moves the quote to accepted in the same breath', async () => {
    const { quote, token } = await sellable();
    await call(h.server(), 'POST', '/contracts', { token, body: goodSignature(quote) });

    const after = await db('quotes').where({ id: quote }).first();
    assert.equal(after?.status, 'accepted');
  });

  it('never returns the payment token, only the last four', async () => {
    const { quote, token } = await sellable();

    const reply = await call(h.server(), 'POST', '/contracts', {
      token,
      body: {
        ...goodSignature(quote),
        payment_method_token: 'pm_a_processor_token',
        payment_method_last4: '4242',
        payment_method_brand: 'visa',
      },
    });

    assert.equal(reply.status, 201);
    assert.equal('payment_method_token' in reply.body.data, false);
    assert.equal(reply.body.data.payment_method_last4, '4242');

    // Stored, though — it is what a charge uses.
    const stored = await db('contracts').where({ id: reply.body.data.id }).first();
    assert.equal(stored?.payment_method_token, 'pm_a_processor_token');
  });

  it('refuses anything that looks like a card number', async () => {
    const { quote, token } = await sellable();

    for (const candidate of ['4242424242424242', '4242 4242 4242 4242', '4242-4242-4242-4242']) {
      const reply = await call(h.server(), 'POST', '/contracts', {
        token,
        body: {
          ...goodSignature(quote),
          payment_method_token: candidate,
          payment_method_last4: '4242',
        },
      });
      assert.equal(reply.status, 400, `${candidate} should be refused`);
    }
  });


  it('allows only one active contract per property', async () => {
    const { property_id, quote, token } = await sellable();
    const first = await call(h.server(), 'POST', '/contracts', {
      token,
      body: goodSignature(quote),
    });
    assert.equal(first.status, 201);

    const second = await makeQuote(property_id, h.world().users.sales, { status: 'presented' });
    const reply = await call(h.server(), 'POST', '/contracts', {
      token,
      body: goodSignature(second),
    });

    assert.equal(reply.status, 409);
  });

  it('writes the signing to the audit log without the token in it', async () => {
    const { quote, token } = await sellable();
    await call(h.server(), 'POST', '/contracts', {
      token,
      body: {
        ...goodSignature(quote),
        payment_method_token: 'pm_secret_token',
        payment_method_last4: '4242',
        payment_method_brand: 'visa',
      },
    });

    const entries = await db('audit_log').where({ entity_type: 'contract' });
    assert.equal(entries.length, 1);
    assert.doesNotMatch(JSON.stringify(entries[0]), /pm_secret_token/);
    assert.match(JSON.stringify(entries[0]), /4242/);
  });

  it('will not let anything rewrite the audit log', async () => {
    const { quote, token } = await sellable();
    await call(h.server(), 'POST', '/contracts', { token, body: goodSignature(quote) });

    await assert.rejects(
      () => db('audit_log').update({ action: 'tampered' }),
      /append-only|cannot|not allowed/i,
    );
  });
});
