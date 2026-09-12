import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeContract, makeWorkOrder } from './helpers/fixtures';
import { call, eventually, login } from './helpers/server';

describe('dispatch and the completion gate', () => {
  const h = harness();

  const photo = (type: 'before' | 'after', overrides: Record<string, unknown> = {}) => ({
    photo_type: type,
    file_url: `service-photos/2026/01/${type}.jpg`,
    taken_at: new Date(Date.now() - 60_000).toISOString(),
    latitude: 44.2305,
    longitude: -76.4944,
    ...overrides,
  });

  it('refuses to dispatch an operator who is not through onboarding', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const token = await login(h.server(), world.emails.corporate);

    const reply = await call(h.server(), 'POST', '/work-orders', {
      token,
      body: {
        contract_id: contract.contract_id,
        assigned_user_id: world.users.pending,
        scheduled_for: new Date().toISOString(),
        service_type: 'snow_clearing',
      },
    });

    // 403 rather than 400: dispatching to them is not a malformed request,
    // it is one the rules do not allow.
    assert.equal(reply.status, 403);
    assert.match(reply.body.error.message.toLowerCase(), /onboard|approved|assign/);
  });

  it('refuses an operator from another branch', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const token = await login(h.server(), world.emails.corporate);

    const reply = await call(h.server(), 'POST', '/work-orders', {
      token,
      body: {
        contract_id: contract.contract_id,
        assigned_user_id: world.users.halifaxOperator,
        scheduled_for: new Date().toISOString(),
        service_type: 'snow_clearing',
      },
    });

    // 400 here where the onboarding refusal above is a 403. Both are refusals
    // and both name the reason; the inconsistency is the API's, recorded
    // rather than papered over.
    assert.equal(reply.status, 400);
    assert.match(reply.body.error.message.toLowerCase(), /branch/);
  });

  it('will not complete a visit without a before and an after photo', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const id = await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
      status: 'in_progress',
      started_at: new Date(),
    });

    const token = await login(h.server(), world.emails.operator);

    const bare = await call(h.server(), 'PATCH', `/work-orders/${id}/status`, {
      token,
      body: { status: 'completed' },
    });
    assert.equal(bare.status, 400);
    assert.match(bare.body.error.message.toLowerCase(), /photo/);

    await call(h.server(), 'POST', `/work-orders/${id}/photos`, { token, body: photo('before') });

    const halfway = await call(h.server(), 'PATCH', `/work-orders/${id}/status`, {
      token,
      body: { status: 'completed' },
    });
    assert.equal(halfway.status, 400, 'a before photo alone is not proof the work was done');

    await call(h.server(), 'POST', `/work-orders/${id}/photos`, { token, body: photo('after') });

    const done = await call(h.server(), 'PATCH', `/work-orders/${id}/status`, {
      token,
      body: { status: 'completed' },
    });
    assert.equal(done.status, 200);
    assert.equal(done.body.data.status, 'completed');
    assert.ok(done.body.data.completed_at);
  });

  it('refuses a photo taken somewhere other than the property', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const id = await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
      status: 'in_progress',
      started_at: new Date(),
    });

    const token = await login(h.server(), world.emails.operator);
    const reply = await call(h.server(), 'POST', `/work-orders/${id}/photos`, {
      token,
      // Ottawa, about 170km from the driveway in question.
      body: photo('before', { latitude: 45.4215, longitude: -75.6972 }),
    });

    assert.equal(reply.status, 400);
    assert.match(reply.body.error.message.toLowerCase(), /propert|away|km|metre/);
  });

  it('lets only the assigned operator move their own visit', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const id = await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
    });

    const otherBranch = await login(h.server(), world.emails.halifaxOperator);
    const reply = await call(h.server(), 'PATCH', `/work-orders/${id}/status`, {
      token: otherBranch,
      body: { status: 'in_progress' },
    });

    assert.ok(reply.status === 403 || reply.status === 404, `got ${reply.status}`);
  });

  it('takes a skip with a reason, and refuses one without', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const id = await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
    });
    const token = await login(h.server(), world.emails.operator);

    const bare = await call(h.server(), 'PATCH', `/work-orders/${id}/status`, {
      token,
      body: { status: 'skipped' },
    });
    assert.equal(bare.status, 400);

    const withReason = await call(h.server(), 'PATCH', `/work-orders/${id}/status`, {
      token,
      body: { status: 'skipped', skip_reason: 'Cars in the driveway, nobody home.' },
    });
    assert.equal(withReason.status, 200);
    assert.equal(withReason.body.data.skip_reason, 'Cars in the driveway, nobody home.');
  });

  it('tells the customer and the office when a visit is done', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const id = await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
      status: 'in_progress',
      started_at: new Date(),
    });

    const token = await login(h.server(), world.emails.operator);
    const b = await call(h.server(), 'POST', `/work-orders/${id}/photos`, { token, body: photo('before') });
    const a = await call(h.server(), 'POST', `/work-orders/${id}/photos`, { token, body: photo('after') });
    const done = await call(h.server(), 'PATCH', `/work-orders/${id}/status`, {
      token,
      body: { status: 'completed' },
    });
    assert.equal(b.status, 201, JSON.stringify(b.body));
    assert.equal(a.status, 201, JSON.stringify(a.body));
    assert.equal(done.status, 200, JSON.stringify(done.body));

    // Queued after the response, on purpose — so wait for it rather than
    // assume the work is finished when the operator's phone says it is.
    const queued = await eventually('the completion notices to be queued', async () => {
      const rows = await db('message_log').whereIn('template_code', [
        'service_complete',
        'service_complete_internal',
      ]);
      return rows.length === 2 ? rows : null;
    });

    assert.ok(queued.every((row) => row.status === 'queued'));
    // One to the customer, one to the branch manager — not the same text sent
    // twice.
    assert.deepEqual(
      queued.map((row) => row.recipient).sort(),
      ['harold@example.test', 'kingston.manager@test.local'],
    );
  });
});
