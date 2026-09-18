import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeCustomer, PASSWORD } from './helpers/fixtures';
import { call, login } from './helpers/server';

describe('signing in and what that entitles you to', () => {
  const h = harness();

  it('rejects a wrong password without saying which half was wrong', async () => {
    const reply = await call(h.server(), 'POST', '/auth/login', {
      body: { email: h.world().emails.corporate, password: 'not-the-password' },
    });
    assert.equal(reply.status, 401);
    assert.doesNotMatch(JSON.stringify(reply.body), /password_hash/);
  });

  it('never returns the password hash', async () => {
    const token = await login(h.server(), h.world().emails.corporate);
    const me = await call(h.server(), 'GET', '/auth/me', { token });
    assert.equal(me.status, 200);
    assert.equal('password_hash' in me.body.data, false);
  });

  it('refuses an unauthenticated request', async () => {
    const reply = await call(h.server(), 'GET', '/customers');
    assert.equal(reply.status, 401);
  });

  it('registers a pending operator whatever the request asks for', async () => {
    const reply = await call(h.server(), 'POST', '/auth/register', {
      body: {
        email: 'walkin@test.local',
        password: PASSWORD,
        first_name: 'Wal',
        last_name: 'Kin',
        branch_id: h.world().branches.kingston,
        // The thing a self-service form must not be able to grant itself.
        role: 'corporate',
        onboarding_status: 'approved',
      },
    });

    assert.equal(reply.status, 201);
    const created = await db('users').where({ email: 'walkin@test.local' }).first();
    assert.equal(created?.role, 'operator');
    assert.equal(created?.onboarding_status, 'pending');
  });

  it('keeps corporate-only endpoints away from operators', async () => {
    const token = await login(h.server(), h.world().emails.operator);
    for (const path of ['/users', '/reports/branch-summary', '/audit-log', '/settings/sms']) {
      const reply = await call(h.server(), 'GET', path, { token });
      assert.equal(reply.status, 403, `${path} should be corporate only`);
    }
  });

  describe('branch scoping', () => {
    it('shows an operator only their own branch', async () => {
      const world = h.world();
      await makeCustomer(world.branches.kingston, world.users.operator, {
        first_name: 'Kingston',
      });
      await makeCustomer(world.branches.halifax, world.users.halifaxOperator, {
        first_name: 'Halifax',
        address_line1: '5560 Cornwallis St',
      });

      const token = await login(h.server(), world.emails.operator);
      const reply = await call(h.server(), 'GET', '/customers', { token });

      assert.equal(reply.status, 200);
      assert.equal(reply.body.data.length, 1);
      assert.equal(reply.body.data[0].first_name, 'Kingston');
    });

    it('lets corporate see every branch', async () => {
      const world = h.world();
      await makeCustomer(world.branches.kingston, world.users.operator);
      await makeCustomer(world.branches.halifax, world.users.halifaxOperator, {
        address_line1: '5560 Cornwallis St',
      });

      const token = await login(h.server(), world.emails.corporate);
      const reply = await call(h.server(), 'GET', '/customers', { token });
      assert.equal(reply.body.data.length, 2);
    });

    it('refuses an operator asking for another branch by id', async () => {
      const world = h.world();
      const token = await login(h.server(), world.emails.operator);
      const reply = await call(
        h.server(),
        'GET',
        `/customers?branch_id=${world.branches.halifax}`,
        { token },
      );
      assert.equal(reply.status, 403);
    });

    it('hides a record from another branch behind a 404, not a 403', async () => {
      const world = h.world();
      const other = await makeCustomer(world.branches.halifax, world.users.halifaxOperator, {
        address_line1: '5560 Cornwallis St',
      });

      const token = await login(h.server(), world.emails.operator);
      const reply = await call(h.server(), 'GET', `/customers/${other.customer_id}`, { token });

      // A 403 would confirm the id exists, which is itself information.
      assert.equal(reply.status, 404);
    });
  });
});
