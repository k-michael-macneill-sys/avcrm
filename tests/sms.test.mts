/*
 * The SMS provider, against a stand-in gateway.
 *
 * The environment is set before anything imports the configuration, which is
 * read once at load — so the application under test here really is pointed at
 * the stand-in. Node runs each test file in its own process, which is what
 * makes that safe.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startGateway, type FakeGateway } from './helpers/smsGateway';

const gateway: FakeGateway = await startGateway();
process.env.SMS_API_BASE = gateway.url;

const { db, resetDatabase } = await import('./helpers/database');
const { buildWorld } = await import('./helpers/fixtures');
const { call, login, startServer } = await import('./helpers/server');
const { sendQueued } = await import('../src/services/messages');

describe('connecting a text message provider', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let corporate: string;
  let branchId: string;

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
    const world = await buildWorld();
    branchId = world.branches.kingston;
    corporate = await login(server, world.emails.corporate);
  });

  const twilio = (enabled: boolean) => ({
    provider: 'twilio',
    is_enabled: enabled,
    settings: { account_sid: 'AC_test_account', from: '+19025550123' },
    secrets: { auth_token: 'super-secret-token' },
  });

  async function queueSms(recipient: string): Promise<void> {
    await db('message_log').insert({
      template_code: 'en_route',
      channel: 'sms',
      recipient,
      body: 'The crew is on the way.',
      branch_id: branchId,
      status: 'queued',
    });
  }

  it('starts with nothing configured', async () => {
    const reply = await call(server, 'GET', '/settings/sms', { token: corporate });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.provider, 'none');
    assert.equal(reply.body.data.is_enabled, false);
  });

  it('offers the catalogue the screen builds itself from', async () => {
    const reply = await call(server, 'GET', '/settings/sms/providers', { token: corporate });
    const ids = reply.body.data.map((p: { id: string }) => p.id);
    assert.ok(ids.includes('twilio'));
    assert.ok(ids.includes('custom'), 'a gateway nobody wrote code for must be possible');
  });

  it('refuses to switch on a provider that is missing credentials', async () => {
    const reply = await call(server, 'PUT', '/settings/sms', {
      token: corporate,
      body: { provider: 'twilio', is_enabled: true, settings: { from: '+19025550123' }, secrets: {} },
    });

    assert.equal(reply.status, 400);
    assert.match(reply.body.error.message, /Account SID/);
    assert.match(reply.body.error.message, /Auth token/);
  });

  it('keeps the credential out of the API, the database and the audit log', async () => {
    const saved = await call(server, 'PUT', '/settings/sms', {
      token: corporate,
      body: twilio(false),
    });

    assert.equal(saved.status, 200);
    assert.deepEqual(saved.body.data.secrets_set, ['auth_token']);
    assert.doesNotMatch(JSON.stringify(saved.body), /super-secret-token/);

    const row = await db('integration_settings').where({ key: 'sms' }).first();
    assert.doesNotMatch(row?.secret_ciphertext ?? '', /super-secret-token/);

    const audited = await db('audit_log').where({ action: 'integration.updated' });
    assert.equal(audited.length, 1);
    assert.doesNotMatch(JSON.stringify(audited), /super-secret-token/);
  });

  it('sends a test through the saved credentials before it is switched on', async () => {
    await call(server, 'PUT', '/settings/sms', { token: corporate, body: twilio(false) });

    const reply = await call(server, 'POST', '/settings/sms/test', {
      token: corporate,
      body: { to: '+19025551234', body: 'Test from the suite' },
    });

    assert.equal(reply.status, 200);
    const sent = gateway.sent();
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.provider, 'twilio');
    assert.equal(sent[0]?.from, '+19025550123');
    assert.equal(sent[0]?.account, 'AC_test_account');
    assert.equal(sent[0]?.body, 'Test from the suite');
  });

  it('gives the gateway own words back when a test is refused', async () => {
    await call(server, 'PUT', '/settings/sms', { token: corporate, body: twilio(false) });

    const bad = await call(server, 'POST', '/settings/sms/test', {
      token: corporate,
      body: { to: '+15550000400' },
    });
    assert.equal(bad.status, 400, 'a bad number is nobody trying again');
    assert.equal(bad.body.error.details.permanent, true);

    const down = await call(server, 'POST', '/settings/sms/test', {
      token: corporate,
      body: { to: '+15550000503' },
    });
    assert.equal(down.status, 502, 'a gateway having a bad afternoon is worth a retry');
    assert.equal(down.body.error.details.permanent, false);
  });

  it('queues but does not send until someone switches it on', async () => {
    await call(server, 'PUT', '/settings/sms', { token: corporate, body: twilio(false) });
    await queueSms('+19025559999');

    const summary = await sendQueued(10);
    assert.equal(summary.claimed, 1);
    assert.equal(gateway.sent().length, 0, 'nothing leaves while it is off');

    const row = await db('message_log').where({ recipient: '+19025559999' }).first();
    assert.equal(row?.status, 'sent', 'the row still records that the queue handled it');
  });

  it('really sends once it is on, without retyping the credential', async () => {
    await call(server, 'PUT', '/settings/sms', { token: corporate, body: twilio(false) });
    const on = await call(server, 'PUT', '/settings/sms', {
      token: corporate,
      body: { ...twilio(true), secrets: {} },
    });
    assert.deepEqual(on.body.data.secrets_set, ['auth_token']);

    await queueSms('+19025558888');
    await sendQueued(10);

    assert.equal(gateway.sent().length, 1);
    assert.equal(gateway.sent()[0]?.to, '+19025558888');

    const row = await db('message_log').where({ recipient: '+19025558888' }).first();
    assert.match(row?.provider_message_id ?? '', /^SM/);
  });

  it('stops at once on a bad number, and retries an outage', async () => {
    await call(server, 'PUT', '/settings/sms', { token: corporate, body: twilio(true) });

    await queueSms('+15550000400');
    await sendQueued(10);
    const refused = await db('message_log').where({ recipient: '+15550000400' }).first();
    assert.equal(refused?.status, 'failed');
    assert.equal(refused?.attempts, 1, 'three more tries would not make the number valid');

    await queueSms('+15550000503');
    await sendQueued(10);
    const outage = await db('message_log').where({ recipient: '+15550000503' }).first();
    assert.equal(outage?.status, 'queued', 'back in the queue for another pass');
  });

  it('drops the old credentials when the provider changes', async () => {
    await call(server, 'PUT', '/settings/sms', { token: corporate, body: twilio(false) });

    const switched = await call(server, 'PUT', '/settings/sms', {
      token: corporate,
      body: {
        provider: 'telnyx',
        is_enabled: false,
        settings: { from: '+19025550123' },
        secrets: {},
      },
    });
    // A Twilio token is not a Telnyx key; keeping it would leave a secret
    // nobody can see and nobody meant to keep.
    assert.deepEqual(switched.body.data.secrets_set, []);

    const reply = await call(server, 'POST', '/settings/sms/test', {
      token: corporate,
      body: { to: '+19025551234' },
    });
    assert.equal(reply.status, 400);
    assert.match(reply.body.error.message, /401/);
  });

  it('reaches a gateway nobody wrote code for, with quoting intact', async () => {
    await call(server, 'PUT', '/settings/sms', {
      token: corporate,
      body: {
        provider: 'custom',
        is_enabled: true,
        settings: {
          url: `${gateway.url}/custom/send`,
          content_type: 'json',
          auth_header_name: 'x-api-key',
          from: 'AVALANCHE',
          body_template:
            '{"destination":"{{to}}","sender":"{{from}}","message":"{{body}}"}',
          message_id_path: 'result.reference',
        },
        secrets: { auth_header_value: 'custom-secret' },
      },
    });

    const awkward = 'Quoted "text" and a backslash \\ in it';
    const reply = await call(server, 'POST', '/settings/sms/test', {
      token: corporate,
      body: { to: '+19025557777', body: awkward },
    });

    assert.equal(reply.status, 200);
    const sent = gateway.sent()[0];
    assert.equal(sent?.provider, 'custom');
    assert.equal(sent?.from, 'AVALANCHE');
    // The template is filled in by substitution, so a quote in the message
    // must not be able to break out of the string it sits in.
    assert.equal(sent?.body, awkward);
    assert.match(reply.body.data.provider_message_id, /^cx/);
  });

  it('is corporate work', async () => {
    const world = await db('users').where({ email: 'otto@test.local' }).first();
    assert.ok(world);
    const operator = await login(server, 'otto@test.local');

    assert.equal((await call(server, 'GET', '/settings/sms', { token: operator })).status, 403);
    assert.equal(
      (await call(server, 'PUT', '/settings/sms', { token: operator, body: twilio(true) })).status,
      403,
    );
  });
});
