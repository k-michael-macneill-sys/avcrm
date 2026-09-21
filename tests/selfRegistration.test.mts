import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// Configuration is read once at import, so the switch has to be flipped before
// the application is loaded — which is what .mts and top-level await are for
// here, the same as the payments, sms and mail suites.
process.env.ALLOW_SELF_REGISTRATION = 'true';

const { db } = await import('./helpers/database.js');
const { harness } = await import('./helpers/harness.js');
const { call } = await import('./helpers/server.js');
const { PASSWORD } = await import('./helpers/fixtures.js');

/**
 * What self-signup does when a branch deliberately turns it on.
 *
 * Off by default, but the rule it enforces is the important half: an open
 * form must not be able to grant itself anything. Worth holding to even
 * though most installs will never open it.
 */
describe('self-signup, when it is switched on', () => {
  const h = harness();

  it('creates a pending operator whatever the request asks for', async () => {
    const reply = await call(h.server(), 'POST', '/auth/register', {
      body: {
        email: 'walkin@test.local',
        password: PASSWORD,
        first_name: 'Wal',
        last_name: 'Kin',
        branch_id: h.world().branches.kingston,
        // The two things a self-service form must never grant itself.
        role: 'corporate',
        onboarding_status: 'approved',
      },
    });

    assert.equal(reply.status, 201);
    const created = await db('users').where({ email: 'walkin@test.local' }).first();
    assert.equal(created?.role, 'operator');
    assert.equal(created?.onboarding_status, 'pending');
  });
});
