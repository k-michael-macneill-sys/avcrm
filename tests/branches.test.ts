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

describe('a branch’s contact details', () => {
  const h = harness();

  it('are saved and cleared by corporate, and nobody else', async () => {
    const id = h.world().branches.kingston;
    const token = await login(h.server(), h.world().emails.corporate);

    const saved = await call(h.server(), 'PATCH', `/branches/${id}`, {
      token,
      body: { contact_phone: '(519) 221-6191', contact_email: 'kingston@drift.test' },
    });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.data.contact_phone, '(519) 221-6191');
    assert.equal(saved.body.data.contact_email, 'kingston@drift.test');

    const bad = await call(h.server(), 'PATCH', `/branches/${id}`, { token, body: { contact_email: 'not an email' } });
    assert.equal(bad.status, 400);

    const cleared = await call(h.server(), 'PATCH', `/branches/${id}`, {
      token,
      body: { contact_phone: null, contact_email: null },
    });
    assert.equal(cleared.body.data.contact_email, null);

    const operator = await login(h.server(), h.world().emails.operator);
    const refused = await call(h.server(), 'PATCH', `/branches/${id}`, {
      token: operator,
      body: { contact_email: 'mine@drift.test' },
    });
    assert.equal(refused.status, 403);
    assert.equal((await db('branches').where({ id }).first('contact_email'))?.contact_email, null);
  });
});
