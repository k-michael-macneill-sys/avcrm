import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { checkReadiness } from '../src/services/health';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { call } from './helpers/server';

/**
 * The readiness endpoint earns its place only if it can go red. The failure
 * it exists for is a scheduler that has quietly stopped: every screen still
 * works, every request still returns 200, and nothing reaches a customer.
 */

const HOURS = 60 * 60 * 1000;

async function queueMessage(createdAt: Date): Promise<void> {
  await db('message_log').insert({
    template_code: 'service_complete',
    channel: 'email',
    recipient: 'harold@example.test',
    subject: 'Your driveway is clear',
    body: 'All done.',
    status: 'queued',
    attempts: 0,
    created_at: createdAt,
    updated_at: createdAt,
  });
}

describe('telling a monitor whether the system is working', () => {
  const ctx = harness();

  it('is ready when the database, the queue and storage are all fine', async () => {
    const reply = await call(ctx.server(), 'GET', '/ready');

    assert.equal(reply.status, 200);
    const body = reply.body as { status: string; checks: Record<string, { status: string }> };
    assert.equal(body.status, 'ready');
    assert.equal(body.checks.database?.status, 'ok');
    assert.equal(body.checks.queue?.status, 'ok');
    assert.equal(body.checks.storage?.status, 'ok');
  });

  it('answers without a session, because a monitor has no account', async () => {
    // Deliberately no token.
    const reply = await call(ctx.server(), 'GET', '/ready');
    assert.equal(reply.status, 200);
    assert.equal(reply.headers.get('cache-control'), 'no-store');
  });

  it('stays ready while the queue is merely busy', async () => {
    // A backlog that is draining is not a fault: plenty waiting, all recent.
    for (let i = 0; i < 25; i += 1) await queueMessage(new Date());

    const readiness = await checkReadiness(db);
    assert.equal(readiness.checks.queue.status, 'ok');
    assert.equal(readiness.status, 'ready');
  });

  it('goes degraded when the oldest message has been waiting too long', async () => {
    // One message, stuck since two hours ago: the worker is not running.
    await queueMessage(new Date(Date.now() - 2 * HOURS));

    const readiness = await checkReadiness(db);
    assert.equal(readiness.checks.queue.status, 'failed');
    assert.match(readiness.checks.queue.detail ?? '', /scheduler is probably not running/);
    assert.equal(readiness.status, 'degraded');

    // And the endpoint says so with a status an uptime monitor alerts on,
    // rather than a 200 with bad news in the body that nothing would read.
    const reply = await call(ctx.server(), 'GET', '/ready');
    assert.equal(reply.status, 503);
  });

  it('ignores messages that already went out', async () => {
    // Sent long ago, so it must not be mistaken for a backlog.
    await db('message_log').insert({
      template_code: 'service_complete',
      channel: 'email',
      recipient: 'harold@example.test',
      subject: 'Your driveway is clear',
      body: 'All done.',
      status: 'sent',
      attempts: 1,
      sent_at: new Date(Date.now() - 48 * HOURS),
      created_at: new Date(Date.now() - 48 * HOURS),
      updated_at: new Date(Date.now() - 48 * HOURS),
    });

    const readiness = await checkReadiness(db);
    assert.equal(readiness.checks.queue.status, 'ok');
  });

  it('reports a database it cannot reach without leaking how it connects', async () => {
    // A connection error can carry a host and port, and this endpoint has no
    // session in front of it.
    const broken = {
      raw: () => Promise.reject(new Error('connect ECONNREFUSED 10.0.0.5:5432')),
    } as never;

    const readiness = await checkReadiness(broken);
    assert.equal(readiness.status, 'degraded');
    assert.equal(readiness.checks.database.status, 'failed');
    assert.equal(readiness.checks.database.detail, 'unreachable');
    assert.doesNotMatch(JSON.stringify(readiness), /10\.0\.0\.5|5432/);
  });

  it('liveness stays up even when readiness is red', async () => {
    await queueMessage(new Date(Date.now() - 2 * HOURS));

    // Different questions: the container should not be restarted because a
    // separate process stopped draining the queue.
    const live = await call(ctx.server(), 'GET', '/health');
    assert.equal(live.status, 200);

    const ready = await call(ctx.server(), 'GET', '/ready');
    assert.equal(ready.status, 503);
  });
});
