import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';

/**
 * A stand-in for an SMS gateway.
 *
 * It answers on Twilio's, Telnyx's and Vonage's own URL shapes and checks the
 * credential the way they do, so the driver is verified by talking to
 * something rather than by trusting that it would. Only the far end is fake:
 * the application really builds and sends the request.
 *
 * The recipient chooses the outcome, which is how one gateway covers every
 * case a test needs:
 *
 *   ...0400 -> 400, a bad number   (permanent)
 *   ...0503 -> 503, gateway down   (temporary)
 *   ...0200 -> a Vonage-style 200 that is actually a refusal
 */

export interface SentMessage {
  provider: string;
  to: string;
  from: string;
  body: string;
  account?: string;
}

export interface FakeGateway {
  url: string;
  sent: () => SentMessage[];
  clear: () => void;
  close: () => Promise<void>;
}

const id = (prefix: string): string =>
  `${prefix}${randomUUID().replace(/-/g, '').slice(0, 24)}`;

const outcomeFor = (to: string): number | null => {
  if (to.endsWith('0400')) return 400;
  if (to.endsWith('0503')) return 503;
  if (to.endsWith('0200')) return 200;
  return null;
};

export async function startGateway(): Promise<FakeGateway> {
  const sent: SentMessage[] = [];

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const json = (status: number, body: unknown): void => {
        const payload = JSON.stringify(body);
        res.writeHead(status, {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        });
        res.end(payload);
      };

      const [path] = (req.url ?? '').split('?');
      const isJson = (req.headers['content-type'] ?? '').includes('json');

      let body: Record<string, string>;
      try {
        body = isJson
          ? (JSON.parse(raw || '{}') as Record<string, string>)
          : Object.fromEntries(new URLSearchParams(raw));
      } catch {
        return json(400, { message: 'Body was not valid JSON' });
      }

      // Twilio: basic auth, form body, account SID in the path.
      if (req.method === 'POST' && /^\/2010-04-01\/Accounts\/[^/]+\/Messages\.json$/.test(path ?? '')) {
        const auth = req.headers.authorization ?? '';
        if (!auth.startsWith('Basic ')) return json(401, { message: 'Authenticate' });

        const [account, secret] = Buffer.from(auth.slice(6), 'base64').toString().split(':');
        if (!account || !secret) return json(401, { message: 'Authenticate' });

        const to = body.To ?? '';
        const outcome = outcomeFor(to);
        if (outcome === 400) return json(400, { message: "The 'To' number is not valid" });
        if (outcome === 503) return json(503, { message: 'Service unavailable' });

        sent.push({
          provider: 'twilio',
          to,
          from: body.From ?? '',
          body: body.Body ?? '',
          account,
        });
        return json(201, { sid: id('SM'), status: 'queued' });
      }

      // Telnyx: bearer token, JSON body, the id nested under data.
      if (req.method === 'POST' && path === '/v2/messages') {
        if (!(req.headers.authorization ?? '').startsWith('Bearer ')) {
          return json(401, { message: 'Invalid API key' });
        }
        const outcome = outcomeFor(body.to ?? '');
        if (outcome === 400) return json(400, { message: 'Invalid destination' });
        if (outcome === 503) return json(503, { message: 'Service unavailable' });

        sent.push({
          provider: 'telnyx',
          to: body.to ?? '',
          from: body.from ?? '',
          body: body.text ?? '',
        });
        return json(200, { data: { id: id('msg_') } });
      }

      // Vonage: credentials in the body, and a refusal that arrives as a 200.
      if (req.method === 'POST' && path === '/sms/json') {
        const to = body.to ?? '';
        if (outcomeFor(to) === 200) {
          return json(200, { messages: [{ status: '4', 'error-text': 'Bad credentials' }] });
        }
        sent.push({
          provider: 'vonage',
          to,
          from: body.from ?? '',
          body: body.text ?? '',
        });
        return json(200, { messages: [{ status: '0', 'message-id': id('vg') }] });
      }

      // A gateway that is not in the catalogue: the custom provider's target.
      if (req.method === 'POST' && path === '/custom/send') {
        if (req.headers['x-api-key'] !== 'custom-secret') {
          return json(401, { message: 'Bad key' });
        }
        const to = body.destination ?? '';
        const outcome = outcomeFor(to);
        if (outcome === 400) return json(400, { message: 'Unroutable' });
        if (outcome === 503) return json(503, { message: 'Try later' });

        sent.push({
          provider: 'custom',
          to,
          from: body.sender ?? '',
          body: body.message ?? '',
        });
        return json(200, { result: { reference: id('cx') } });
      }

      json(404, { message: `Unhandled ${req.method} ${path}` });
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
    sent: () => sent,
    clear: () => {
      sent.length = 0;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
