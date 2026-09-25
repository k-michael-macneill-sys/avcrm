/*
 * Facebook Page and Instagram direct messages, against a stand-in Graph API.
 *
 * The environment is set before anything imports the configuration, which is
 * read once at load — so the application under test really is pointed at the
 * stand-in and really checks signatures against this secret.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, beforeEach, describe, it } from 'node:test';
import { startGraphApi, type FakeGraphApi } from './helpers/graphApi';

const graph: FakeGraphApi = await startGraphApi();
const APP_SECRET = 'test-meta-app-secret';
const VERIFY_TOKEN = 'test-meta-verify-token';
process.env.META_GRAPH_API_BASE = graph.url;
process.env.META_PAGE_ACCESS_TOKEN = 'test-page-access-token';
process.env.META_APP_SECRET = APP_SECRET;
process.env.META_VERIFY_TOKEN = VERIFY_TOKEN;

const { db } = await import('./helpers/database');
const { makeCustomer } = await import('./helpers/fixtures');
const { harness } = await import('./helpers/harness');
const { call, login } = await import('./helpers/server');
const { runMessageQueue } = await import('../src/jobs/messageQueue');

const PAGE_ID = '1122334455';
let mid = 0;

/** A Messenger Platform delivery with one message in it. */
function delivery(
  from: string,
  text: string,
  options: { object?: 'page' | 'instagram'; mid?: string; echo?: boolean; at?: number } = {},
) {
  mid += 1;
  const person = { id: from };
  const page = { id: PAGE_ID };
  return {
    object: options.object ?? 'page',
    entry: [
      {
        id: PAGE_ID,
        time: Date.now(),
        messaging: [
          {
            sender: options.echo ? page : person,
            recipient: options.echo ? person : page,
            timestamp: options.at ?? Date.now(),
            message: { mid: options.mid ?? `m_in_${mid}`, text, ...(options.echo ? { is_echo: true } : {}) },
          },
        ],
      },
    ],
  };
}

function sign(raw: string, secret = APP_SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
}

