/*
 * Mail through SendGrid's web API, against a stand-in for it.
 *
 * The environment is set before the configuration is imported, so the driver
 * under test is the one a real deploy with only SENDGRID_API_KEY gets.
 */
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, it } from 'node:test';

interface Received {
  authorization: string | undefined;
  body: {
    personalizations: { to: { email: string; name?: string }[] }[];
    from: { email: string; name?: string };
    reply_to?: { email: string };
    subject: string;
    content: { type: string; value: string }[];
    attachments: { filename: string; disposition: string; content_id?: string; content: string }[];
    headers?: Record<string, string>;
  };
}

const received: Received[] = [];
const readBody = (req: IncomingMessage): Promise<string> =>
  new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => resolve(data));
  });

const stand_in = createServer((req, res) => {
  void readBody(req).then((raw) => {
    const body = JSON.parse(raw) as Received['body'];
    received.push({ authorization: req.headers.authorization, body });
    const to = body.personalizations[0]?.to[0]?.email;
    if (to === 'bad@example.test') {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end('{"errors":[{"message":"Does not contain a valid address."}]}');
      return;
    }
    if (to === 'unverified@example.test') {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      res.end('{"errors":[{"message":"The from address does not match a verified Sender Identity."}]}');
      return;
    }
    res.writeHead(202, { 'X-Message-Id': 'sg-message-1' });
    res.end();
  });
});
await new Promise<void>((resolve) => stand_in.listen(0, '127.0.0.1', resolve));

delete process.env.MAIL_DRIVER;
process.env.SENDGRID_API_KEY = 'SG.test-key';
process.env.SENDGRID_API_BASE = `http://127.0.0.1:${(stand_in.address() as AddressInfo).port}`;
process.env.MAIL_FROM = 'Drift Property Services <info@drift-ps.com>';
process.env.MAIL_REPLY_TO = 'office@drift-ps.com';

const { config } = await import('../src/config');
const { db, resetDatabase } = await import('./helpers/database');
const { buildWorld } = await import('./helpers/fixtures');
const { sendQueued } = await import('../src/services/messages');

describe('mail through the SendGrid web API', () => {
  let branchId: string;

  before(async () => {
    await resetDatabase();
  });

  after(async () => {
    await new Promise<void>((resolve) => stand_in.close(() => resolve()));
  });

  beforeEach(async () => {
    await resetDatabase();
    received.length = 0;
    branchId = (await buildWorld()).branches.kingston;
  });

  async function queue(overrides: Record<string, unknown> = {}): Promise<string> {
    const [row] = await db('message_log')
      .insert({
        template_code: 'invoice_sent',
        channel: 'email',
        recipient: 'harold@example.test',
        subject: 'Your invoice',
        body: 'Hi Harold,\n\nAmount due: $109.00\nDue date: Jan 15, 2027',
        branch_id: branchId,
        status: 'queued',
        ...overrides,
      })
      .returning('id');
    return row?.id ?? '';
  }

  it('is the driver a deploy with only SENDGRID_API_KEY gets', () => {
    assert.equal(config.mail.driver, 'sendgrid');
  });

  it('sends the text, the branded HTML and the inline logo, signed for the branch', async () => {
    const id = await queue();
    const summary = await sendQueued(10);

    assert.equal(summary.sent, 1);
    const [mail] = received;
    assert.equal(mail?.authorization, 'Bearer SG.test-key');
    assert.deepEqual(mail?.body.personalizations[0]?.to, [{ email: 'harold@example.test' }]);
    assert.equal(mail?.body.from.email, 'info@drift-ps.com');
    assert.match(mail?.body.from.name ?? '', /Kingston/);
    assert.equal(mail?.body.subject, 'Your invoice');
    assert.deepEqual(
      mail?.body.content.map((c) => c.type),
      ['text/plain', 'text/html'],
    );
    assert.match(mail?.body.content[1]?.value ?? '', /cid:drift-logo@avcrm/);
    const logo = mail?.body.attachments.find((a) => a.content_id === 'drift-logo@avcrm');
    assert.equal(logo?.disposition, 'inline');
    assert.ok((logo?.content.length ?? 0) > 1000, 'the logo itself, base64');
    assert.equal(mail?.body.headers?.['X-Avcrm-Message-Id'], id);

    const row = await db('message_log').where({ id }).first();
    assert.equal(row?.status, 'sent');
    assert.equal(row?.provider_message_id, 'sg-message-1');
  });

  it('gives up on an address SendGrid will never take', async () => {
    const id = await queue({ recipient: 'bad@example.test' });
    const summary = await sendQueued(10);

    assert.equal(summary.rejected, 1);
    const row = await db('message_log').where({ id }).first();
    assert.equal(row?.status, 'failed');
    assert.match(row?.error ?? '', /400.*valid address/);
  });

  it('keeps retrying while the account is the problem, and says why', async () => {
    const id = await queue({ recipient: 'unverified@example.test' });
    const summary = await sendQueued(10);

    assert.equal(summary.retrying, 1);
    const row = await db('message_log').where({ id }).first();
    assert.equal(row?.status, 'queued');
    assert.match(row?.error ?? '', /403.*verified Sender Identity/);
  });
});
