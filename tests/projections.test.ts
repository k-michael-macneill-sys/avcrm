import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  baseProjection,
  contractRevenueByMonth,
  scenarioReport,
  seasonFor,
} from '../src/services/projectionModel';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeContract, makeCustomer } from './helpers/fixtures';
import { call, login } from './helpers/server';

describe('the projection arithmetic', () => {
  it('projects the season under way, or the next one', () => {
    assert.deepEqual(seasonFor('2026-09-30'), { start: '2026-11-01', end: '2027-03-31', label: '2026–27' });
    assert.equal(seasonFor('2026-12-15').start, '2026-11-01');
    assert.equal(seasonFor('2027-03-31').start, '2026-11-01');
    assert.equal(seasonFor('2027-04-01').start, '2027-11-01');
  });

  it('bills a contract month by month the way its invoices will', () => {
    assert.deepEqual(
      contractRevenueByMonth({ billing_type: 'monthly', discounted_price: 99, recurring_price: 129, periods: 5 }),
      [99, 129, 129, 129, 129],
    );
    assert.deepEqual(
      contractRevenueByMonth({ billing_type: 'monthly', discounted_price: 99, recurring_price: null, periods: 7 }),
      [99, 99, 99, 99, 99],
      'never more than five months',
    );
    assert.deepEqual(
      contractRevenueByMonth({ billing_type: 'monthly', discounted_price: 99, recurring_price: 129, periods: 3 }),
      [99, 129, 129, 0, 0],
    );
    assert.deepEqual(
      contractRevenueByMonth({ billing_type: 'seasonal_upfront', discounted_price: 650, recurring_price: null, periods: 5 }),
      [650, 0, 0, 0, 0],
    );
    assert.deepEqual(
      contractRevenueByMonth({ billing_type: 'monthly', discounted_price: 99, recurring_price: 129, periods: 2, first_month: 1 }),
      [0, 99, 129, 0, 0],
      'an exact-dates contract from December bills December and January',
    );
  });

  it('nets the baseline against five months of operator pay', () => {
    const base = baseProjection([1000, 500, 500, 500, 500], 400);
    assert.equal(base.revenue, 3000);
    assert.equal(base.labor, 2000);
    assert.equal(base.net, 1000);
    assert.equal(base.months.length, 5);
    assert.deepEqual(base.months[0], {
      month: 'Nov',
      revenue: 1000,
      labor: 400,
      cumulative_revenue: 1000,
      cumulative_labor: 400,
      cumulative_net: 600,
      margin: 0.6,
    });
    assert.equal(base.months[4]?.cumulative_net, 1000);
    assert.equal(baseProjection([0, 0, 0, 0, 0], 100).margin, null);
  });

  it('runs the What-If formulas', () => {
    const report = scenarioReport({
      target_customers: 200,
      average_contract_value: 600,
      churn_rate: 10,
      cancellation_fee: 75,
      other_monthly_expenses: 3000,
      monthly_salaries: 12000,
    });
    assert.equal(report.effective_customers, 180);
    assert.equal(report.gross_service_revenue, 108000);
    assert.equal(report.cancellation_fee_income, 1500);
    assert.equal(report.total_revenue, 109500);
    assert.equal(report.total_labor, 60000);
    assert.equal(report.total_operating, 15000);
    assert.equal(report.total_expenses, 75000);
    assert.equal(report.net, 34500);
    assert.ok(Math.abs((report.margin ?? 0) - 34500 / 109500) < 1e-12);
  });

  it('shows a loss as a negative net, and keeps churn between 0 and 100%', () => {
    const loss = scenarioReport({
      target_customers: 10,
      average_contract_value: 500,
      churn_rate: 150,
      cancellation_fee: 50,
      other_monthly_expenses: 100,
      monthly_salaries: 1000,
    });
    assert.equal(loss.effective_customers, 0);
    assert.equal(loss.total_revenue, 500, 'every customer cancelled and paid the fee');
    assert.equal(loss.net, 500 - 5500);
  });
});

describe('the projection endpoint', () => {
  const h = harness();

  it('counts active customers and projects their contracts over the season', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.corporate);

    // Monthly at 109 over the fixture's five-period season, and one paid up front.
    await makeContract(world.branches.kingston, world.users.corporate, { address_line1: '1 King St' });
    await makeContract(world.branches.kingston, world.users.corporate, {
      address_line1: '2 King St',
      billing_type: 'seasonal_upfront',
      discounted_price: '99.00',
    });
    // Active, but nothing signed: counted, earns nothing.
    await makeCustomer(world.branches.kingston, world.users.corporate, { address_line1: '3 King St' });
    // Cancelled contracts and churned customers earn nothing.
    const cancelled = await makeContract(world.branches.kingston, world.users.corporate, { address_line1: '4 King St' });
    await db('contracts').where({ id: cancelled.contract_id }).update({ status: 'cancelled' });
    const churned = await makeContract(world.branches.halifax, world.users.corporate, { address_line1: '5 King St' });
    await db('customers').where({ id: churned.customer_id }).update({ status: 'churned' });

    const reply = await call(h.server(), 'GET', '/finance/projection', { token });
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const data = reply.body.data;
    assert.equal(data.active_customers, 4);
    assert.equal(data.contracted_customers, 2);
    assert.deepEqual(data.monthly_revenue, ['208.00', '109.00', '109.00', '109.00', '109.00']);
    assert.equal(data.base_revenue, '644.00');
    assert.equal(data.average_contract_value, '322.00');
    assert.match(data.season.start, /^\d{4}-11-01$/);

    const halifax = await call(h.server(), 'GET', `/finance/projection?branch_id=${world.branches.halifax}`, { token });
    assert.equal(halifax.body.data.active_customers, 0);
    assert.equal(halifax.body.data.base_revenue, '0.00');
  });

  it('is corporate’s alone', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const reply = await call(h.server(), 'GET', '/finance/projection', { token });
    assert.equal(reply.status, 403);
  });
});