describe('Facebook and Instagram messages', () => {
  const h = harness();

  after(async () => {
    await graph.close();
  });

  beforeEach(() => {
    graph.clear();
  });

  async function deliver(payload: unknown, signature?: string) {
    const raw = JSON.stringify(payload);
    return call(h.server(), 'POST', '/webhooks/meta', {
      raw,
      headers: {
        'Content-Type': 'application/json',
        ...(signature === undefined ? { 'X-Hub-Signature-256': sign(raw) } : signature ? { 'X-Hub-Signature-256': signature } : {}),
      },
    });
  }

  async function conversationFor(externalUserId: string) {
    return db('meta_conversations').where({ external_user_id: externalUserId }).first();
  }

  async function routeTo(externalUserId: string, branchId: string) {
    await db('meta_conversations').where({ external_user_id: externalUserId }).update({ branch_id: branchId });
  }

  describe('the webhook', () => {
    it('answers the subscription handshake with the challenge', async () => {
      const ok = await call(
        h.server(),
        'GET',
        `/webhooks/meta?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=8675309`,
      );
      assert.equal(ok.status, 200);
      assert.equal(ok.body, '8675309');

      const wrong = await call(
        h.server(),
        'GET',
        '/webhooks/meta?hub.mode=subscribe&hub.verify_token=guess&hub.challenge=8675309',
      );
      assert.equal(wrong.status, 403);
    });

    it('refuses a delivery that is unsigned, or signed with anything but the app secret', async () => {
      const payload = delivery('psid-1', 'Do you do driveways?');

      assert.equal((await deliver(payload, '')).status, 401);
      assert.equal((await deliver(payload, sign(JSON.stringify(payload), 'not-the-secret'))).status, 401);
      assert.equal(await conversationFor('psid-1'), undefined);
    });

    it('refuses a body that was altered after it was signed', async () => {
      const payload = delivery('psid-1', 'Do you do driveways?');
      const signature = sign(JSON.stringify(payload));
      const tampered = { ...payload, object: 'instagram' };

      assert.equal((await deliver(tampered, signature)).status, 401);
    });

    it('stores a new message and opens a conversation for it', async () => {
      const reply = await deliver(delivery('psid-1', 'Do you do driveways?'));
      assert.equal(reply.status, 200);
      assert.equal(reply.body, 'EVENT_RECEIVED');

      const conversation = await conversationFor('psid-1');
      assert.equal(conversation.platform, 'facebook');
      assert.ok(conversation.last_inbound_at, 'the reply window opens');

      const messages = await db('meta_messages').where({ conversation_id: conversation.id });
      assert.equal(messages.length, 1);
      assert.equal(messages[0].direction, 'inbound');
      assert.equal(messages[0].status, 'received');
      assert.equal(messages[0].message_text, 'Do you do driveways?');
    });

    it('tells Instagram apart from the Page', async () => {
      await deliver(delivery('igsid-1', 'Price for a double?', { object: 'instagram' }));
      assert.equal((await conversationFor('igsid-1')).platform, 'instagram');
    });

    it('stores a redelivered message once', async () => {
      const payload = delivery('psid-1', 'Hello?');
      await deliver(payload);
      await deliver(payload);

      const conversation = await conversationFor('psid-1');
      const count = await db('meta_messages').where({ conversation_id: conversation.id }).count('* as n').first();
      assert.equal(Number(count?.n), 1);
    });

    it('keeps adding to the same conversation', async () => {
      await deliver(delivery('psid-1', 'Hello?'));
      await deliver(delivery('psid-1', 'Anyone there?'));

      assert.equal(await db('meta_conversations').count('* as n').first().then((r) => Number(r?.n)), 1);
      assert.equal(await db('meta_messages').count('* as n').first().then((r) => Number(r?.n)), 2);
    });

    it('describes a photo rather than storing nothing', async () => {
      const payload = delivery('psid-1', '');
      const event = payload.entry[0]!.messaging[0]!;
      event.message = { mid: 'm_photo', attachments: [{ type: 'image' }] } as never;
      await deliver(payload);

      const message = await db('meta_messages').where({ external_message_id: 'm_photo' }).first();
      assert.equal(message.message_text, '[image]');
    });

    it('waits unassigned when there is more than one branch to choose from', async () => {
      await deliver(delivery('psid-1', 'Hi'));
      assert.equal((await conversationFor('psid-1')).branch_id, null);
    });

    it('goes straight to the only branch there is', async () => {
      await db('branches').where({ id: h.world().branches.halifax }).update({ status: 'inactive' });
      await deliver(delivery('psid-1', 'Hi'));
      assert.equal((await conversationFor('psid-1')).branch_id, h.world().branches.kingston);
    });

    it('records a reply typed into Meta’s own inbox', async () => {
      await deliver(delivery('psid-1', 'Hi'));
      await deliver(delivery('psid-1', 'Hi! Yes we do.', { echo: true, mid: 'm_echo_1' }));

      const echo = await db('meta_messages').where({ external_message_id: 'm_echo_1' }).first();
      assert.equal(echo.direction, 'outbound');
      assert.equal(echo.status, 'sent');
      assert.equal(echo.sent_by_user_id, null);
    });
  });

  describe('the inbox', () => {
    it('shows an unassigned conversation to corporate only', async () => {
      await deliver(delivery('psid-1', 'Hi'));
      const corporate = await login(h.server(), h.world().emails.corporate);
      const sales = await login(h.server(), h.world().emails.sales);

      const all = await call(h.server(), 'GET', '/meta/conversations?unassigned=true', { token: corporate });
      assert.equal(all.status, 200);
      assert.equal(all.body.meta.total, 1);
      assert.equal(all.body.data[0].last_message_text, 'Hi');

      const mine = await call(h.server(), 'GET', '/meta/conversations', { token: sales });
      assert.equal(mine.body.meta.total, 0);
    });

    it('keeps each branch to its own conversations', async () => {
      await deliver(delivery('psid-1', 'Hi'));
      await routeTo('psid-1', h.world().branches.kingston);
      const id = (await conversationFor('psid-1')).id;

      const sales = await login(h.server(), h.world().emails.sales);
      const halifaxSales = await login(h.server(), h.world().emails.halifaxSales);

      const thread = await call(h.server(), 'GET', `/meta/conversations/${id}/messages`, { token: sales });
      assert.equal(thread.status, 200);
      assert.equal(thread.body.data[0].message_text, 'Hi');

      const other = await call(h.server(), 'GET', `/meta/conversations/${id}/messages`, { token: halifaxSales });
      assert.equal(other.status, 404);
      const reply = await call(h.server(), 'POST', `/meta/conversations/${id}/messages`, {
        token: halifaxSales,
        body: { message_text: 'Not mine to answer' },
      });
      assert.equal(reply.status, 404);
    });

    it('is not for the crew', async () => {
      const operator = await login(h.server(), h.world().emails.operator);
      const reply = await call(h.server(), 'GET', '/meta/conversations', { token: operator });
      assert.equal(reply.status, 403);
    });

    it('lets corporate route a conversation, and a rep only link a customer in their own branch', async () => {
      await deliver(delivery('psid-1', 'Hi'));
      const id = (await conversationFor('psid-1')).id;
      const corporate = await login(h.server(), h.world().emails.corporate);
      const sales = await login(h.server(), h.world().emails.sales);

      const routed = await call(h.server(), 'PATCH', `/meta/conversations/${id}`, {
        token: corporate,
        body: { branch_id: h.world().branches.kingston },
      });
      assert.equal(routed.status, 200);
      assert.equal(routed.body.data.branch_id, h.world().branches.kingston);

      const moved = await call(h.server(), 'PATCH', `/meta/conversations/${id}`, {
        token: sales,
        body: { branch_id: h.world().branches.halifax },
      });
      assert.equal(moved.status, 403);

      const customer = await makeCustomer(h.world().branches.kingston, h.world().users.sales);
      const linked = await call(h.server(), 'PATCH', `/meta/conversations/${id}`, {
        token: sales,
        body: { customer_id: customer.customer_id },
      });
      assert.equal(linked.status, 200);
      assert.equal(linked.body.data.customer_id, customer.customer_id);

      const outsider = await makeCustomer(h.world().branches.halifax, h.world().users.corporate, {
        email: 'someone.else@example.test',
        address_line1: '9 Other Street',
      });
      const wrong = await call(h.server(), 'PATCH', `/meta/conversations/${id}`, {
        token: sales,
        body: { customer_id: outsider.customer_id },
      });
      assert.equal(wrong.status, 400);
    });

    it('routes an unassigned conversation by the customer it is linked to', async () => {
      await deliver(delivery('psid-1', 'Hi, it is Harold'));
      const id = (await conversationFor('psid-1')).id;
      const corporate = await login(h.server(), h.world().emails.corporate);
      const customer = await makeCustomer(h.world().branches.halifax, h.world().users.corporate);

      const linked = await call(h.server(), 'PATCH', `/meta/conversations/${id}`, {
        token: corporate,
        body: { customer_id: customer.customer_id },
      });
      assert.equal(linked.status, 200, JSON.stringify(linked.body));
      assert.equal(linked.body.data.branch_id, h.world().branches.halifax);
    });
  });

  describe('replying', () => {
    async function kingstonThread(from = 'psid-1', at?: number) {
      await deliver(delivery(from, 'Do you do driveways?', { at }));
      await routeTo(from, h.world().branches.kingston);
      return (await conversationFor(from)).id as string;
    }

    it('queues the reply, and the worker sends it through the Graph API as the Page', async () => {
      const id = await kingstonThread();
      const sales = await login(h.server(), h.world().emails.sales);

      const queued = await call(h.server(), 'POST', `/meta/conversations/${id}/messages`, {
        token: sales,
        body: { message_text: '  We do! What is the address?  ' },
      });
      assert.equal(queued.status, 202);
      assert.equal(queued.body.data.status, 'queued');
      assert.equal(queued.body.data.message_text, 'We do! What is the address?');
      assert.equal(graph.sent().length, 0, 'nothing is sent inside the request');

      await runMessageQueue();

      assert.deepEqual(graph.sent(), [
        {
          token: 'test-page-access-token',
          recipient: 'psid-1',
          messaging_type: 'RESPONSE',
          text: 'We do! What is the address?',
        },
      ]);
      const row = await db('meta_messages').where({ id: queued.body.data.id }).first();
      assert.equal(row.status, 'sent');
      assert.equal(row.external_message_id, 'm_fake_1');
      assert.equal(row.sent_by_user_id, h.world().users.sales);
    });

    it('keeps one copy when Meta’s echo of our own reply arrives before the worker is done', async () => {
      const id = await kingstonThread();
      const sales = await login(h.server(), h.world().emails.sales);
      const queued = await call(h.server(), 'POST', `/meta/conversations/${id}/messages`, {
        token: sales,
        body: { message_text: 'On our way' },
      });

      graph.nextMid('m_ours');
      await deliver(delivery('psid-1', 'On our way', { echo: true, mid: 'm_ours' }));
      await runMessageQueue();

      const rows = await db('meta_messages').where({ external_message_id: 'm_ours' });
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, queued.body.data.id, 'the row that knows who wrote it stays');
    });

    it('ignores the echo when it arrives after the send was recorded', async () => {
      const id = await kingstonThread();
      const sales = await login(h.server(), h.world().emails.sales);
      await call(h.server(), 'POST', `/meta/conversations/${id}/messages`, {
        token: sales,
        body: { message_text: 'On our way' },
      });
      await runMessageQueue();
      await deliver(delivery('psid-1', 'On our way', { echo: true, mid: 'm_fake_1' }));

      assert.equal(await db('meta_messages').where({ external_message_id: 'm_fake_1' }).count('* as n').first().then((r) => Number(r?.n)), 1);
    });

    it('refuses a reply outside Meta’s 24-hour window', async () => {
      const id = await kingstonThread('psid-1', Date.now() - 25 * 60 * 60_000);
      const sales = await login(h.server(), h.world().emails.sales);

      const reply = await call(h.server(), 'POST', `/meta/conversations/${id}/messages`, {
        token: sales,
        body: { message_text: 'Sorry for the wait' },
      });
      assert.equal(reply.status, 409);
      assert.match(reply.body.error.message, /24 hours/);
    });

    it('refuses an empty reply, and one longer than Meta allows', async () => {
      const id = await kingstonThread();
      const sales = await login(h.server(), h.world().emails.sales);

      for (const message_text of ['   ', 'x'.repeat(2001)]) {
        const reply = await call(h.server(), 'POST', `/meta/conversations/${id}/messages`, {
          token: sales,
          body: { message_text },
        });
        assert.equal(reply.status, 400);
      }
    });

    it('gives up at once on a refusal that will not change, and retries a rate limit', async () => {
      const refused = await kingstonThread('outside-window');
      const limited = await kingstonThread('rate-limited');
      const sales = await login(h.server(), h.world().emails.sales);

      const a = await call(h.server(), 'POST', `/meta/conversations/${refused}/messages`, {
        token: sales,
        body: { message_text: 'Hello' },
      });
      const b = await call(h.server(), 'POST', `/meta/conversations/${limited}/messages`, {
        token: sales,
        body: { message_text: 'Hello' },
      });

      const summary = await runMessageQueue();
      assert.equal(summary.rejected, 1);
      assert.equal(summary.retrying, 1);

      const failed = await db('meta_messages').where({ id: a.body.data.id }).first();
      assert.equal(failed.status, 'failed');
      assert.equal(failed.attempts, 1);
      assert.match(failed.error, /outside of allowed window/);

      const waiting = await db('meta_messages').where({ id: b.body.data.id }).first();
      assert.equal(waiting.status, 'queued');
      assert.match(waiting.error, /request limit/);
    });
  });
});
