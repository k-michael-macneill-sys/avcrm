import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { runColdEmailDrip } from '../src/services/coldEmail';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeCustomer, setTemplate } from './helpers/fixtures';
import { call, login } from './helpers/server';

const DAY = 86_400_000;

describe('the cold email sequence', () => {
  const h = harness();

  async function enrol(overrides: Record<string, unknown> = {}) {
    const token = await login(h.server(), h.world().emails.corporate);
    const reply = await call(h.server(), 'POST', '/cold-email/leads', {
      token,
      body: {
        branch_id: h.world().branches.kingston,
        first_name: 'Maggie',
        last_name: 'Chen',
        email: 'maggie@example.test',
        source: 'door_to_door',
        consent: true,
        ...overrides,
      },
    });
    return { token, reply };
  }

  async function queued(leadId: string): Promise<string[]> {
    const rows = await db('message_log').where({ email_lead_id: leadId }).orderBy('created_at');
    return rows.map((r) => r.template_code as string);
  }

  it('confirms an opt-in at once and schedules the first follow-up', async () => {
    const { reply } = await enrol();

    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const lead = reply.body.data.lead;
    assert.equal(lead.status, 'active');
    assert.equal(lead.steps_sent, 1);
    assert.deepEqual(await queued(lead.id), ['drip_welcome']);

    const delay = Date.parse(lead.next_send_at) - Date.parse(lead.opted_in_at);
    assert.equal(Math.round(delay / DAY), 2, 'the first follow-up is two days on');

    const message = (await db('message_log').where({ email_lead_id: lead.id }).first())!;
    assert.equal(message.recipient, 'maggie@example.test');
    assert.equal(message.channel, 'email');
  });

  it('will not add anybody without their consent', async () => {
    const { reply } = await enrol({ consent: false });
    assert.equal(reply.status, 400);
    assert.equal(await db('email_leads').count('* as n').first().then((r) => r?.n), '0');
  });

  it('does not restart the sequence for a second opt-in', async () => {
    const first = await enrol();
    const second = await enrol({ email: 'MAGGIE@example.test', first_name: 'Margaret' });

    assert.equal(second.reply.status, 200);
    assert.equal(second.reply.body.data.enrolled, false);
    assert.equal(second.reply.body.data.lead.first_name, 'Margaret', 'details are kept current');
    assert.deepEqual(await queued(first.reply.body.data.lead.id), ['drip_welcome']);
  });

  it('sends each follow-up when it falls due, then finishes', async () => {
    const { reply } = await enrol();
    const id = reply.body.data.lead.id as string;

    assert.deepEqual(await runColdEmailDrip(new Date(Date.now() + DAY)), { sent: 0, converted: 0 }, 'nothing is due yet');

    await runColdEmailDrip(new Date(Date.now() + 2 * DAY + 60_000));
    assert.deepEqual(await queued(id), ['drip_welcome', 'drip_followup_1']);

    const later = new Date(Date.now() + 11 * DAY);
    await runColdEmailDrip(later);
    await runColdEmailDrip(later);
    await runColdEmailDrip(later);
    assert.deepEqual(await queued(id), ['drip_welcome', 'drip_followup_1', 'drip_followup_2', 'drip_followup_3']);

    const lead = await db('email_leads').where({ id }).first();
    assert.equal(lead.status, 'completed');
    assert.equal(lead.next_send_at, null);
  });

  it('stops selling to somebody who has become a customer', async () => {
    const { reply } = await enrol();
    await makeCustomer(h.world().branches.kingston, h.world().users.corporate, {
      email: 'Maggie@Example.test',
    });

    const summary = await runColdEmailDrip(new Date(Date.now() + 3 * DAY));
    assert.deepEqual(summary, { sent: 0, converted: 1 });
    const lead = await db('email_leads').where({ id: reply.body.data.lead.id }).first();
    assert.equal(lead.status, 'converted');
  });

  it('unsubscribes from the link, but only when the button is pressed', async () => {
    await setTemplate('drip_welcome', 'email', 'Unsubscribe: {{unsubscribe_url}}', 'Welcome');
    const { reply } = await enrol();
    const lead = reply.body.data.lead;

    const message = (await db('message_log').where({ email_lead_id: lead.id }).first())!;
    assert.equal(
      message.body,
      `Unsubscribe: http://127.0.0.1:3000/public/unsubscribe/${lead.unsubscribe_token}`,
      'every email carries its own link',
    );

    const opened = await call(h.server(), 'GET', `/public/unsubscribe/${lead.unsubscribe_token}`);
    assert.equal(opened.status, 200);
    assert.match(String(opened.body), /<form method="post">/);
    assert.equal((await db('email_leads').where({ id: lead.id }).first()).status, 'active', 'a mail scanner opening the link changes nothing');

    const pressed = await fetch(`${h.server().url}/public/unsubscribe/${lead.unsubscribe_token}`, { method: 'POST' });
    assert.equal(pressed.status, 200);

    const after = await db('email_leads').where({ id: lead.id }).first();
    assert.equal(after.status, 'unsubscribed');
    assert.ok(after.unsubscribed_at);

    const withdrawn = (await db('message_log').where({ email_lead_id: lead.id }).first())!;
    assert.equal(withdrawn.status, 'failed', 'the queued confirmation is withdrawn, not sent');

    assert.deepEqual(await runColdEmailDrip(new Date(Date.now() + 30 * DAY)), { sent: 0, converted: 0 });

    const unknown = await call(h.server(), 'GET', '/public/unsubscribe/not-a-real-token-at-all');
    assert.equal(unknown.status, 404);
  });

  it('takes Google Ads opt-ins from a landing page, as JSON or a plain form', async () => {
    const json = await call(h.server(), 'POST', '/public/opt-in', {
      body: {
        branch_id: h.world().branches.halifax,
        first_name: 'Dev',
        email: 'dev@example.test',
        consent: true,
        utm_campaign: 'fall-driveways',
        gclid: 'abc123',
      },
    });
    assert.equal(json.status, 201, JSON.stringify(json.body));
    assert.equal(json.headers.get('access-control-allow-origin'), '*');

    const lead = await db('email_leads').where({ email: 'dev@example.test' }).first();
    assert.equal(lead.source, 'google_ads');
    assert.equal(lead.campaign, 'fall-driveways');
    assert.equal(lead.gclid, 'abc123');

    const form = await call(h.server(), 'POST', '/public/opt-in', {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      raw: new URLSearchParams({
        branch_id: h.world().branches.halifax,
        first_name: 'Robin',
        email: 'robin@example.test',
        consent: 'on',
      }).toString(),
    });
    assert.equal(form.status, 201);
    assert.match(String(form.body), /Thanks/);
    assert.ok(await db('email_leads').where({ email: 'robin@example.test' }).first());
  });

  it('refuses an opt-in without consent, and ignores the bots', async () => {
    const refused = await call(h.server(), 'POST', '/public/opt-in', {
      body: { branch_id: h.world().branches.halifax, first_name: 'Sam', email: 'sam@example.test' },
    });
    assert.equal(refused.status, 400);

    const bot = await call(h.server(), 'POST', '/public/opt-in', {
      body: {
        branch_id: h.world().branches.halifax,
        first_name: 'Bot',
        email: 'bot@example.test',
        consent: true,
        website: 'http://spam.example',
      },
    });
    assert.equal(bot.status, 201, 'a bot is told it worked');
    assert.equal(await db('email_leads').where({ email: 'bot@example.test' }).first(), undefined);

    const noBranch = await call(h.server(), 'POST', '/public/opt-in', {
      body: { first_name: 'Sam', email: 'sam@example.test', consent: true },
    });
    assert.equal(noBranch.status, 400, 'with two branches the page must say which');
  });

  it('enrols a door-to-door lead from the leads map when they opt in', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const reply = await call(h.server(), 'POST', '/leads/pins', {
      token,
      body: {
        latitude: 44.2312,
        longitude: -76.4861,
        address_line1: '14 Earl St',
        status: 'lead',
        lead: {
          first_name: 'Pat',
          last_name: 'Doyle',
          email: 'pat@example.test',
          phone: null,
          email_opt_in: true,
        },
      },
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));

    const lead = await db('email_leads').where({ email: 'pat@example.test' }).first();
    assert.ok(lead, 'the rep ticking the box enrols them');
    assert.equal(lead.source, 'door_to_door');
    assert.equal(lead.lead_pin_id, reply.body.data.id);
    assert.match(lead.consent_text, /14 Earl St/);
    assert.deepEqual(await queued(lead.id), ['drip_welcome']);
  });

  it('lists leads, with counts, for corporate only', async () => {
    const { token } = await enrol();

    const list = await call(h.server(), 'GET', '/cold-email/leads', { token });
    assert.equal(list.status, 200);
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].next_step, 'How the service works');

    const stats = await call(h.server(), 'GET', '/cold-email/stats', { token });
    assert.equal(stats.body.data.active, 1);
    assert.equal(stats.body.data.door_to_door, 1);

    const sales = await login(h.server(), h.world().emails.sales);
    assert.equal((await call(h.server(), 'GET', '/cold-email/leads', { token: sales })).status, 403);
  });

  it('lets the office stop a sequence by hand', async () => {
    const { token, reply } = await enrol();
    const id = reply.body.data.lead.id;

    const stopped = await call(h.server(), 'POST', `/cold-email/leads/${id}/stop`, {
      token,
      body: { status: 'converted' },
    });
    assert.equal(stopped.status, 200);
    assert.equal(stopped.body.data.status, 'converted');

    const detail = await call(h.server(), 'GET', `/cold-email/leads/${id}`, { token });
    assert.equal(detail.body.data.messages.length, 1);
  });
});
