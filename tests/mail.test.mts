/*
 * Outbound mail, against a real SMTP server.
 *
 * The environment is set before the configuration is imported, so the driver
 * under test is the SMTP one, pointed at a sink this file owns.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import { startMailSink } from './helpers/mailSink';

const sink = await startMailSink();

process.env.MAIL_DRIVER = 'smtp';
process.env.MAIL_FROM = 'Drift <billing@drift.test>';
process.env.MAIL_REPLY_TO = 'office@drift.test';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.SMTP_SECURE = 'false';

const { db, resetDatabase } = await import('./helpers/database');
const { buildWorld } = await import('./helpers/fixtures');
const { sendQueued } = await import('../src/services/messages');
const { closeTransport, senderFor } = await import('../src/services/notifications');

describe('delivering mail', () => {
  let branchId: string;

  before(async () => {
    await resetDatabase();
  });

  after(async () => {
    await closeTransport();
    await sink.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    sink.clear();
    branchId = (await buildWorld()).branches.kingston;
  });

  async function queue(overrides: Record<string, unknown> = {}): Promise<string> {
    const [row] = await db('message_log')
      .insert({
        template_code: 'invoice_sent',
        channel: 'email',
        recipient: 'harold@example.test',
        subject: 'Your invoice',
        body: 'The January bill is attached.',
        branch_id: branchId,
        status: 'queued',
        ...overrides,
      })
      .returning('id');
    return row?.id ?? '';
  }

  it('really delivers, with the addresses configured', async () => {
    const id = await queue();
    const summary = await sendQueued(10);

    assert.equal(summary.sent, 1);
    const mail = sink.received();
    assert.equal(mail.length, 1);
    assert.equal(mail[0]?.envelope_to[0], 'harold@example.test');
    assert.match(mail[0]?.from ?? '', /billing@drift\.test/);
    assert.equal(mail[0]?.reply_to, 'office@drift.test');
    assert.equal(mail[0]?.subject, 'Your invoice');
    assert.match(mail[0]?.body ?? '', /January bill/);
    // The header that ties the provider's copy back to our row.
    assert.equal(mail[0]?.correlation, id);

    const row = await db('message_log').where({ id }).first();
    assert.equal(row?.status, 'sent');
    assert.ok(row?.provider_message_id);
  });

  it('signs a branch’s email with its name and sends the replies to the branch', async () => {
    await db('branches').where({ id: branchId }).update({ contact_email: 'kingston@drift.test' });
    await queue();
    await queue({ branch_id: null, recipient: 'office-copy@example.test' });
    await sendQueued(10);

    const mail = sink.received();
    const branch = mail.find((m) => m.envelope_to[0] === 'harold@example.test');
    // Encoded on the wire for its dash: "Drift – Kingston".
    assert.match(branch?.from ?? '', /Drift_=E2=80=93_Kingston/);
    assert.match(branch?.from ?? '', /billing@drift\.test/, 'still the verified address');
    assert.equal(branch?.reply_to, 'kingston@drift.test');

    // Nothing to do with a branch: the company's own name and reply-to.
    const company = mail.find((m) => m.envelope_to[0] === 'office-copy@example.test');
    assert.doesNotMatch(company?.from ?? '', /Kingston/);
    assert.equal(company?.reply_to, 'office@drift.test');
  });

  it('gives up on a mailbox that is gone', async () => {
    const id = await queue({ recipient: 'gone@example.test' });
    const summary = await sendQueued(10);

    assert.equal(summary.rejected, 1);
    assert.equal(summary.sent, 0);

    const row = await db('message_log').where({ id }).first();
    // A 550 means the address is wrong and will stay wrong; three more tries
    // waste the budget and look like spam to the server refusing them.
    assert.equal(row?.status, 'failed');
    assert.equal(row?.attempts, 1);
    assert.match(row?.error ?? '', /550|mailbox/i);
  });

  it('names a bare MAIL_FROM for the company, and falls back to it for replies', () => {
    const mail = { from: 'info@drift-ps.com', replyTo: null };
    assert.deepEqual(senderFor({ name: 'Regina', contact_email: 'Carter.o@drift-ps.com' }, mail), {
      from: '"Drift Property Services – Regina" <info@drift-ps.com>',
      replyTo: 'Carter.o@drift-ps.com',
    });
    assert.deepEqual(senderFor({ name: 'Alberta', contact_email: null }, mail), {
      from: '"Drift Property Services – Alberta" <info@drift-ps.com>',
      replyTo: null,
    });
    assert.deepEqual(senderFor(null, mail), { from: 'info@drift-ps.com', replyTo: null });
  });
});
