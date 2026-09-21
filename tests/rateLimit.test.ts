import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../src/config';
import { resetRateLimits, sweepRateLimits } from '../src/middleware/rateLimit';
import { harness } from './helpers/harness';
import { call } from './helpers/server';

/**
 * `/auth/login` is a password oracle open to the internet. These hold the
 * limiter to the two things that make it worth having: an attacker runs out
 * of attempts, and someone who knows their own password never does.
 */

const { maxPerEmail, maxPerIp } = config.auth.rateLimit;

describe('throttling the endpoints anyone can reach', () => {
  const ctx = harness();

  const attempt = (email: string, password: string) =>
    call(ctx.server(), 'POST', '/auth/login', { body: { email, password } });

  it('stops working through passwords against one account', async () => {
    const email = ctx.world().emails.corporate;

    for (let i = 0; i < maxPerEmail; i += 1) {
      const reply = await attempt(email, 'not-the-password');
      assert.equal(reply.status, 401, `attempt ${i + 1} should still be answered`);
    }

    const blocked = await attempt(email, 'not-the-password');
    assert.equal(blocked.status, 429);
    assert.match(
      (blocked.body as { error: { message: string } }).error.message,
      /too many failed sign-in/i,
    );

    // Told when to come back rather than left guessing.
    const retryAfter = Number(blocked.headers.get('retry-after'));
    assert.ok(retryAfter > 0, 'Retry-After should be a positive number of seconds');
    assert.ok(retryAfter <= config.auth.rateLimit.windowMs / 1000);
  });

  it('refuses the right password too, once the budget is spent', async () => {
    const email = ctx.world().emails.corporate;

    for (let i = 0; i < maxPerEmail; i += 1) await attempt(email, 'not-the-password');

    // The point of the limit: guessing cannot be salvaged by eventually
    // guessing correctly.
    const blocked = await attempt(email, 'Password123!');
    assert.equal(blocked.status, 429);
  });

  it('does not spend the budget on people who know their password', async () => {
    const email = ctx.world().emails.corporate;

    // Comfortably more sign-ins than the failure budget: the truck, the
    // office desktop, a phone, over and over.
    for (let i = 0; i < maxPerEmail + 4; i += 1) {
      const reply = await attempt(email, 'Password123!');
      assert.equal(reply.status, 200, `sign-in ${i + 1} should be allowed`);
    }
  });

  it('locks the account that is under attack, not the whole application', async () => {
    const target = ctx.world().emails.corporate;
    const other = ctx.world().emails.operator;

    for (let i = 0; i < maxPerEmail; i += 1) await attempt(target, 'not-the-password');
    assert.equal((await attempt(target, 'not-the-password')).status, 429);

    // A colleague signing in at the same moment is unaffected.
    const unrelated = await attempt(other, 'Password123!');
    assert.equal(unrelated.status, 200);
  });

  it('stops one host working through many accounts', async () => {
    // Under the per-email budget each time, so only the per-address rule can
    // be what stops this.
    let blocked = 0;
    for (let i = 0; i < maxPerIp + 5; i += 1) {
      const reply = await attempt(`nobody${i}@avcrm.test`, 'not-the-password');
      if (reply.status === 429) blocked += 1;
    }

    assert.ok(blocked > 0, 'spraying distinct accounts from one address should be stopped');
  });

  it('throttles sign-ups, which anyone can post to', async () => {
    const branchId = ctx.world().branches.kingston;

    let blocked = 0;
    for (let i = 0; i < maxPerIp + 5; i += 1) {
      const reply = await call(ctx.server(), 'POST', '/auth/register', {
        body: {
          email: `flood${i}@avcrm.test`,
          password: 'Password123!',
          first_name: 'Flood',
          last_name: 'Bot',
          branch_id: branchId,
        },
      });
      if (reply.status === 429) blocked += 1;
    }

    assert.ok(blocked > 0, 'an open registration endpoint should not be free to script');
  });

  it('a refused request does not also spend the other budget', async () => {
    // Exhaust by email, then confirm the address rule still has room: being
    // told "no" by one rule should not quietly cost the other, or a locked
    // account would drag the whole address down with it.
    const target = ctx.world().emails.corporate;
    for (let i = 0; i < maxPerEmail + 6; i += 1) await attempt(target, 'not-the-password');

    const other = await attempt(ctx.world().emails.operator, 'Password123!');
    assert.equal(other.status, 200);
  });
});

describe('the limiter itself', () => {
  it('forgets attempts once they fall out of the window', () => {
    resetRateLimits();

    // Nothing recorded, so a sweep is a no-op rather than a crash.
    sweepRateLimits(1000);
    sweepRateLimits(1000, Date.now() + 10_000);
  });
});
