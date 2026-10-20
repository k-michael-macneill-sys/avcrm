import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { INVOICE_SENT_EMAIL, PAYMENT_RECEIPT_EMAIL } from '../src/types/billingEmails';
import { harness } from './helpers/harness';
import { makeContract } from './helpers/fixtures';
import { call, login } from './helpers/server';
import { addMonths, billingPeriods } from '../src/services/invoices';

describe('splitting a season into periods', () => {
  it('gives a monthly contract one period per month, ending on season end', () => {
    const periods = billingPeriods('2026-11-15', '2027-04-15');
    assert.equal(periods.length, 5);
    assert.equal(periods[0]?.start, '2026-11-15');
    // The last period stops at season end rather than running a month past it.
    assert.equal(periods[4]?.end, '2027-04-15');
  });

  it('clamps to the end of a short month instead of spilling into the next', () => {
    // 31 January plus one month is 28 February, not 3 March.
    assert.equal(addMonths('2027-01-31', 1), '2027-02-28');
    assert.equal(addMonths('2028-01-31', 1), '2028-02-29');
  });
});

describe('invoices and what can be done to them', () => {
  const h = harness();

  async function draft(overrides: Record<string, unknown> = {}) {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator, overrides);
    const token = await login(h.server(), world.emails.corporate);

    const created = await call(h.server(), 'POST', '/invoices', {
      token,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-01-01',
        billing_period_end: '2027-01-31',
        amount_due: 149.5,
        due_date: '2027-01-15',
      },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    return { token, contract, invoice: created.body.data };
  }

  it('keeps money as a string, never a float', async () => {
    const { invoice } = await draft();
    assert.equal(invoice.amount_due, '149.50');
    assert.equal(invoice.amount_paid, '0.00');
  });

  it('is only a bill once it has been sent', async () => {
    const { token, invoice } = await draft();
    assert.equal(invoice.status, 'draft');

    const sent = await call(h.server(), 'POST', `/invoices/${invoice.id}/send`, { token });
    assert.equal(sent.status, 200);
    assert.equal(sent.body.data.status, 'sent');
    assert.ok(sent.body.data.sent_at);

    const queued = await db('message_log').where({ template_code: 'invoice_sent' });
    assert.equal(queued.length, 1);
  });

  it('texts the bill to a customer who asked for texts', async () => {
    const { token, invoice } = await draft({ preferred_contact: 'sms', phone: '+16135550177' });
    await call(h.server(), 'POST', `/invoices/${invoice.id}/send`, { token });

    const [queued] = await db('message_log').where({ template_code: 'invoice_sent' });
    assert.equal(queued?.channel, 'sms');
    assert.equal(queued?.recipient, '+16135550177');
  });

  it('voids a draft nobody was ever shown', async () => {
    const { token, invoice } = await draft();
    const reply = await call(h.server(), 'POST', `/invoices/${invoice.id}/void`, { token });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.status, 'void');
  });

  it('refuses to void one that has money against it', async () => {
    const { token, invoice } = await draft();
    await call(h.server(), 'POST', `/invoices/${invoice.id}/send`, { token });
    await call(h.server(), 'POST', `/invoices/${invoice.id}/payments`, {
      token,
      body: { amount: 149.5, method: 'cheque', status: 'succeeded' },
    });

    const reply = await call(h.server(), 'POST', `/invoices/${invoice.id}/void`, { token });
    assert.equal(reply.status, 409);
  });

  it('derives what is paid from the payments, and settles itself', async () => {
    const { token, invoice } = await draft();
    await call(h.server(), 'POST', `/invoices/${invoice.id}/send`, { token });

    const half = await call(h.server(), 'POST', `/invoices/${invoice.id}/payments`, {
      token,
      body: { amount: 100, method: 'etransfer', status: 'succeeded' },
    });
    assert.equal(half.status, 201);

    let current = await call(h.server(), 'GET', `/invoices/${invoice.id}`, { token });
    assert.equal(current.body.data.amount_paid, '100.00');
    assert.equal(current.body.data.status, 'sent', 'part paid is still owing');

    await call(h.server(), 'POST', `/invoices/${invoice.id}/payments`, {
      token,
      body: { amount: 49.5, method: 'etransfer', status: 'succeeded' },
    });

    current = await call(h.server(), 'GET', `/invoices/${invoice.id}`, { token });
    assert.equal(current.body.data.amount_paid, '149.50');
    assert.equal(current.body.data.status, 'paid');
    assert.ok(current.body.data.paid_at);
  });

  it('puts an invoice back to owing when a payment is refunded', async () => {
    const { token, invoice } = await draft();
    await call(h.server(), 'POST', `/invoices/${invoice.id}/send`, { token });
    const paid = await call(h.server(), 'POST', `/invoices/${invoice.id}/payments`, {
      token,
      body: { amount: 149.5, method: 'card_on_file', status: 'succeeded' },
    });

    // Recording a payment answers with the invoice and its payments, since
    // the totals it recomputes are the point.
    const succeeded = paid.body.data.payments.find((p: { status: string }) => p.status === 'succeeded');
    const refund = await call(h.server(), 'POST', `/payments/${succeeded.id}/refund`, {
      token,
    });
    assert.equal(refund.status, 200);

    const after = await call(h.server(), 'GET', `/invoices/${invoice.id}`, { token });
    assert.equal(after.body.data.amount_paid, '0.00');
    assert.notEqual(after.body.data.status, 'paid');

    // The original payment is flipped, not deleted: the history of a disputed
    // charge has to stay readable.
    const payments = await db('payments').where({ invoice_id: invoice.id });
    assert.equal(payments.length, 1);
    assert.equal(payments[0]?.status, 'refunded');
  });

  it('tells the customer and the manager when a card is declined', async () => {
    const { token, invoice } = await draft({
      payment_method_token: 'pm_on_file',
      payment_method_last4: '4242',
    });
    await call(h.server(), 'POST', `/invoices/${invoice.id}/send`, { token });

    const failed = await call(h.server(), 'POST', `/invoices/${invoice.id}/payments`, {
      token,
      body: {
        amount: 149.5,
        method: 'card_on_file',
        status: 'failed',
        failure_reason: 'Your card has insufficient funds.',
      },
    });
    assert.equal(failed.status, 201);

    const notices = await db('message_log').whereIn('template_code', [
      'payment_failed',
      'payment_failed_internal',
    ]);
    assert.equal(notices.length, 2);

    const after = await call(h.server(), 'GET', `/invoices/${invoice.id}`, { token });
    assert.equal(after.body.data.amount_paid, '0.00', 'a failed charge collects nothing');
  });

  it('will not bill the same period twice', async () => {
    const { token, contract } = await draft();
    const again = await call(h.server(), 'POST', '/invoices', {
      token,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-01-01',
        billing_period_end: '2027-01-31',
        amount_due: 149.5,
        due_date: '2027-01-15',
      },
    });
    assert.equal(again.status, 409);
  });

  it('sends a receipt once an invoice is paid in full, and not before', async () => {
    const { token, invoice } = await draft();
    await call(h.server(), 'POST', `/invoices/${invoice.id}/send`, { token });
    await db('message_templates').where({ code: 'payment_receipt', channel: 'email' }).update(PAYMENT_RECEIPT_EMAIL);

    await call(h.server(), 'POST', `/invoices/${invoice.id}/payments`, {
      token,
      body: { amount: 100, method: 'etransfer', status: 'succeeded' },
    });
    assert.equal((await db('message_log').where({ template_code: 'payment_receipt' })).length, 0);

    await call(h.server(), 'POST', `/invoices/${invoice.id}/payments`, {
      token,
      body: { amount: 49.5, method: 'etransfer', status: 'succeeded' },
    });
    const receipts = await db('message_log').where({ template_code: 'payment_receipt' });
    assert.equal(receipts.length, 1);
    assert.match(receipts[0]?.body ?? '', /Amount paid: \$149\.50/);
    assert.match(receipts[0]?.body ?? '', /Payment method: e-Transfer/);
    assert.doesNotMatch(receipts[0]?.body ?? '', /\{\{/);
  });

  it('lays out the bill in the invoice email', async () => {
    const { token, invoice } = await draft();
    await db('message_templates').where({ code: 'invoice_sent', channel: 'email' }).update(INVOICE_SENT_EMAIL);
    await call(h.server(), 'POST', `/invoices/${invoice.id}/send`, { token });

    const [queued] = await db('message_log').where({ template_code: 'invoice_sent' });
    assert.match(queued?.body ?? '', /Amount due: \$149\.50/);
    assert.match(queued?.body ?? '', /Due date: Jan 15, 2027/);
    assert.match(queued?.body ?? '', /→ .+: http/);
    assert.doesNotMatch(queued?.body ?? '', /\{\{/);
  });

  it('emails an invoice again, to another address if asked, as a receipt once paid', async () => {
    const { token, invoice } = await draft();

    // A draft goes out for the first time.
    const first = await call(h.server(), 'POST', `/invoices/${invoice.id}/email`, { token, body: {} });
    assert.equal(first.status, 201, JSON.stringify(first.body));
    assert.equal(first.body.data.template_code, 'invoice_sent');
    assert.equal((await db('invoices').where({ id: invoice.id }).first())?.status, 'sent');

    const elsewhere = await call(h.server(), 'POST', `/invoices/${invoice.id}/email`, {
      token,
      body: { to: 'new-address@example.test' },
    });
    assert.equal(elsewhere.body.data.sent_to, 'new-address@example.test');

    await call(h.server(), 'POST', `/invoices/${invoice.id}/payments`, {
      token,
      body: { amount: 149.5, method: 'cash', status: 'succeeded' },
    });
    const paid = await call(h.server(), 'POST', `/invoices/${invoice.id}/email`, { token, body: {} });
    assert.equal(paid.body.data.template_code, 'payment_receipt');
  });

  it('bills a previous customer by hand, and can email it as it is raised', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    await db('contracts').where({ id: contract.contract_id }).update({ status: 'completed' });
    const token = await login(h.server(), world.emails.corporate);

    const created = await call(h.server(), 'POST', '/invoices', {
      token,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-04-01',
        billing_period_end: '2027-04-15',
        amount_due: 75,
        due_date: '2027-04-30',
        send: true,
        to: 'old-customer@example.test',
      },
    });

    assert.equal(created.status, 201, JSON.stringify(created.body));
    assert.equal(created.body.data.status, 'sent');
    assert.equal(created.body.data.sent_to, 'old-customer@example.test');
  });

  it('is corporate work: an operator cannot raise a bill', async () => {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const token = await login(h.server(), world.emails.operator);

    const reply = await call(h.server(), 'POST', '/invoices', {
      token,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-01-01',
        billing_period_end: '2027-01-31',
        amount_due: 10,
        due_date: '2027-01-15',
      },
    });
    assert.equal(reply.status, 403);
  });
});
