import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/**
 * A stand-in for Square's REST API, answering in Square's own shapes —
 * including the error-with-a-payment-attached that a real decline produces.
 *
 * Behaviour is chosen by the nonce, the way Square's sandbox test values
 * work: `cnon:card-nonce-declined` is refused, anything else goes through.
 */

export const SQUARE_TOKEN = 'sq_test_suite_token';
export const SQUARE_LOCATION = 'LOC_TEST';
export const DECLINED_NONCE = 'cnon:card-nonce-declined';

export interface RecordedRequest {
  method: string;
  path: string;
  body: Record<string, any>;
}

export interface FakeSquare {
  url: string;
  requests: RecordedRequest[];
  close: () => Promise<void>;
}

const id = (prefix: string): string => `${prefix}${randomUUID().replace(/-/g, '').slice(0, 20)}`;

export async function startSquare(): Promise<FakeSquare> {
  const requests: RecordedRequest[] = [];
  /** Square replays the original answer for a repeated idempotency key. */
  const seen = new Map<string, { status: number; payload: unknown }>();

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const json = (status: number, payload: unknown): void => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(text);
      };

      const body = raw ? (JSON.parse(raw) as Record<string, any>) : {};
      const path = (req.url ?? '').split('?')[0] ?? '';
      requests.push({ method: req.method ?? '', path, body });

      if (req.headers.authorization !== `Bearer ${SQUARE_TOKEN}`) {
        return json(401, {
          errors: [{ category: 'AUTHENTICATION_ERROR', code: 'UNAUTHORIZED', detail: 'This request could not be authorized.' }],
        });
      }
      if (!req.headers['square-version']) {
        return json(400, { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'MISSING_VERSION' }] });
      }

      const replay = (key: string, status: number, payload: unknown): void => {
        const prior = seen.get(`${path}:${key}`);
        if (prior) return json(prior.status, prior.payload);
        seen.set(`${path}:${key}`, { status, payload });
        return json(status, payload);
      };

      if (req.method === 'GET' && path.startsWith('/v2/locations/')) {
        const location = decodeURIComponent(path.slice('/v2/locations/'.length));
        if (location !== SQUARE_LOCATION) {
          return json(404, { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'NOT_FOUND', detail: 'Location not found.' }] });
        }
        return json(200, { location: { id: location, name: 'Kingston yard', currency: 'CAD', status: 'ACTIVE' } });
      }

      if (req.method === 'POST' && path === '/v2/customers') {
        return replay(body.idempotency_key, 200, {
          customer: { id: id('SQCUS'), given_name: body.given_name, family_name: body.family_name },
        });
      }

      if (req.method === 'POST' && path === '/v2/cards') {
        if (body.source_id === DECLINED_NONCE) {
          return json(400, { errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'CARD_DECLINED', detail: 'Authorization error: CARD_DECLINED' }] });
        }
        const cardId = `ccof:${id('')}`;
        return replay(body.idempotency_key, 200, {
          card: { id: cardId, card_brand: 'VISA', last_4: '1111', customer_id: body.card?.customer_id },
        });
      }

      if (req.method === 'POST' && path === '/v2/payments') {
        const paymentId = id('SQPAY');
        if (body.source_id === DECLINED_NONCE) {
          return replay(body.idempotency_key, 400, {
            errors: [{ category: 'PAYMENT_METHOD_ERROR', code: 'CARD_DECLINED', detail: 'Authorization error: CARD_DECLINED' }],
            payment: { id: paymentId, status: 'FAILED' },
          });
        }
        return replay(body.idempotency_key, 200, {
          payment: {
            id: paymentId,
            status: 'COMPLETED',
            amount_money: body.amount_money,
            reference_id: body.reference_id,
            card_details: { card: { card_brand: 'VISA', last_4: '1111' } },
          },
        });
      }

      if (req.method === 'POST' && path === '/v2/refunds') {
        return replay(body.idempotency_key, 200, {
          refund: { id: id('SQREF'), status: 'PENDING', payment_id: body.payment_id },
        });
      }

      return json(404, { errors: [{ category: 'INVALID_REQUEST_ERROR', code: 'NOT_FOUND', detail: `No route ${path}` }] });
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}
