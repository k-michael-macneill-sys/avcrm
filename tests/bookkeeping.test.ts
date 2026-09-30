import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeContract } from './helpers/fixtures';
import { call, login } from './helpers/server';

/** A one-pixel PNG, standing in for a photo of a till slip. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('bookkeeping', () => {
  const h = harness();

  async function corporate(): Promise<string> {
    return login(h.server(), h.world().emails.corporate);
  }

  async function uploadReceipt(token: string, purpose = 'receipt'): Promise<string> {
    const target = await call(h.server(), 'POST', '/uploads', {
      token,
      body: { purpose, content_type: 'image/png', file_name: 'canadian-tire.png' },
    });
    assert.equal(target.status, 201, JSON.stringify(target.body));
    const put = await fetch(`${h.server().url}${target.body.data.upload_url}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    assert.equal(put.status, 201);
    return target.body.data.key as string;
  }

  async function add(token: string, body: Record<string, unknown>) {
    return call(h.server(), 'POST', '/expenses', { token, body });
  }

  it('serves the deductible categories, Other included', async () => {
    const reply = await call(h.server(), 'GET', '/expenses/categories', { token: await corporate() });

    assert.equal(reply.status, 200);
    const codes = reply.body.data.map((c: { code: string }) => c.code);
    for (const code of ['equipment_maintenance', 'fuel', 'commercial_insurance', 'vehicle_upkeep', 'subcontractors', 'protective_gear', 'other']) {
      assert.ok(codes.includes(code), `${code} is offered`);
    }
    assert.ok(reply.body.data.every((c: { cra_line: string }) => c.cra_line), 'each names its T2125 line');
  });

  it('files an expense with its receipt attached', async () => {
    const token = await corporate();
    const key = await uploadReceipt(token);

    const reply = await add(token, {
      category: 'fuel',
      amount: '84.37',
      spent_on: '2026-12-02',
      vendor: 'Petro-Canada',
      receipt_key: key,
      branch_id: h.world().branches.kingston,
    });

    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.data.amount, '84.37', 'money stays a string, to the cent');
    assert.equal(reply.body.data.category_label, 'Fuel');
    assert.equal(reply.body.data.receipt_key, key);
    assert.equal(reply.body.data.receipt_file_name, 'canadian-tire.png');
    assert.equal(reply.body.data.branch_name, 'Kingston');

    const audit = await db('audit_log').where({ action: 'expense.created' }).first();
    assert.ok(audit, 'filing an expense is on the record');
  });

  it('refuses a receipt that was uploaded as something else', async () => {
    const token = await corporate();
    const signature = await uploadReceipt(token, 'signature');

    const reply = await add(token, { category: 'fuel', amount: 10, receipt_key: signature });
    assert.equal(reply.status, 400);
    assert.match(reply.body.error.message, /not uploaded as a receipt/);
  });

  it('insists on a description for Other, and on real money', async () => {
    const token = await corporate();

    const undescribed = await add(token, { category: 'other', amount: 12 });
    assert.equal(undescribed.status, 400);
    assert.match(undescribed.body.error.message, /Other/);

    const described = await add(token, { category: 'other', amount: 12, description: 'Parking at the yard' });
    assert.equal(described.status, 201);

    const negative = await add(token, { category: 'fuel', amount: -5 });
    assert.equal(negative.status, 400);
    const fractional = await add(token, { category: 'fuel', amount: 1.005 });
    assert.equal(fractional.status, 400);
  });

  it('sorts by recent, category and amount either way', async () => {
    const token = await corporate();
    await add(token, { category: 'subcontractors', amount: 900, spent_on: '2026-11-01' });
    await add(token, { category: 'fuel', amount: 60, spent_on: '2026-12-15' });
    await add(token, { category: 'commercial_insurance', amount: 1500, spent_on: '2026-10-01' });

    const amounts = async (sort?: string) => {
      const reply = await call(h.server(), 'GET', `/expenses${sort ? `?sort=${sort}` : ''}`, { token });
      assert.equal(reply.status, 200);
      return reply.body.data.map((e: { amount: string; category_label: string }) => [e.category_label, e.amount]);
    };

    assert.deepEqual(await amounts(), [
      ['Fuel', '60.00'],
      ['Subcontractors', '900.00'],
      ['Commercial insurance', '1500.00'],
    ], 'most recent first by default');
    assert.deepEqual((await amounts('amount_desc')).map((r: string[]) => r[1]), ['1500.00', '900.00', '60.00']);
    assert.deepEqual((await amounts('amount_asc')).map((r: string[]) => r[1]), ['60.00', '900.00', '1500.00']);
    assert.deepEqual(
      (await amounts('category')).map((r: string[]) => r[0]),
      ['Commercial insurance', 'Fuel', 'Subcontractors'],
      'alphabetical by the label people read',
    );
  });

  it('is corporate business only', async () => {
    const token = await login(h.server(), h.world().emails.sales);
    const reply = await call(h.server(), 'GET', '/expenses', { token });
    assert.equal(reply.status, 403);
  });

  it('deletes an entry', async () => {
    const token = await corporate();
    const created = await add(token, { category: 'fuel', amount: 20 });
    const reply = await call(h.server(), 'DELETE', `/expenses/${created.body.data.id}`, { token });
    assert.equal(reply.status, 204);
    assert.equal((await db('expenses').count('* as n'))[0]?.n, '0');
  });
});

describe('the financial dashboard', () => {
  const h = harness();

  it('nets what was collected against what was spent', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.corporate);
    const contract = await makeContract(world.branches.kingston, world.users.operator);

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

    await call(h.server(), 'POST', '/expenses', {
      token,
      body: { category: 'fuel', amount: 50.25, spent_on: '2027-01-10', branch_id: world.branches.kingston },
    });
    // Company-wide: counts overall, not against Kingston.
    await call(h.server(), 'POST', '/expenses', {
      token,
      body: { category: 'professional_fees', amount: 20, spent_on: '2027-01-20' },
    });

    const all = await call(h.server(), 'GET', '/finance/summary', { token });
    assert.equal(all.status, 200);
    assert.equal(all.body.data.totals.collected, '120.00');
    assert.equal(all.body.data.totals.invoiced, '300.00');
    assert.equal(all.body.data.totals.expenses, '70.25');
    assert.equal(all.body.data.totals.net_cash, '49.75');
    assert.equal(all.body.data.totals.net_invoiced, '229.75');
    assert.equal(all.body.data.totals.receipts_missing, 2);

    const january = all.body.data.monthly.find((m: { month: string }) => m.month === '2027-01');
    assert.deepEqual(january, {
      month: '2027-01',
      invoiced: '300.00',
      collected: '120.00',
      expenses: '70.25',
      net: '49.75',
    });
    assert.equal(all.body.data.by_category[0].label, 'Fuel', 'largest category first');

    const kingston = await call(
      h.server(),
      'GET',
      `/finance/summary?branch_id=${world.branches.kingston}`,
      { token },
    );
    assert.equal(kingston.body.data.totals.expenses, '50.25', 'head office costs stay out of a branch');
  });
});
