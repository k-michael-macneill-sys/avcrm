import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { call, login } from './helpers/server';

describe('adding a branch', () => {
  const h = harness();
  const branch = { name: 'Truro', province: 'NS', timezone: 'America/Halifax' };

  it('takes the owner password', async () => {
    const token = await login(h.server(), h.world().emails.corporate);

    const reply = await call(h.server(), 'POST', '/branches', {
      token,
      body: { ...branch, owner_password: 'test-owner-password' },
    });

    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.data.name, 'Truro');
    // Checked, never kept.
    assert.equal(reply.body.data.owner_password, undefined);
  });

  it('refuses a wrong or missing password, even from corporate', async () => {
    const token = await login(h.server(), h.world().emails.kingstonManager);

    const wrong = await call(h.server(), 'POST', '/branches', {
      token,
      body: { ...branch, owner_password: 'guess' },
    });
    assert.equal(wrong.status, 403);

    const missing = await call(h.server(), 'POST', '/branches', { token, body: branch });
    assert.equal(missing.status, 400);

    assert.equal(await db('branches').where({ name: 'Truro' }).first(), undefined);
  });

  it('refuses field staff even with the password', async () => {
    const token = await login(h.server(), h.world().emails.sales);

    const reply = await call(h.server(), 'POST', '/branches', {
      token,
      body: { ...branch, owner_password: 'test-owner-password' },
    });
    assert.equal(reply.status, 403);
  });
});
