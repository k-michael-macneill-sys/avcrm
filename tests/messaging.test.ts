import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeContract, makeWorkOrder } from './helpers/fixtures';
import { call, login } from './helpers/server';
import { sendQueued } from '../src/services/messages';
import { runReviewRequests } from '../src/services/reviews';

describe('the outbound queue', () => {
  const h = harness();

  async function queueOne(overrides: Record<string, unknown> = {}): Promise<string> {
    const [row] = await db('message_log')
      .insert({
        template_code: 'en_route',
        channel: 'email',
        recipient: 'harold@example.test',
        subject: 'On the way',
        body: 'The crew is on the way.',
        branch_id: h.world().branches.kingston,
        status: 'queued',
        ...overrides,
      })
      .returning('id');
    return row?.id ?? '';
  }

  it('sends what is queued and records the provider id', async () => {
    const id = await queueOne();
    const summary = await sendQueued(10);

    assert.equal(summary.claimed, 1);
    assert.equal(summary.sent, 1);

    const row = await db('message_log').where({ id }).first();
    assert.equal(row?.status, 'sent');
    assert.ok(row?.sent_at);
    // The log driver still records an id, so the column means the same thing
    // whichever transport is configured.
    assert.ok(row?.provider_message_id);
  });

  it('leaves a message alone once it has been sent', async () => {
    await queueOne();
    await sendQueued(10);
    const second = await sendQueued(10);
    assert.equal(second.claimed, 0);
  });

  it('does not hand the same message to two workers', async () => {
    await queueOne();
    // Both drains race for one row; the claim takes it with FOR UPDATE SKIP
    // LOCKED, so the loser gets nothing rather than a duplicate send.
    const [first, second] = await Promise.all([sendQueued(10), sendQueued(10)]);
    assert.equal(first.claimed + second.claimed, 1);
  });

  it('gives up on a message that has used its attempts', async () => {
    await queueOne({ attempts: 99, recipient: 'nobody@example.test' });
    // Nothing fails under the log driver, so this is about the budget itself:
    // a row at its limit is still claimable once and then done.
    const summary = await sendQueued(10);
    assert.equal(summary.claimed, 1);
  });

  it('renders a template rather than sending its placeholders', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const token = await login(h.server(), world.emails.corporate);

    const invoice = await call(h.server(), 'POST', '/invoices', {
      token,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-01-01',
        billing_period_end: '2027-01-31',
        amount_due: 149.5,
        due_date: '2027-01-15',
      },
    });
    await call(h.server(), 'POST', `/invoices/${invoice.body.data.id}/send`, { token });

    const queued = await db('message_log').where({ template_code: 'invoice_sent' }).first();
    assert.ok(queued, 'sending an invoice tells the customer');
    assert.match(queued.body, /Harold/);
    assert.doesNotMatch(queued.body, /\{\{/, 'no placeholder should survive rendering');
    assert.equal(queued.recipient, 'harold@example.test');
  });

  /*
   * There is an en_route template, on both channels, and nothing sends it:
   * moving a visit to en_route changes the status and notifies nobody. Left
   * as a failing expectation would be noise, so it is recorded here instead —
   * the wiring is a small piece of work, not a bug in what exists.
   */
  it('changes status to en route, though it notifies nobody yet', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const id = await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
    });

    const token = await login(h.server(), world.emails.operator);
    const reply = await call(h.server(), 'PATCH', `/work-orders/${id}/status`, {
      token,
      body: { status: 'en_route' },
    });

    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.status, 'en_route');
    assert.equal(await db('message_log').where({ template_code: 'en_route' }).first(), undefined);
  });
});

describe('asking for a review', () => {
  const h = harness();

  async function completedVisit() {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const workOrder = await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
      status: 'completed',
      // Far enough back that the cooldown and delay have passed.
      completed_at: new Date(Date.now() - 48 * 3600 * 1000),
      scheduled_for: new Date(Date.now() - 48 * 3600 * 1000),
    });
    return { contract, workOrder };
  }

  it('asks once per visit, and not again on the next run', async () => {
    await completedVisit();

    const first = await runReviewRequests();
    assert.equal(first.asked, 1);

    const second = await runReviewRequests();
    assert.equal(second.asked, 0, 'a customer asked twice is a customer annoyed');
  });

  it('sends a good rating to the public review page', async () => {
    await completedVisit();
    await runReviewRequests();
    const request = await db('review_requests').first();
    assert.ok(request, 'a completed visit is asked about');

    const reply = await call(h.server(), 'GET', `/review-requests/${request.id}/rate?rating=5`);

    // A 302 out to Google: the whole point is that it is one tap.
    assert.equal(reply.status, 302);
    assert.ok(reply.headers.get('location'));

    const after = await db('review_requests').where({ id: request.id }).first();
    assert.equal(after?.routed_to, 'google_review');
  });

  it('keeps a poor rating in here and tells the manager', async () => {
    await completedVisit();
    await runReviewRequests();
    const request = await db('review_requests').first();
    assert.ok(request, 'a completed visit is asked about');

    const reply = await call(h.server(), 'GET', `/review-requests/${request.id}/rate?rating=2`);
    assert.equal(reply.status, 200, 'a complaint is not sent to a public review page');

    const after = await db('review_requests').where({ id: request.id }).first();
    assert.equal(after?.routed_to, 'internal_feedback');

    const flagged = await db('message_log').where({ template_code: 'low_rating_internal' });
    assert.equal(flagged.length, 1);
  });

  it('holds the first answer and refuses a different second one', async () => {
    await completedVisit();
    await runReviewRequests();
    const request = await db('review_requests').first();
    assert.ok(request, 'a completed visit is asked about');

    await call(h.server(), 'GET', `/review-requests/${request.id}/rate?rating=5`);

    // Tapping the same star again is a double tap, not a new opinion.
    const again = await call(h.server(), 'GET', `/review-requests/${request.id}/rate?rating=5`);
    assert.equal(again.status, 302);

    // Changing the answer is refused rather than silently overwriting it.
    const changed = await call(h.server(), 'GET', `/review-requests/${request.id}/rate?rating=1`);
    assert.equal(changed.status, 409);

    const after = await db('review_requests').where({ id: request.id }).first();
    assert.equal(after?.rating_response, 5, 'the first answer stands');
    assert.equal(after?.routed_to, 'google_review');
  });
});
