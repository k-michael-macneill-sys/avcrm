/*
 * Square, connected from the settings screen, against a stand-in for its API:
 * the admin connecting it, a customer paying from their invoice link, signing
 * the autopay agreement and saving a card, and what the office does after.
 *
 * SQUARE_API_BASE is set before the application loads, so the real driver
 * sends real requests — only the far end is fake.
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

const { db, resetDatabase } = await import('./helpers/database');
const { buildWorld, makeContract, setTemplate } = await import('./helpers/fixtures');
const { call, login, startServer } = await import('./helpers/server');
const { resetRateLimits } = await import('../src/middleware/rateLimit');
const { config } = await import('../src/config');

const WEBHOOK_KEY = 'square-signature-key-for-the-suite';
const OK_NONCE = 'cnon:card-nonce-ok';
/** A real 1x1 PNG: what a signature pad sends, minus the ink. */
const SIGNATURE =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

function isoToday(): string {
  return new Date().toISOString().slice(0, 10);
}

describe('Square', () => {
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
    resetRateLimits();
    square.requests.length = 0;
    world = await buildWorld();
    corporate = await login(server, world.emails.corporate);
  });

  async function connectSquare(enabled = true) {
    return call(server, 'PUT', '/settings/payments', {
      token: corporate,
      body: {
        provider: 'square',
        is_enabled: enabled,
        settings: {
          environment: 'sandbox',
          application_id: 'sandbox-sq0idb-suite',
          location_id: SQUARE_LOCATION,
        },
        secrets: { access_token: SQUARE_TOKEN, webhook_signature_key: WEBHOOK_KEY },
      },
    });
  }

  async function sentInvoice(contractId: string, amount = 149.5, month = '01') {
    const created = await call(server, 'POST', '/invoices', {
      token: corporate,
      body: {
        contract_id: contractId,
        billing_period_start: `2027-${month}-01`,
        billing_period_end: `2027-${month}-28`,
        amount_due: amount,
        due_date: '2027-01-15',
      },
    });
    await call(server, 'POST', `/invoices/${created.body.data.id}/send`, { token: corporate });
    const invoice = await db('invoices').where({ id: created.body.data.id }).first();
    assert.ok(invoice, 'the invoice was raised');
    return { id: invoice.id as string, token: invoice.portal_token as string };
  }

  describe('connecting it', () => {
    it('is corporate only', async () => {
      const operator = await login(server, world.emails.operator);
      const reply = await call(server, 'GET', '/settings/payments', { token: operator });
      assert.equal(reply.status, 403);
    });

    it('stores the token encrypted and never hands it back', async () => {
      const saved = await connectSquare();
      assert.equal(saved.status, 200);
      assert.deepEqual(saved.body.data.secrets_set.sort(), ['access_token', 'webhook_signature_key']);

      const read = await call(server, 'GET', '/settings/payments', { token: corporate });
      assert.equal(read.body.data.provider, 'square');
      assert.ok(!JSON.stringify(read.body).includes(SQUARE_TOKEN));
      assert.match(read.body.data.webhook_url, /\/webhooks\/square$/);

      const row = await db('integration_settings').where({ key: 'payments' }).first();
      assert.ok(!JSON.stringify(row).includes(SQUARE_TOKEN), 'not in the table in the clear');
    });

    it('will not switch on without the fields Square needs', async () => {
      const reply = await call(server, 'PUT', '/settings/payments', {
        token: corporate,
        body: { provider: 'square', is_enabled: true, settings: { environment: 'sandbox' }, secrets: {} },
      });
      assert.equal(reply.status, 400);
      assert.match(reply.body.error.message, /Application ID/);
    });

    it('refuses an environment that is not one of the choices', async () => {
      const reply = await call(server, 'PUT', '/settings/payments', {
        token: corporate,
        body: { provider: 'square', is_enabled: false, settings: { environment: 'staging' }, secrets: {} },
      });
      assert.equal(reply.status, 400);
    });

    it('checks the saved credentials against Square without moving money', async () => {
      await connectSquare();
      const reply = await call(server, 'POST', '/settings/payments/test', { token: corporate });
      assert.equal(reply.status, 200);
      assert.equal(reply.body.data.location_name, 'Kingston yard');
      assert.ok(square.requests.every((r) => r.path !== '/v2/payments'));
    });

    it('says plainly when Square refuses the token', async () => {
      await connectSquare();
      await call(server, 'PUT', '/settings/payments', {
        token: corporate,
        body: {
          provider: 'square',
          is_enabled: true,
          settings: { environment: 'sandbox', application_id: 'app', location_id: SQUARE_LOCATION },
          secrets: { access_token: 'wrong' },
        },
      });
      const reply = await call(server, 'POST', '/settings/payments/test', { token: corporate });
      assert.equal(reply.status, 502);
      assert.match(reply.body.error.message, /access token/);
    });
  });

  describe('the invoice link', () => {
    it('goes out in the invoice email', async () => {
      await connectSquare();
      await setTemplate('invoice_sent', 'email', '{{pay_prompt}}: {{pay_url}}', 'Your invoice');
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const invoice = await sentInvoice(contract.contract_id);

      assert.match(invoice.token, /^[A-Za-z0-9_-]{32}$/);
      const message = await db('message_log').where({ template_code: 'invoice_sent' }).first();
      assert.equal(message?.body, `Pay online: ${config.messaging.appBaseUrl}/pay/${invoice.token}`);
    });

    it('offers only a view when no processor takes online payments', async () => {
      await setTemplate('invoice_sent', 'email', '{{pay_prompt}}: {{pay_url}}', 'Your invoice');
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const invoice = await sentInvoice(contract.contract_id);

      const message = await db('message_log').where({ template_code: 'invoice_sent' }).first();
      assert.match(message?.body ?? '', /^View it online: /);

      const page = await call(server, 'GET', `/portal/invoices/${invoice.token}`);
      assert.equal(page.status, 200);
      assert.equal(page.body.data.can_pay, false);

      const pay = await call(server, 'POST', `/portal/invoices/${invoice.token}/pay`, {
        body: { source_id: OK_NONCE },
      });
      assert.equal(pay.status, 409);
    });

    it('shows the balance with no session, and nothing for a wrong token', async () => {
      await connectSquare();
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const invoice = await sentInvoice(contract.contract_id);

      const page = await call(server, 'GET', `/portal/invoices/${invoice.token}`);
      assert.equal(page.status, 200);
      assert.equal(page.headers.get('cache-control'), 'private, no-store');
      assert.equal(page.body.data.amount_outstanding, '149.50');
      assert.equal(page.body.data.can_pay, true);
      assert.equal(page.body.data.payment.application_id, 'sandbox-sq0idb-suite');
      assert.match(page.body.data.payment.sdk_url, /^https:\/\/sandbox\.web\.squarecdn\.com\//);
      assert.equal(page.body.data.payment.access_token, undefined);

      const wrong = await call(server, 'GET', `/portal/invoices/${'x'.repeat(32)}`);
      assert.equal(wrong.status, 404);
    });

    it('serves the page itself', async () => {
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const invoice = await sentInvoice(contract.contract_id);
      const response = await fetch(`${server.url}/pay/${invoice.token}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /Square’s secure form/);
    });

    it('hands staff the same link the customer was emailed', async () => {
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const invoice = await sentInvoice(contract.contract_id);
      const reply = await call(server, 'GET', `/invoices/${invoice.id}/pay-link`, { token: corporate });
      assert.equal(reply.body.data.url, `${config.messaging.appBaseUrl}/pay/${invoice.token}`);
    });
  });

  describe('paying from the link', () => {
    it('takes the balance worked out on the server, and books it', async () => {
      await connectSquare();
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const invoice = await sentInvoice(contract.contract_id);

      const reply = await call(server, 'POST', `/portal/invoices/${invoice.token}/pay`, {
        // An amount from the page is ignored; it is not in the schema at all.
        body: { source_id: OK_NONCE, amount: 1 },
      });

      assert.equal(reply.status, 200);
      assert.equal(reply.body.data.receipt.amount, '149.50');
      assert.equal(reply.body.data.invoice.status, 'paid');

      const sent = square.requests.find((r) => r.path === '/v2/payments');
      assert.deepEqual(sent?.body.amount_money, { amount: 14950, currency: 'CAD' });
      assert.equal(sent?.body.location_id, SQUARE_LOCATION);
      assert.equal(sent?.body.reference_id, invoice.id);
      assert.ok((sent?.body.idempotency_key as string).length <= 45, 'within Square’s key limit');

      const payment = await db('payments').where({ invoice_id: invoice.id }).first();
      assert.equal(payment?.method, 'online');
      assert.equal(payment?.provider, 'square');
      assert.equal(payment?.status, 'succeeded');
    });

    it('will not take the same bill twice', async () => {
      await connectSquare();
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const invoice = await sentInvoice(contract.contract_id);

      const [first, second] = await Promise.all([
        call(server, 'POST', `/portal/invoices/${invoice.token}/pay`, { body: { source_id: 'cnon:one' } }),
        call(server, 'POST', `/portal/invoices/${invoice.token}/pay`, { body: { source_id: 'cnon:two' } }),
      ]);

      assert.deepEqual([first.status, second.status].sort(), [200, 409]);
      const rows = await db('payments').where({ invoice_id: invoice.id });
      assert.equal(rows.length, 1);
    });

    it('tells the customer about a decline, and books nothing', async () => {
      await connectSquare();
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const invoice = await sentInvoice(contract.contract_id);

      const reply = await call(server, 'POST', `/portal/invoices/${invoice.token}/pay`, {
        body: { source_id: DECLINED_NONCE },
      });

      assert.equal(reply.status, 402);
      assert.equal(reply.body.error.message, 'The card was declined');
      assert.equal((await db('payments').where({ invoice_id: invoice.id })).length, 0);
      assert.equal(
        (await db('message_log').where({ template_code: 'payment_failed_internal' })).length,
        0,
        'the office is not emailed about a mistyped card',
      );
    });

    it('slows down someone trying card after card', async () => {
      await connectSquare();
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const invoice = await sentInvoice(contract.contract_id);

      let last = 0;
      for (let i = 0; i < 11; i += 1) {
        const reply = await call(server, 'POST', `/portal/invoices/${invoice.token}/pay`, {
          body: { source_id: DECLINED_NONCE },
        });
        last = reply.status;
      }
      assert.equal(last, 429);
    });
  });

  describe('saving a card with the signed autopay agreement', () => {
    async function askForCard() {
      await connectSquare();
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const asked = await call(server, 'POST', '/card-setups', {
        token: corporate,
        body: { contract_id: contract.contract_id },
      });
      assert.equal(asked.status, 201);
      const token = new URL(asked.body.data.url).pathname.split('/').pop() ?? '';
      return { contract, token, url: asked.body.data.url as string };
    }

    it('sends the customer to our page with Square’s form on it', async () => {
      const { url, contract } = await askForCard();
      assert.match(url, /\/pay\/card\/sqs_[A-Za-z0-9_-]{32}$/);
      const customer = await db('customers').where({ id: contract.customer_id }).first();
      assert.match(customer?.square_customer_id ?? '', /^SQCUS/);
    });

    it('shows a one-year agreement above the signature box', async () => {
      const { token } = await askForCard();
      const page = await call(server, 'GET', `/portal/cards/${token}`);

      assert.equal(page.status, 200);
      const agreement = page.body.data.agreement;
      assert.equal(agreement.starts_on, isoToday());
      assert.equal(agreement.ends_on, '2027-03-31');
      assert.match(agreement.text, /authorize Kingston to charge the card/);
      assert.ok(agreement.text.includes(agreement.ends_on));
    });

    it('will not save a card without a signature', async () => {
      const { token } = await askForCard();
      const reply = await call(server, 'POST', `/portal/cards/${token}`, {
        body: { source_id: OK_NONCE, signer_name: 'Harold Bell', signature_png: 'data:image/png;base64,AAAA' },
      });
      assert.equal(reply.status, 400);
      assert.ok(square.requests.every((r) => r.path !== '/v2/cards'), 'Square is never asked');
    });

    it('stores the card, the signature and the exact words signed, together', async () => {
      const { token, contract } = await askForCard();
      const reply = await call(server, 'POST', `/portal/cards/${token}`, {
        body: { source_id: OK_NONCE, signer_name: 'Harold Bell', signature_png: SIGNATURE },
      });

      assert.equal(reply.status, 200);
      assert.equal(reply.body.data.status, 'completed');
      assert.equal(reply.body.data.card.last4, '1111');

      const stored = await db('contracts').where({ id: contract.contract_id }).first();
      assert.match(stored?.payment_method_token ?? '', /^ccof:/);
      assert.equal(stored?.payment_method_provider, 'square');
      assert.equal(stored?.autopay_signer_name, 'Harold Bell');
      assert.match(stored?.autopay_terms ?? '', /authorize Kingston/);
      const expires = new Date();
      expires.setUTCFullYear(expires.getUTCFullYear() + 1);
      assert.equal(stored?.autopay_expires_on, expires.toISOString().slice(0, 10));

      const box = await db('contract_checklist_items')
        .where({ contract_id: contract.contract_id, item_code: 'card_on_file' })
        .first();
      assert.equal(box?.checked, true);

      // Staff can open the signature, as they can the one taken at the door.
      const file = await fetch(`${server.url}/files/${stored?.autopay_signature_url}`, {
        headers: { Authorization: `Bearer ${corporate}` },
      });
      assert.equal(file.status, 200);
      assert.equal(file.headers.get('content-type'), 'image/png');

      const audit = await db('audit_log').where({ action: 'contract.autopay_authorized' }).first();
      assert.equal(audit?.entity_id, contract.contract_id);

      const again = await call(server, 'POST', `/portal/cards/${token}`, {
        body: { source_id: OK_NONCE, signer_name: 'Harold Bell', signature_png: SIGNATURE },
      });
      assert.equal(again.status, 409, 'one link, one card');
    });

    it('keeps no signature for a card Square declined', async () => {
      const { token, contract } = await askForCard();
      const reply = await call(server, 'POST', `/portal/cards/${token}`, {
        body: { source_id: DECLINED_NONCE, signer_name: 'Harold Bell', signature_png: SIGNATURE },
      });
      assert.equal(reply.status, 402);
      const stored = await db('contracts').where({ id: contract.contract_id }).first();
      assert.equal(stored?.autopay_signed_at, null);
      assert.equal(stored?.payment_method_token, null);
    });

    it('charges the saved card through Square, until the signed year is up', async () => {
      const { token, contract } = await askForCard();
      await call(server, 'POST', `/portal/cards/${token}`, {
        body: { source_id: OK_NONCE, signer_name: 'Harold Bell', signature_png: SIGNATURE },
      });

      const first = await sentInvoice(contract.contract_id);
      const charged = await call(server, 'POST', `/invoices/${first.id}/charge`, { token: corporate });
      assert.equal(charged.status, 200);
      assert.equal(charged.body.data.status, 'paid');
      const payment = square.requests.filter((r) => r.path === '/v2/payments').pop();
      assert.match(payment?.body.source_id ?? '', /^ccof:/);

      await db('contracts')
        .where({ id: contract.contract_id })
        .update({ autopay_expires_on: '2020-01-01' });
      const second = await sentInvoice(contract.contract_id, 99, '02');
      const refused = await call(server, 'POST', `/invoices/${second.id}/charge`, { token: corporate });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error.message, /autopay authorization ended/);
    });
  });

  describe('after the money is in', () => {
    async function paidOnline() {
      await connectSquare();
      const contract = await makeContract(world.branches.kingston, world.users.operator);
      const invoice = await sentInvoice(contract.contract_id);
      await call(server, 'POST', `/portal/invoices/${invoice.token}/pay`, { body: { source_id: OK_NONCE } });
      const payment = await db('payments').where({ invoice_id: invoice.id }).first();
      assert.ok(payment, 'the online payment was booked');
      return { invoice, payment };
    }

    function signed(payload: string): Record<string, string> {
      const signature = createHmac('sha256', WEBHOOK_KEY)
        .update(`${config.messaging.appBaseUrl}/webhooks/square${payload}`)
        .digest('base64');
      return { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': signature };
    }

    it('refunds through Square, not just on paper', async () => {
      const { invoice, payment } = await paidOnline();
      const reply = await call(server, 'POST', `/payments/${payment.id}/refund`, { token: corporate });

      assert.equal(reply.status, 200);
      const refund = square.requests.find((r) => r.path === '/v2/refunds');
      assert.equal(refund?.body.payment_id, payment.provider_transaction_id);
      assert.deepEqual(refund?.body.amount_money, { amount: 14950, currency: 'CAD' });

      const after = await db('invoices').where({ id: invoice.id }).first();
      assert.equal(after?.amount_paid, '0.00');
    });

    it('books a refund made in the Square Dashboard', async () => {
      const { invoice, payment } = await paidOnline();
      const payload = JSON.stringify({
        event_id: 'evt-1',
        type: 'refund.updated',
        data: { type: 'refund', id: 'r1', object: { refund: { payment_id: payment.provider_transaction_id, status: 'COMPLETED' } } },
      });

      const reply = await call(server, 'POST', '/webhooks/square', { headers: signed(payload), raw: payload });
      assert.equal(reply.status, 200);

      const row = await db('payments').where({ id: payment.id }).first();
      assert.equal(row?.status, 'refunded');
      const after = await db('invoices').where({ id: invoice.id }).first();
      assert.equal(after?.status, 'sent');
    });

    it('refuses a webhook that is not signed with the saved key', async () => {
      await connectSquare();
      const payload = JSON.stringify({ event_id: 'e', type: 'refund.updated', data: { object: {} } });
      const unsigned = await call(server, 'POST', '/webhooks/square', {
        headers: { 'Content-Type': 'application/json' },
        raw: payload,
      });
      assert.equal(unsigned.status, 400);

      const forged = await call(server, 'POST', '/webhooks/square', {
        headers: { 'Content-Type': 'application/json', 'x-square-hmacsha256-signature': 'AAAA' },
        raw: payload,
      });
      assert.equal(forged.status, 400);
    });
  });
});
