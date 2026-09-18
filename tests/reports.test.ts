import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeContract, makeWorkOrder } from './helpers/fixtures';
import { call, login } from './helpers/server';

describe('the roll-up reports', () => {
  const h = harness();

  /** A branch with one signed contract, one paid bill and two visits. */
  async function trading() {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const token = await login(h.server(), world.emails.corporate);

    const invoice = await call(h.server(), 'POST', '/invoices', {
      token,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-01-01',
        billing_period_end: '2027-01-31',
        amount_due: 300,
        due_date: '2027-01-15',
      },
    });
    await call(h.server(), 'POST', `/invoices/${invoice.body.data.id}/send`, { token });
    await call(h.server(), 'POST', `/invoices/${invoice.body.data.id}/payments`, {
      token,
      body: { amount: 120, method: 'cheque', status: 'succeeded' },
    });

    await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
      status: 'completed',
      completed_at: new Date(),
    });
    await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
      status: 'scheduled',
    });

    return { token, contract, invoiceId: invoice.body.data.id as string };
  }

  it('counts each branch once, with money as a string', async () => {
    const { token } = await trading();
    const reply = await call(h.server(), 'GET', '/reports/branch-summary', { token });

    assert.equal(reply.status, 200);
    const kingston = reply.body.data.find((r: { branch_name: string }) => r.branch_name === 'Kingston');
    assert.ok(kingston, 'every branch has a row, trading or not');
    // Money is a string the whole way through, never a float.
    assert.equal(typeof kingston.revenue.collected, 'string');
    assert.equal(kingston.revenue.collected, '120.00');
    assert.equal(kingston.revenue.invoiced, '300.00');
    assert.equal(kingston.revenue.outstanding, '180.00');
    assert.equal(kingston.contracts.active, 1);
  });

  it('buckets revenue by the month it was billed for', async () => {
    const { token } = await trading();
    const reply = await call(h.server(), 'GET', '/reports/revenue', { token });

    assert.equal(reply.status, 200);
    const january = reply.body.data.find((r: { month: string }) => r.month.startsWith('2027-01'));
    assert.ok(january, 'the period it covers, not the day the money arrived');
    assert.equal(january.invoiced, '300.00');
    assert.equal(january.collected, '120.00');
  });

  it('scores operators on what they actually did', async () => {
    const { token } = await trading();
    const reply = await call(h.server(), 'GET', '/reports/operators', { token });

    assert.equal(reply.status, 200);
    const otto = reply.body.data.find((r: { name: string }) => r.name.startsWith('Otto'));
    assert.ok(otto);
    assert.equal(otto.completed, 1);
    assert.equal(otto.skipped, 0);
    // Nobody has rated the visit, so there is no average to invent.
    assert.equal(otto.average_rating, null);
  });

  it('is corporate work, and an operator is told where their own is', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.operator);

    for (const path of ['/reports/branch-summary', '/reports/revenue', '/reports/operators']) {
      const reply = await call(h.server(), 'GET', path, { token });
      assert.equal(reply.status, 403, path);
    }
  });

  it('narrows to one branch when asked', async () => {
    const { token } = await trading();
    const world = h.world();

    const reply = await call(
      h.server(),
      'GET',
      `/reports/branch-summary?branch_id=${world.branches.halifax}`,
      { token },
    );

    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.length, 1);
    assert.equal(reply.body.data[0].branch_name, 'Halifax');
  });

  it('leaves a voided invoice out of the money', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const token = await login(h.server(), world.emails.corporate);

    const invoice = await call(h.server(), 'POST', '/invoices', {
      token,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-02-01',
        billing_period_end: '2027-02-28',
        amount_due: 500,
        due_date: '2027-02-15',
      },
    });
    await call(h.server(), 'POST', `/invoices/${invoice.body.data.id}/void`, { token });

    const reply = await call(h.server(), 'GET', '/reports/revenue', { token });
    const february = reply.body.data.find((r: { month: string }) => r.month.startsWith('2027-02'));
    // A bill nobody owes is not revenue, invoiced or otherwise.
    assert.ok(!february || february.invoiced === '0.00', JSON.stringify(february));

    assert.equal((await db('invoices').where({ status: 'void' })).length, 1);
  });
});
