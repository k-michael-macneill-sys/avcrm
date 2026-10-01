import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeCustomer, PASSWORD } from './helpers/fixtures';
import { call } from './helpers/server';

let n = 0;
/** The agreement as a rep fills it in, with a fresh address each time. */
function agreement(overrides: Record<string, string | boolean> = {}) {
  n += 1;
  return {
    customer_name: 'Harold Bell',
    customer_street: `${200 + n} Baker St`,
    customer_city: 'Somewhere Else',
    customer_province: 'BC',
    customer_postal: 'V1C 4H4',
    customer_phone: '250-555-0201',
    customer_email: `harold${n}@example.test`,
    start_year: '26',
    end_year: '27',
    package: 'Basic',
    price_basic: '99.00',
    ...overrides,
  };
}

describe('signing in by branch', () => {
  const h = harness();

  async function signIn(choice: string, password: string) {
    return call(h.server(), 'POST', '/auth/sign-in', { body: { choice, password } });
  }

  async function branchToken(choice: string): Promise<string> {
    const reply = await signIn(choice, '1234');
    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    return reply.body.data.token as string;
  }

  it('offers the four branches and ADMIN', async () => {
    const reply = await call(h.server(), 'GET', '/auth/sign-in/choices');
    assert.deepEqual(reply.body.data, ['Cranbrook', 'Kingston', 'Alberta', 'Regina', 'ADMIN']);
  });

  it('signs a branch in with the branch password, and says which branch', async () => {
    const reply = await signIn('Cranbrook', '1234');

    assert.equal(reply.status, 200, JSON.stringify(reply.body));
    const { user, branch } = reply.body.data;
    assert.equal(user.role, 'branch');
    assert.equal(branch.name, 'Cranbrook');
    assert.equal(branch.default_city, 'Cranbrook');
    assert.equal(user.branch_id, branch.id);
    assert.equal(user.password_hash, undefined, 'never sent back');

    // Signing in again is the same account, not a second one.
    await signIn('Cranbrook', '1234');
    assert.equal((await db('users').where({ role: 'branch' })).length, 1);
  });

  it('uses the branch that is already there', async () => {
    const reply = await signIn('Kingston', '1234');
    assert.equal(reply.body.data.branch.id, h.world().branches.kingston);
    assert.equal(reply.body.data.branch.default_city, 'Kingston', 'and gives it its city');
  });

  it('leaves Alberta without a city: it covers several towns', async () => {
    const reply = await signIn('Alberta', '1234');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.branch.default_city, null);
  });

  it('refuses a wrong password, and a branch that is not on the list', async () => {
    const wrong = await signIn('Regina', '4321');
    assert.equal(wrong.status, 401);
    assert.match(wrong.body.error.message, /Regina/);

    const unknown = await signIn('Halifax', '1234');
    assert.equal(unknown.status, 400);
  });

  it('signs ADMIN in with a corporate account’s own password, and not the branch one', async () => {
    const admin = await signIn('ADMIN', PASSWORD);
    assert.equal(admin.status, 200, JSON.stringify(admin.body));
    assert.equal(admin.body.data.user.role, 'corporate');
    assert.equal(admin.body.data.user.email, 'corporate@test.local');
    assert.equal(admin.body.data.branch, null);

    const withBranchPassword = await signIn('ADMIN', '1234');
    assert.equal(withBranchPassword.status, 401);
  });

  it('opens the branch’s selling and dispatch, and none of corporate’s screens', async () => {
    const token = await branchToken('Kingston');

    for (const path of ['/customers', '/quotes', '/contracts', '/work-orders', '/operators']) {
      const reply = await call(h.server(), 'GET', path, { token });
      assert.equal(reply.status, 200, `${path}: ${JSON.stringify(reply.body)}`);
    }
    for (const path of ['/reports/branch-summary', '/expenses', '/finance/summary', '/weather/runs']) {
      const reply = await call(h.server(), 'GET', path, { token });
      assert.equal(reply.status, 403, path);
    }
    // Invoices read like any branch record; raising one is corporate's.
    const bill = await call(h.server(), 'POST', '/invoices', { token, body: {} });
    assert.equal(bill.status, 403);
  });

  it('keeps a branch to its own customers', async () => {
    const halifax = await makeCustomer(h.world().branches.halifax, h.world().users.corporate);
    const token = await branchToken('Kingston');

    const reply = await call(h.server(), 'GET', `/customers/${halifax.customer_id}`, { token });
    assert.equal(reply.status, 404);
  });

  it('writes the branch and its city onto the agreement, whatever was typed', async () => {
    const token = await branchToken('Cranbrook');
    const reply = await call(h.server(), 'POST', '/sales/agreement-deals', {
      token,
      // No branch_id: the branch is the session's.
      body: { agreement: agreement() },
    });

    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    const { customer, property, quote } = reply.body.data;
    const cranbrook = (await db('branches').where({ name: 'Cranbrook' }).first())!;
    assert.equal(customer.branch_id, cranbrook.id);
    assert.equal(property.city, 'Cranbrook');
    assert.equal(quote.agreement_fields.customer_city, 'Cranbrook', 'the signed contract prints it too');
  });

  it('keeps the city typed on an Alberta agreement, and needs one', async () => {
    const token = await branchToken('Alberta');

    const typed = await call(h.server(), 'POST', '/sales/agreement-deals', {
      token,
      body: { agreement: agreement({ customer_city: 'Lethbridge', customer_province: 'AB' }) },
    });
    assert.equal(typed.status, 201, JSON.stringify(typed.body));
    assert.equal(typed.body.data.property.city, 'Lethbridge');

    const blank = await call(h.server(), 'POST', '/sales/agreement-deals', {
      token,
      body: { agreement: agreement({ customer_city: '' }) },
    });
    assert.equal(blank.status, 400);
    assert.deepEqual(
      blank.body.error.details.map((d: { path: string }) => d.path),
      ['agreement.customer_city'],
    );
  });

  it('leaves ADMIN’s agreements as typed', async () => {
    const admin = await signIn('ADMIN', PASSWORD);
    const reply = await call(h.server(), 'POST', '/sales/agreement-deals', {
      token: admin.body.data.token,
      body: { agreement: agreement({ customer_city: 'Nelson' }), branch_id: h.world().branches.kingston },
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.data.property.city, 'Nelson');
  });

  it('fills the city on a property a branch adds without one', async () => {
    const token = await branchToken('Regina');
    const regina = (await db('branches').where({ name: 'Regina' }).first())!;
    const customer = await makeCustomer(regina.id, h.world().users.corporate);

    const reply = await call(h.server(), 'POST', '/properties', {
      token,
      body: {
        customer_id: customer.customer_id,
        address_line1: '1 Albert St',
        province: 'SK',
        postal_code: 'S4P 3C8',
      },
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.data.city, 'Regina');
  });

  it('still needs a city from anybody else', async () => {
    const admin = await signIn('ADMIN', PASSWORD);
    const customer = await makeCustomer(h.world().branches.kingston, h.world().users.corporate);
    const reply = await call(h.server(), 'POST', '/properties', {
      token: admin.body.data.token,
      body: { customer_id: customer.customer_id, address_line1: '9 King St', province: 'ON', postal_code: 'K7L 2Z1' },
    });
    assert.equal(reply.status, 400);
  });

  it('turns away a switched-off branch sign-in', async () => {
    await branchToken('Kingston');
    await db('users').where({ role: 'branch' }).update({ is_active: false });
    const reply = await signIn('Kingston', '1234');
    assert.equal(reply.status, 403);
  });
});
