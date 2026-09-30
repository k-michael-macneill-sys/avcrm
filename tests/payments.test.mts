/*
 * Taking money through Square configured from the environment — no Settings
 * row at all — against a stand-in for its API.
 *
 * The environment is set before anything imports the configuration, which is
 * read once at load — so envGateway under test really is built from these
 * variables. Node runs each test file in its own process, which is what
 * makes that safe. The Settings-configured path (an admin connecting Square
 * from /app/settings) has its own, much larger suite in square.test.mts;
 * this file exists to prove the environment path works on its own, and that
 * Settings still overrides it when both are present.
 */
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, describe, it } from 'node:test';
import {
  DECLINED_NONCE,
  SQUARE_LOCATION,
  SQUARE_TOKEN,
  startSquare,
} from './helpers/squareGateway';

const square = await startSquare();
process.env.SQUARE_API_BASE = square.url;
process.env.SQUARE_ENVIRONMENT = 'sandbox';
process.env.SQUARE_APPLICATION_ID = 'sandbox-sq0idb-suite';
process.env.SQUARE_LOCATION_ID = SQUARE_LOCATION;
process.env.SQUARE_ACCESS_TOKEN = SQUARE_TOKEN;
process.env.SQUARE_WEBHOOK_SIGNATURE_KEY = 'square-signature-key-from-env';

const { db, resetDatabase } = await import('./helpers/database');
const { buildWorld, makeContract, setTemplate } = await import('./helpers/fixtures');
const { call, login, startServer } = await import('./helpers/server');
const { config } = await import('../src/config');

const OK_NONCE = 'cnon:card-nonce-ok';
const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

