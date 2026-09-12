/*
 * The staging safety valve, which needs the application configured with it —
 * so it gets its own file and its own process.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { startMailSink } from './helpers/mailSink';

const sink = await startMailSink();

process.env.MAIL_DRIVER = 'smtp';
process.env.MAIL_FROM = 'Avalanche <billing@avalanche.test>';
process.env.SMTP_HOST = '127.0.0.1';
process.env.SMTP_PORT = String(sink.port);
process.env.MAIL_REDIRECT_TO = 'staging@avalanche.test';

const { db, resetDatabase } = await import('./helpers/database');
const { buildWorld } = await import('./helpers/fixtures');
const { sendQueued } = await import('../src/services/messages');
const { closeTransport } = await import('../src/services/notifications');

describe('MAIL_REDIRECT_TO', () => {
  before(async () => {
    await resetDatabase();
    const world = await buildWorld();
    await db('message_log').insert({
      template_code: 'invoice_sent',
      channel: 'email',
      recipient: 'priya.raman@example.test',
      subject: 'Your invoice',
      body: 'The January bill is attached.',
      branch_id: world.branches.kingston,
      status: 'queued',
    });
  });

  after(async () => {
    await closeTransport();
    await sink.close();
  });

  it('sends to the redirect instead of the customer, keeping who it was for', async () => {
    await sendQueued(10);

    const mail = sink.received();
    assert.equal(mail.length, 1);
    // A staging database is a copy of production, real addresses and all.
    // Without this, the first queue drain after a restore emails them.
    assert.equal(mail[0]?.envelope_to[0], 'staging@avalanche.test');
    // The real recipient has to survive the redirect or the copy is useless.
    assert.match(mail[0]?.subject ?? '', /\[to: priya\.raman@example\.test\] Your invoice/);
  });
});
