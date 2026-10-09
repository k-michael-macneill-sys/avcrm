/*
 * Twilio configured in the environment (TWILIO_*), with nothing in Settings:
 * texts go out on their own, the same as once a provider is switched on
 * there. Set before the configuration loads, as in sms.test.mts.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startGateway, type FakeGateway } from './helpers/smsGateway';

const gateway: FakeGateway = await startGateway();
process.env.SMS_API_BASE = gateway.url;
process.env.TWILIO_ACCOUNT_SID = 'AC_env_account';
process.env.TWILIO_AUTH_TOKEN = 'env-auth-token';
process.env.TWILIO_FROM_NUMBER = '+16135550100';

const { db, resetDatabase } = await import('./helpers/database');
const { buildWorld, makeContract, setTemplate } = await import('./helpers/fixtures');
const { call, login, startServer } = await import('./helpers/server');
const { sendQueued } = await import('../src/services/messages');

describe('Twilio from the environment', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let world: Awaited<ReturnType<typeof buildWorld>>;
  let corporate: string;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.close();
    await gateway.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    gateway.clear();
    world = await buildWorld();
    corporate = await login(server, world.emails.corporate);
  });

  it('shows Settings that the server has Twilio, without its values', async () => {
    const reply = await call(server, 'GET', '/settings/sms', { token: corporate });
    assert.equal(reply.status, 200);
    assert.deepEqual(reply.body.data.env_twilio, {
      account_sid: true,
      auth_token: true,
      from_number: true,
      live: true,
    });
    assert.doesNotMatch(JSON.stringify(reply.body), /env-auth-token/);
  });

  it('texts an invoice to a customer who asked for texts, with nothing switched on in Settings', async () => {
    const contract = await makeContract(world.branches.kingston, world.users.operator, {
      preferred_contact: 'sms',
      phone: '+16135550177',
    });
    await setTemplate('invoice_sent', 'sms', '${{amount_due}} due. {{pay_prompt}}: {{pay_url}}');
    const created = await call(server, 'POST', '/invoices', {
      token: corporate,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-01-01',
        billing_period_end: '2027-01-31',
        amount_due: 149.5,
        due_date: '2027-01-15',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const sent = await call(server, 'POST', `/invoices/${created.body.data.id}/send`, { token: corporate });
    assert.equal(sent.status, 200, JSON.stringify(sent.body));

    const summary = await sendQueued(10);
    assert.equal(summary.sent, 1);

    const [text] = gateway.sent();
    assert.equal(text?.provider, 'twilio');
    assert.equal(text?.account, 'AC_env_account');
    assert.equal(text?.from, '+16135550100');
    assert.equal(text?.to, '+16135550177');
    assert.match(text?.body ?? '', /\$149\.50/);
    assert.match(text?.body ?? '', /\/pay\//);

    const row = await db('message_log').where({ template_code: 'invoice_sent' }).first();
    assert.equal(row?.channel, 'sms');
    assert.match(row?.provider_message_id ?? '', /^SM/);
  });

  it('sends a test from Settings through the environment credentials', async () => {
    const reply = await call(server, 'POST', '/settings/sms/test', {
      token: corporate,
      body: { to: '+16135550188' },
    });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    assert.equal(gateway.sent()[0]?.account, 'AC_env_account');
  });

  it('gives way to a provider switched on in Settings', async () => {
    await call(server, 'PUT', '/settings/sms', {
      token: corporate,
      body: { provider: 'telnyx', is_enabled: true, settings: { from: '+19025550123' }, secrets: { api_key: 'KEY_x' } },
    });
    await db('message_log').insert({
      template_code: 'en_route',
      channel: 'sms',
      recipient: '+16135550199',
      body: 'On the way.',
      branch_id: world.branches.kingston,
      status: 'queued',
    });

    await sendQueued(10);
    assert.equal(gateway.sent()[0]?.provider, 'telnyx');
  });
});
