/*
 * A stand-in for the Stripe API, so the integration is verified by talking to
 * something rather than by trusting that it would.
 *
 *   node scripts/stripe-fake.js <port>
 *
 * The real SDK connects to this and really builds, signs and parses the
 * requests — only the far end is fake. It implements the handful of endpoints
 * this application calls, in Stripe's own response shapes, including the 402
 * card_error that a decline actually produces.
 *
 * Card behaviour is chosen by the payment method id:
 *   pm_card_declined  -> declined with a 402
 *   anything else     -> succeeds
 */
const http = require('node:http');
const { randomUUID } = require('node:crypto');

const port = Number(process.argv[2] ?? 12111);
const id = (prefix) => `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

const json = (res, status, body) => {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Request-Id': id('req'),
  });
  res.end(payload);
};

// Sessions we have handed out, so a retrieve can answer consistently.
const sessions = new Map();

const server = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (chunk) => (raw += chunk));
  req.on('end', () => {
    const body = Object.fromEntries(new URLSearchParams(raw));
    const [path] = req.url.split('?');

    // POST /v1/customers
    if (req.method === 'POST' && path === '/v1/customers') {
      return json(res, 200, {
        id: id('cus'),
        object: 'customer',
        email: body.email ?? null,
        name: body.name ?? null,
      });
    }

    // POST /v1/checkout/sessions
    if (req.method === 'POST' && path === '/v1/checkout/sessions') {
      const sessionId = id('cs_test');
      const setupIntentId = id('seti');
      const paymentMethod =
        body['metadata[avcrm_force_decline]'] === 'true'
          ? 'pm_card_declined'
          : id('pm');

      sessions.set(sessionId, { setupIntentId, paymentMethod });
      return json(res, 200, {
        id: sessionId,
        object: 'checkout.session',
        mode: 'setup',
        customer: body.customer,
        url: `https://checkout.stripe.test/c/pay/${sessionId}`,
        expires_at: Math.floor(Date.now() / 1000) + 86_400,
        setup_intent: setupIntentId,
      });
    }

    // GET /v1/checkout/sessions/:id
    const sessionMatch = path.match(/^\/v1\/checkout\/sessions\/([^/]+)$/);
    if (req.method === 'GET' && sessionMatch) {
      const session = sessions.get(sessionMatch[1]);
      if (!session) {
        return json(res, 404, {
          error: { type: 'invalid_request_error', message: 'No such session' },
        });
      }
      return json(res, 200, {
        id: sessionMatch[1],
        object: 'checkout.session',
        mode: 'setup',
        // The service asks for this expanded, which is what it gets.
        setup_intent: {
          id: session.setupIntentId,
          object: 'setup_intent',
          status: 'succeeded',
          payment_method: session.paymentMethod,
        },
      });
    }

    // GET /v1/payment_methods/:id
    const methodMatch = path.match(/^\/v1\/payment_methods\/([^/]+)$/);
    if (req.method === 'GET' && methodMatch) {
      return json(res, 200, {
        id: methodMatch[1],
        object: 'payment_method',
        type: 'card',
        card: {
          brand: methodMatch[1] === 'pm_card_declined' ? 'mastercard' : 'visa',
          last4: methodMatch[1] === 'pm_card_declined' ? '0002' : '4242',
        },
      });
    }

    // POST /v1/payment_intents
    if (req.method === 'POST' && path === '/v1/payment_intents') {
      const intentId = id('pi');
      if (body.payment_method === 'pm_card_declined') {
        // Exactly what Stripe returns for a declined off-session charge.
        return json(res, 402, {
          error: {
            type: 'card_error',
            code: 'card_declined',
            decline_code: 'insufficient_funds',
            message: 'Your card has insufficient funds.',
            payment_intent: { id: intentId, object: 'payment_intent', status: 'requires_payment_method' },
          },
        });
      }
      return json(res, 200, {
        id: intentId,
        object: 'payment_intent',
        status: 'succeeded',
        amount: Number(body.amount),
        currency: body.currency,
      });
    }

    // POST /v1/refunds
    if (req.method === 'POST' && path === '/v1/refunds') {
      return json(res, 200, {
        id: id('re'),
        object: 'refund',
        payment_intent: body.payment_intent,
        amount: Number(body.amount),
        status: 'succeeded',
      });
    }

    json(res, 404, {
      error: { type: 'invalid_request_error', message: `Unhandled ${req.method} ${path}` },
    });
  });
});

server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`stripe stand-in listening on ${port}\n`);
});
