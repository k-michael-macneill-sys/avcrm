import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { makeContract, makeCustomer, makeQuote, makeWorkOrder } from './helpers/fixtures';
import { harness } from './helpers/harness';
import { call, login } from './helpers/server';

describe('deleting records and everything beneath them', () => {
  const h = harness();

  /** A signed customer with a sent invoice, a payment on it, and a visit. */
  async function paperwork() {
    const world = h.world();
    const corporate = await login(h.server(), world.emails.corporate);
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const workOrder = await makeWorkOrder(contract, world.branches.kingston);

    const invoice = await call(h.server(), 'POST', '/invoices', {
      token: corporate,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-01-01',
        billing_period_end: '2027-01-31',
        amount_due: 100,
        due_date: '2027-01-15',
      },
    });
    assert.equal(invoice.status, 201, JSON.stringify(invoice.body));
    const invoiceId = invoice.body.data.id as string;
    await call(h.server(), 'POST', `/invoices/${invoiceId}/send`, { token: corporate });
    const paid = await call(h.server(), 'POST', `/invoices/${invoiceId}/payments`, {
      token: corporate,
      body: { amount: 40, method: 'cash' },
    });
    assert.equal(paid.status, 201, JSON.stringify(paid.body));

    return { world, corporate, contract, workOrder, invoiceId };
  }

  it('deletes a signed customer with every contract, invoice, payment and visit under them', async () => {
    const { corporate, contract, workOrder, invoiceId } = await paperwork();

    const reply = await call(h.server(), 'DELETE', `/customers/${contract.customer_id}`, { token: corporate });
    assert.equal(reply.status, 204, JSON.stringify(reply.body));

    assert.equal(await db('customers').where({ id: contract.customer_id }).first(), undefined);
    assert.equal(await db('contracts').where({ id: contract.contract_id }).first(), undefined);
    assert.equal(await db('invoices').where({ id: invoiceId }).first(), undefined);
    assert.equal((await db('payments').where({ invoice_id: invoiceId })).length, 0);
    assert.equal(await db('work_orders').where({ id: workOrder }).first(), undefined);
    assert.equal(await db('properties').where({ id: contract.property_id }).first(), undefined);

    const audit = await db('audit_log').where({ action: 'customer.deleted', entity_id: contract.customer_id }).first();
    assert.ok(audit, 'the delete itself is on the record');
  });

  it('refuses a sales rep a signed customer, and leaves everything in place', async () => {
    const { world, contract, invoiceId } = await paperwork();
    const sales = await login(h.server(), world.emails.sales);

    const reply = await call(h.server(), 'DELETE', `/customers/${contract.customer_id}`, { token: sales });
    assert.equal(reply.status, 403);
    assert.ok(await db('invoices').where({ id: invoiceId }).first());
  });

  it('lets a sales rep delete a lead and a presented quote', async () => {
    const world = h.world();
    const sales = await login(h.server(), world.emails.sales);
    const lead = await makeCustomer(world.branches.kingston, world.users.sales);
    const quote = await makeQuote(lead.property_id, world.users.sales, { status: 'presented' });

    const quoteReply = await call(h.server(), 'DELETE', `/quotes/${quote}`, { token: sales });
    assert.equal(quoteReply.status, 204, JSON.stringify(quoteReply.body));
    const customerReply = await call(h.server(), 'DELETE', `/customers/${lead.customer_id}`, { token: sales });
    assert.equal(customerReply.status, 204, JSON.stringify(customerReply.body));
  });

  it('deletes a contract with its invoices, and puts the quote back so it can be signed again', async () => {
    const { corporate, contract, invoiceId } = await paperwork();

    const reply = await call(h.server(), 'DELETE', `/contracts/${contract.contract_id}`, { token: corporate });
    assert.equal(reply.status, 204, JSON.stringify(reply.body));

    assert.equal(await db('contracts').where({ id: contract.contract_id }).first(), undefined);
    assert.equal(await db('invoices').where({ id: invoiceId }).first(), undefined);
    const quote = await db('quotes').where({ id: contract.quote_id }).first();
    assert.equal(quote?.status, 'presented');
    assert.ok(await db('customers').where({ id: contract.customer_id }).first(), 'the customer stays');
  });

  it('deletes an invoice and its payments, corporate only', async () => {
    const { world, corporate, invoiceId } = await paperwork();
    const sales = await login(h.server(), world.emails.sales);

    assert.equal((await call(h.server(), 'DELETE', `/invoices/${invoiceId}`, { token: sales })).status, 403);
    const reply = await call(h.server(), 'DELETE', `/invoices/${invoiceId}`, { token: corporate });
    assert.equal(reply.status, 204, JSON.stringify(reply.body));
    assert.equal((await db('payments').where({ invoice_id: invoiceId })).length, 0);
  });

  it('deletes a visit, but not for the operator doing it', async () => {
    const { world, corporate, workOrder } = await paperwork();
    const operator = await login(h.server(), world.emails.operator);

    assert.equal((await call(h.server(), 'DELETE', `/work-orders/${workOrder}`, { token: operator })).status, 403);
    const reply = await call(h.server(), 'DELETE', `/work-orders/${workOrder}`, { token: corporate });
    assert.equal(reply.status, 204, JSON.stringify(reply.body));
    assert.equal(await db('work_orders').where({ id: workOrder }).first(), undefined);
  });

  it('deletes a staff account, unassigning their visits, but never your own', async () => {
    const { world, corporate, workOrder } = await paperwork();
    await db('work_orders').where({ id: workOrder }).update({ assigned_user_id: world.users.operator });

    const self = await call(h.server(), 'DELETE', `/users/${world.users.corporate}`, { token: corporate });
    assert.equal(self.status, 400);

    const reply = await call(h.server(), 'DELETE', `/users/${world.users.operator}`, { token: corporate });
    assert.equal(reply.status, 204, JSON.stringify(reply.body));
    assert.equal(await db('users').where({ id: world.users.operator }).first(), undefined);
    const order = await db('work_orders').where({ id: workOrder }).first();
    assert.equal(order?.assigned_user_id, null);
  });
});
