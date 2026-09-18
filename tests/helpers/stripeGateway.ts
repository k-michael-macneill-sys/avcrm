import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/**
 * A stand-in for the Stripe API.
 *
 * The real SDK connects to this and genuinely builds, signs and parses every
 * request — only the far end is fake. It implements the handful of endpoints
 * this application calls, in Stripe's own response shapes, including the 402
 * card_error that a decline actually produces.
 *
 * Behaviour is chosen by the payment method id, the way Stripe's own test
 * cards work: pm_card_declined is refused, anything else succeeds.
 */

export interface FakeStripe {
  url: string;
  close: () => Promise<void>;
}

const id = (prefix: string): string =>
  `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 24)}`;

export async function startStripe(): Promise<FakeStripe> {
  /** Sessions handed out, so a retrieve can answer consistently. */
  const sessions = new Map<string, { setupIntentId: string; paymentMethod: string }>();

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const json = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload);
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(text),
          'Request-Id': id('req'),
        });
        res.end(text);
      };

      const body = Object.fromEntries(new URLSearchParams(raw));
      const path = (req.url ?? '').split('?')[0] ?? '';

      if (req.method === 'POST' && path === '/v1/customers') {
        return json(200, {
          id: id('cus'),
          object: 'customer',
          email: body.email ?? null,
          name: body.name ?? null,
        });
      }

      if (req.method === 'POST' && path === '/v1/checkout/sessions') {
        const sessionId = id('cs_test');
        const setupIntentId = id('seti');
        const paymentMethod =
          body['metadata[avcrm_force_decline]'] === 'true' ? 'pm_card_declined' : id('pm');

        sessions.set(sessionId, { setupIntentId, paymentMethod });
        return json(200, {
          id: sessionId,
          object: 'checkout.session',
          mode: 'setup',
          customer: body.customer,
          url: `https://checkout.stripe.test/c/pay/${sessionId}`,
          expires_at: Math.floor(Date.now() / 1000) + 86_400,
          setup_intent: setupIntentId,
        });
      }

      const sessionMatch = /^\/v1\/checkout\/sessions\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && sessionMatch) {
        const session = sessions.get(sessionMatch[1] ?? '');
        if (!session) {
          return json(404, {
            error: { type: 'invalid_request_error', message: 'No such session' },
          });
        }
        return json(200, {
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

      const methodMatch = /^\/v1\/payment_methods\/([^/]+)$/.exec(path);
      if (req.method === 'GET' && methodMatch) {
        return json(200, {
          id: methodMatch[1],
          object: 'payment_method',
          type: 'card',
          card: { brand: 'visa', last4: '4242', exp_month: 12, exp_year: 2030 },
        });
      }

      if (req.method === 'POST' && path === '/v1/payment_intents') {
        const intentId = id('pi');
        if (body.payment_method === 'pm_card_declined') {
          // Exactly what Stripe returns for a declined off-session charge.
          return json(402, {
            error: {
              type: 'card_error',
              code: 'card_declined',
              decline_code: 'insufficient_funds',
              message: 'Your card has insufficient funds.',
              payment_intent: {
                id: intentId,
                object: 'payment_intent',
                status: 'requires_payment_method',
              },
            },
          });
        }
        return json(200, {
          id: intentId,
          object: 'payment_intent',
          status: 'succeeded',
          amount: Number(body.amount),
          currency: body.currency,
        });
      }

      if (req.method === 'POST' && path === '/v1/refunds') {
        return json(200, {
          id: id('re'),
          object: 'refund',
          payment_intent: body.payment_intent,
          amount: Number(body.amount),
          status: 'succeeded',
        });
      }

      json(404, {
        error: { type: 'invalid_request_error', message: `Unhandled ${req.method} ${path}` },
      });
    });
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
