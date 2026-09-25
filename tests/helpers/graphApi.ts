import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for Meta's Graph API: just POST /v19.0/me/messages, with the
 * bearer token checked and Meta's own error shape on the way back.
 *
 * The recipient chooses the outcome, the way the SMS stand-in does it:
 *
 *   outside-window -> code 10 / subcode 2018278, the 24-hour rule (permanent)
 *   rate-limited   -> code 4, too many calls (temporary)
 *   down           -> 503 (temporary)
 */

export interface GraphSend {
  token: string;
  recipient: string;
  messaging_type: string;
  text: string;
}

export interface FakeGraphApi {
  /** What META_GRAPH_API_BASE should be. */
  url: string;
  sent: () => GraphSend[];
  /** The mid the next successful send answers with. */
  nextMid: (mid: string) => void;
  clear: () => void;
  close: () => Promise<void>;
}

export async function startGraphApi(): Promise<FakeGraphApi> {
  const sent: GraphSend[] = [];
  let counter = 0;
  let presetMid: string | null = null;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const json = (status: number, body: unknown): void => {
        const payload = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(payload);
      };
      const graphError = (status: number, code: number, message: string, subcode?: number) =>
        json(status, {
          error: { message, type: 'OAuthException', code, error_subcode: subcode, fbtrace_id: 'fake' },
        });

      if (req.method !== 'POST' || req.url !== '/v19.0/me/messages') {
        return json(404, { error: { message: `Unhandled ${req.method} ${req.url}`, code: 803 } });
      }

      const auth = req.headers.authorization ?? '';
      if (!auth.startsWith('Bearer ') || auth.length <= 'Bearer '.length) {
        return graphError(400, 190, 'Invalid OAuth access token');
      }

      let body: { recipient?: { id?: string }; messaging_type?: string; message?: { text?: string } };
      try {
        body = JSON.parse(raw || '{}');
      } catch {
        return graphError(400, 100, 'Invalid JSON');
      }

      const recipient = body.recipient?.id ?? '';
      if (recipient === 'outside-window') {
        return graphError(400, 10, 'This message is sent outside of allowed window.', 2018278);
      }
      if (recipient === 'rate-limited') {
        return graphError(400, 4, 'Application request limit reached');
      }
      if (recipient === 'down') {
        return json(503, { error: { message: 'Service temporarily unavailable', code: 1 } });
      }

      sent.push({
        token: auth.slice('Bearer '.length),
        recipient,
        messaging_type: body.messaging_type ?? '',
        text: body.message?.text ?? '',
      });
      counter += 1;
      const mid = presetMid ?? `m_fake_${counter}`;
      presetMid = null;
      return json(200, { recipient_id: recipient, message_id: mid });
    });
  });

  server.listen(0, '127.0.0.1');
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });

  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}/v19.0`,
    sent: () => sent,
    nextMid: (mid) => {
      presetMid = mid;
    },
    clear: () => {
      sent.length = 0;
      counter = 0;
      presetMid = null;
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}