describe('cards, charges and webhooks through Square configured from the environment', () => {
  let server: Awaited<ReturnType<typeof startServer>>;
  let corporate: string;
  let world: Awaited<ReturnType<typeof buildWorld>>;

  before(async () => {
    server = await startServer();
  });

  after(async () => {
    await server.close();
    await square.close();
  });

  beforeEach(async () => {
    await resetDatabase();
    square.requests.length = 0;
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

  /** Card requested by staff, then finished by the customer on their own page. */
  async function cardOnFile(contractId: string) {
    await setTemplate(
      'card_setup_request',
      'email',
      'Hi {{customer_first_name}}, add your card here: {{card_url}}',
      'Your card for {{address_line1}}',
    );
    const asked = await call(server, 'POST', '/card-setups', {
      token: corporate,
      body: { contract_id: contractId },
    });
    assert.equal(asked.status, 201);
    const token = new URL(asked.body.data.url).pathname.split('/').pop() ?? '';
    const saved = await call(server, 'POST', `/portal/cards/${token}`, {
      body: { source_id: OK_NONCE, signer_name: 'Harold Bell', signature_png: SIGNATURE },
    });
    assert.equal(saved.status, 200);
    return saved;
  }

  it('is the processor Settings reports when nothing has been connected there', async () => {
    const reply = await call(server, 'GET', '/settings/payments', { token: corporate });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.provider, 'none');
    assert.equal(reply.body.data.env_gateway, 'square');
  });

  it('checks the environment credentials, even with a switched-off draft saved in Settings', async () => {
    // A half-filled Square entry someone saved and never switched on — no
    // token, wrong location. It must not stand in for the working one.
    const draft = await call(server, 'PUT', '/settings/payments', {
      token: corporate,
      body: {
        provider: 'square',
        is_enabled: false,
        settings: { environment: 'sandbox', application_id: 'draft', location_id: 'NOT_A_LOCATION' },
        secrets: {},
      },
    });
    assert.equal(draft.status, 200);

    const checked = await call(server, 'POST', '/settings/payments/test', { token: corporate });
    assert.equal(checked.status, 200, JSON.stringify(checked.body));
    assert.equal(checked.body.data.environment, 'sandbox');
    assert.equal(checked.body.data.currency, 'CAD');
  });

  describe('getting a card on file', () => {
    it('sends the customer to our page with Square’s form on it, no Settings row needed', async () => {
      const contract = await contractWithoutCard();
      const asked = await call(server, 'POST', '/card-setups', {
        token: corporate,
        body: { contract_id: contract.contract_id },
      });
      assert.equal(asked.status, 201);
      assert.match(asked.body.data.url, /\/pay\/card\/sqs_[A-Za-z0-9_-]{32}$/);

      const customer = await db('customers').where({ id: contract.customer_id }).first();
      assert.match(customer?.square_customer_id ?? '', /^SQCUS/);
    });

    it('puts the card on the contract once the customer signs and saves it', async () => {
      const contract = await contractWithoutCard();
      await cardOnFile(contract.contract_id);

      const stored = await db('contracts').where({ id: contract.contract_id }).first();
      assert.match(stored?.payment_method_token ?? '', /^ccof:/);
      assert.equal(stored?.payment_method_provider, 'square');
      assert.equal(stored?.payment_method_last4, '1111');
    });
  });

  describe('charging the saved card', () => {
    it('collects with nobody present', async () => {
      const contract = await contractWithoutCard();
      await cardOnFile(contract.contract_id);

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
      assert.match(succeeded.provider_transaction_id, /^SQPAY/);
      assert.equal(succeeded.provider, 'square');
    });

    it('refuses to charge a settled invoice twice', async () => {
      const contract = await contractWithoutCard();
      await cardOnFile(contract.contract_id);

      const invoiceId = await sentInvoice(contract.contract_id);
      await call(server, 'POST', `/invoices/${invoiceId}/charge`, { token: corporate });

      const again = await call(server, 'POST', `/invoices/${invoiceId}/charge`, {
        token: corporate,
      });
      assert.equal(again.status, 409);
    });

    it('treats a decline as an answer, not a crash', async () => {
      const contract = await makeContract(world.branches.kingston, world.users.operator, {
        payment_method_token: DECLINED_NONCE,
        payment_method_last4: '0002',
      });
      await db('contracts')
        .where({ id: contract.contract_id })
        .update({ payment_method_provider: 'square' });
      // Charging with nobody present also needs a customer at the processor —
      // the card-setup flow creates both, so a shortcut past it has to too.
      await db('customers')
        .where({ id: contract.customer_id })
        .update({ square_customer_id: 'SQCUS_test_declined' });

      const invoiceId = await sentInvoice(contract.contract_id, 99);
      const reply = await call(server, 'POST', `/invoices/${invoiceId}/charge`, {
        token: corporate,
      });

      assert.equal(reply.status, 200, 'a refused card is a recorded outcome');
      assert.equal(reply.body.data.amount_paid, '0.00');

      const failed = reply.body.data.payments.find((p: { status: string }) => p.status === 'failed');
      assert.equal(failed.failure_reason, 'The card was declined');

      const notices = await db('message_log').whereIn('template_code', [
        'payment_failed',
        'payment_failed_internal',
      ]);
      assert.equal(notices.length, 2);
    });
  });

  describe('webhooks', () => {
    function signed(payload: string): Record<string, string> {
      const signature = createHmac('sha256', 'square-signature-key-from-env')
        .update(`${config.messaging.appBaseUrl}/webhooks/square${payload}`)
        .digest('base64');
      return { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': signature };
    }

    async function paidInvoice() {
      const contract = await contractWithoutCard();
      await cardOnFile(contract.contract_id);
      const invoiceId = await sentInvoice(contract.contract_id);
      await call(server, 'POST', `/invoices/${invoiceId}/charge`, { token: corporate });

      const payment = await db('payments').where({ invoice_id: invoiceId, status: 'succeeded' }).first();
      return { invoiceId, transactionId: payment?.provider_transaction_id ?? '' };
    }

    it('refuses one that is not signed', async () => {
      const payload = JSON.stringify({ event_id: 'e', type: 'refund.updated', data: { object: {} } });
      const reply = await call(server, 'POST', '/webhooks/square', {
        headers: { 'Content-Type': 'application/json' },
        raw: payload,
      });
      assert.equal(reply.status, 400);
    });

    it('refuses a forged signature', async () => {
      const payload = JSON.stringify({ event_id: 'e', type: 'refund.updated', data: { object: {} } });
      const reply = await call(server, 'POST', '/webhooks/square', {
        headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': 'AAAA' },
        raw: payload,
      });
      assert.equal(reply.status, 400);
    });

    it('books a refund made in the Square Dashboard, with only .env configured', async () => {
      const { invoiceId, transactionId } = await paidInvoice();
      const payload = JSON.stringify({
        event_id: 'evt_refund_1',
        type: 'refund.updated',
        data: { type: 'refund', id: 'r1', object: { refund: { payment_id: transactionId, status: 'COMPLETED' } } },
      });

      const reply = await call(server, 'POST', '/webhooks/square', { headers: signed(payload), raw: payload });
      assert.equal(reply.status, 200);

      const payment = await db('payments').where({ provider_transaction_id: transactionId }).first();
      assert.equal(payment?.status, 'refunded');

      const invoice = await db('invoices').where({ id: invoiceId }).first();
      assert.equal(invoice?.amount_paid, '0.00', 'the invoice goes back to owing');
    });

    it('changes nothing when the same event is delivered twice', async () => {
      const { transactionId } = await paidInvoice();
      const payload = JSON.stringify({
        event_id: 'evt_refund_1',
        type: 'refund.updated',
        data: { type: 'refund', id: 'r1', object: { refund: { payment_id: transactionId, status: 'COMPLETED' } } },
      });

      await call(server, 'POST', '/webhooks/square', { headers: signed(payload), raw: payload });
      await call(server, 'POST', '/webhooks/square', { headers: signed(payload), raw: payload });

      const rows = await db('payments').where({ provider_transaction_id: transactionId });
      assert.equal(rows.length, 1);
      assert.equal(rows[0]?.status, 'refunded');
    });
  });
});
