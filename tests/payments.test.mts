/*
 * Taking money through Stripe, against a stand-in for its API.
 *
 * The environment is set before anything imports the configuration, which is
 * read once at load — so the gateway under test really is the Stripe driver,
 * really pointed at the stand-in. Node runs each test file in its own
 * process, which is what makes that safe.
 */
import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import Stripe from 'stripe';
import { startStripe } from './helpers/stripeGateway';

const stripe = await startStripe();
const WEBHOOK_SECRET = 'whsec_test_secret_for_the_suite';
const port = new URL(stripe.url).port;

process.env.PAYMENT_GATEWAY = 'stripe';
process.env.STRIPE_SECRET_KEY = 'sk_test_suite';
process.env.STRIPE_WEBHOOK_SECRET = WEBHOOK_SECRET;
process.env.STRIPE_API_HOST = '127.0.0.1';
process.env.STRIPE_API_PORT = port;
process.env.STRIPE_API_PROTOCOL = 'http';

const { db, resetDatabase } = await import('./helpers/database');
const { buildWorld, makeContract, setTemplate } = await import('./helpers/fixtures');
const { call, login, startServer } = await import('./helpers/server');

describe('cards, charges and the webhooks that reconcile them', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let corporate: string;
  let world: Awaited<ReturnType<typeof buildWorld>>;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.close();
    await stripe.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    world = await buildWorld();
    corporate = await login(server, world.emails.corporate);
  });

  async function contractWithoutCard() {
    return makeContract(world.branches.kingston, world.users.operator);
  }

  async function sentInvoice(contractId: string, amount = 149.5) {
    const created = await call(server, 'POST', '/invoices', {
      token: corporate,
      body: {
        contract_id: contractId,
        billing_period_start: '2027-01-01',
        billing_period_end: '2027-01-31',
        amount_due: amount,
        due_date: '2027-01-15',
      },
    });
    await call(server, 'POST', `/invoices/${created.body.data.id}/send`, { token: corporate });
    return created.body.data.id as string;
  }

  describe('getting a card on file', () => {
    it('sends the customer to the processor own page, and queues the link', async () => {
      const contract = await contractWithoutCard();
      await setTemplate(
        'card_setup_request',
        'email',
        'Hi {{customer_first_name}}, add your card here: {{card_url}}',
        'Your card for {{address_line1}}',
      );

      const reply = await call(server, 'POST', '/card-setups', {
        token: corporate,
        body: { contract_id: contract.contract_id },
      });

      assert.equal(reply.status, 201);
      // The link goes to the processor: the card is typed there, not here,
      // so nobody has to read a number or a CVV out on a doorstep.
      assert.match(reply.body.data.url, /^https:\/\/checkout\.stripe\.test\//);
      assert.equal(reply.body.data.setup.status, 'sent');

      const customer = await db('customers').where({ id: contract.customer_id }).first();
      assert.ok(customer?.stripe_customer_id, 'the customer now exists at the processor');

      const queued = await db('message_log').where({ template_code: 'card_setup_request' });
      assert.equal(queued.length, 1);
      assert.match(queued[0]?.body ?? '', /checkout\.stripe\.test/);
    });

    it('puts the card on the contract once the customer has finished', async () => {
      const contract = await contractWithoutCard();
      const asked = await call(server, 'POST', '/card-setups', {
        token: corporate,
        body: { contract_id: contract.contract_id },
      });

      const refreshed = await call(
        server,
        'POST',
        `/card-setups/${asked.body.data.setup.id}/refresh`,
        { token: corporate },
      );

      assert.equal(refreshed.status, 200);
      assert.equal(refreshed.body.data.status, 'completed');
      assert.equal(refreshed.body.data.payment_method_last4, '4242');

      const stored = await db('contracts').where({ id: contract.contract_id }).first();
      // A processor token, never a card number.
      assert.match(stored?.payment_method_token ?? '', /^pm_/);
      assert.equal(stored?.payment_method_last4, '4242');

      const box = await db('contract_checklist_items')
        .where({ contract_id: contract.contract_id, item_code: 'card_on_file' })
        .first();
      assert.equal(box?.checked, true, 'the checklist and the token move together');
    });

    it('is idempotent, because the webhook and a rep can both ask', async () => {
      const contract = await contractWithoutCard();
      const asked = await call(server, 'POST', '/card-setups', {
        token: corporate,
        body: { contract_id: contract.contract_id },
      });
      const setupId = asked.body.data.setup.id;

      await call(server, 'POST', `/card-setups/${setupId}/refresh`, { token: corporate });
      const again = await call(server, 'POST', `/card-setups/${setupId}/refresh`, {
        token: corporate,
      });

      assert.equal(again.status, 200);
      assert.equal(again.body.data.status, 'completed');
      assert.equal((await db('card_setups')).length, 1);
    });
  });

  describe('charging the saved card', () => {
    it('collects with nobody present', async () => {
      const contract = await contractWithoutCard();
      const asked = await call(server, 'POST', '/card-setups', {
        token: corporate,
        body: { contract_id: contract.contract_id },
      });
      await call(server, 'POST', `/card-setups/${asked.body.data.setup.id}/refresh`, {
        token: corporate,
      });

      const invoiceId = await sentInvoice(contract.contract_id);
      const charged = await call(server, 'POST', `/invoices/${invoiceId}/charge`, {
        token: corporate,
      });

      assert.equal(charged.status, 200);
      assert.equal(charged.body.data.status, 'paid');
      assert.equal(charged.body.data.amount_paid, '149.50');

      const succeeded = charged.body.data.payments.find(
        (p: { status: string }) => p.status === 'succeeded',
      );
      assert.match(succeeded.provider_transaction_id, /^pi_/);
    });

    it('refuses to charge a settled invoice twice', async () => {
      const contract = await contractWithoutCard();
      const asked = await call(server, 'POST', '/card-setups', {
        token: corporate,
        body: { contract_id: contract.contract_id },
      });
      await call(server, 'POST', `/card-setups/${asked.body.data.setup.id}/refresh`, {
        token: corporate,
      });

      const invoiceId = await sentInvoice(contract.contract_id);
      await call(server, 'POST', `/invoices/${invoiceId}/charge`, { token: corporate });

      const again = await call(server, 'POST', `/invoices/${invoiceId}/charge`, {
        token: corporate,
      });
      assert.equal(again.status, 409);
    });

    it('treats a decline as an answer, not a crash', async () => {
      const contract = await makeContract(world.branches.kingston, world.users.operator, {
        payment_method_token: 'pm_card_declined',
        payment_method_last4: '0002',
      });
      // Charging off-session needs a customer at the processor as well as a
      // payment method — the card-setup flow creates both, so a shortcut
      // past it has to create both too.
      await db('customers')
        .where({ id: contract.customer_id })
        .update({ stripe_customer_id: 'cus_test_declined' });

      const invoiceId = await sentInvoice(contract.contract_id, 99);
      const reply = await call(server, 'POST', `/invoices/${invoiceId}/charge`, {
        token: corporate,
      });

      assert.equal(reply.status, 200, 'a refused card is a recorded outcome');
      assert.equal(reply.body.data.amount_paid, '0.00');

      const failed = reply.body.data.payments.find((p: { status: string }) => p.status === 'failed');
      assert.equal(failed.failure_reason, 'Your card has insufficient funds.');

      // The spec's rule: tell the customer, flag the manager.
      const notices = await db('message_log').whereIn('template_code', [
        'payment_failed',
        'payment_failed_internal',
      ]);
      assert.equal(notices.length, 2);
    });
  });

  describe('webhooks', () => {
    async function paidInvoice() {
      const contract = await contractWithoutCard();
      const asked = await call(server, 'POST', '/card-setups', {
        token: corporate,
        body: { contract_id: contract.contract_id },
      });
      await call(server, 'POST', `/card-setups/${asked.body.data.setup.id}/refresh`, {
        token: corporate,
      });
      const invoiceId = await sentInvoice(contract.contract_id);
      await call(server, 'POST', `/invoices/${invoiceId}/charge`, { token: corporate });

      const payment = await db('payments').where({ invoice_id: invoiceId, status: 'succeeded' }).first();
      return { invoiceId, intent: payment?.provider_transaction_id ?? '' };
    }

    function signed(payload: string): Record<string, string> {
      return {
        'Content-Type': 'application/json',
        'stripe-signature': Stripe.webhooks.generateTestHeaderString({
          payload,
          secret: WEBHOOK_SECRET,
        }),
      };
    }

    it('refuses one that is not signed', async () => {
      const reply = await call(server, 'POST', '/webhooks/stripe', {
        headers: { 'Content-Type': 'application/json' },
        raw: JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' }),
      });
      assert.equal(reply.status, 400);
    });

    it('refuses a forged signature', async () => {
      const reply = await call(server, 'POST', '/webhooks/stripe', {
        headers: {
          'Content-Type': 'application/json',
          'stripe-signature': 't=1,v1=deadbeef',
        },
        raw: JSON.stringify({ id: 'evt_1', type: 'payment_intent.succeeded' }),
      });
      assert.equal(reply.status, 400);
    });

    it('books a refund that arrives properly signed', async () => {
      const { invoiceId, intent } = await paidInvoice();
      const payload = JSON.stringify({
        id: 'evt_refund_1',
        type: 'charge.refunded',
        data: { object: { object: 'charge', payment_intent: intent } },
      });

      const reply = await call(server, 'POST', '/webhooks/stripe', {
        headers: signed(payload),
        raw: payload,
      });
      assert.equal(reply.status, 200);

      const payment = await db('payments').where({ provider_transaction_id: intent }).first();
      assert.equal(payment?.status, 'refunded');

      const invoice = await db('invoices').where({ id: invoiceId }).first();
      assert.equal(invoice?.amount_paid, '0.00', 'the invoice goes back to owing');
    });

    it('changes nothing when the same event is delivered twice', async () => {
      const { intent } = await paidInvoice();
      const payload = JSON.stringify({
        id: 'evt_refund_1',
        type: 'charge.refunded',
        data: { object: { object: 'charge', payment_intent: intent } },
      });

      await call(server, 'POST', '/webhooks/stripe', { headers: signed(payload), raw: payload });
      await call(server, 'POST', '/webhooks/stripe', { headers: signed(payload), raw: payload });

      // Stripe redelivers; one charge must stay one row.
      const rows = await db('payments').where({ provider_transaction_id: intent });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, 'refunded');
    });
  });
});
