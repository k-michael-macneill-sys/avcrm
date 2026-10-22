import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A stand-in for the Claude Messages API, just enough for the bookkeeping:
 * it answers every streamed request with the JSON a test sets, as the
 * server-sent events the SDK reads, or with a refusal or an error.
 */

export interface SeenRequest {
  model: string;
  system: string;
  /** The content block types the document arrived as: image, document or text. */
  blocks: string[];
  /** The document's text, when it came as text (a CSV). */
  text: string | null;
  effort: string | null;
  fallbacks: unknown;
  beta: string | null;
  apiKey: string | null;
}

export type Answer = Record<string, unknown> | { refusal: true } | { status: number };
export type Responder = (request: SeenRequest) => Answer;

export interface FakeClaudeApi {
  /** What ANTHROPIC_API_BASE should be. */
  url: string;
  /** Sets the answer for every request from now on. */
  answer: (fn: Responder) => void;
  requests: () => SeenRequest[];
  reset: () => void;
  close: () => Promise<void>;
}

function event(type: string, data: Record<string, unknown>): string {
  return `event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`;
}

export async function startClaudeApi(): Promise<FakeClaudeApi> {
  let responder: Responder = () => ({ status: 500 });
  const seen: SeenRequest[] = [];

  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      if (req.method !== 'POST' || !req.url?.startsWith('/v1/messages')) {
        res.writeHead(404).end();
        return;
      }
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
        model: string;
        system: string;
        messages: { content: { type: string; text?: string }[] }[];
        output_config?: { effort?: string };
        fallbacks?: unknown;
      };
      const content = body.messages[0]?.content ?? [];
      const request: SeenRequest = {
        model: body.model,
        system: body.system,
        blocks: content.map((b) => b.type),
        text: content[0]?.type === 'text' ? (content[0].text ?? null) : null,
        effort: body.output_config?.effort ?? null,
        fallbacks: body.fallbacks,
        beta: (req.headers['anthropic-beta'] as string | undefined) ?? null,
        // The SDK sends the key as a bearer token; older ones used x-api-key.
        apiKey:
          (req.headers['x-api-key'] as string | undefined) ??
          (req.headers.authorization as string | undefined)?.replace(/^Bearer /, '') ??
          null,
      };
      seen.push(request);
      const answer = responder(request);

      if ('status' in answer && typeof answer.status === 'number' && Object.keys(answer).length === 1) {
        res.writeHead(answer.status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: 'api_error', message: 'stand-in failure' } }));
        return;
      }

      const refused = 'refusal' in answer;
      const text = refused ? '' : JSON.stringify(answer);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache' });
      res.write(
        event('message_start', {
          message: {
            id: 'msg_test',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 1200, output_tokens: 1 },
          },
        }),
      );
      if (!refused) {
        res.write(event('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }));
        // In two pieces, the way a real stream arrives.
        const half = Math.floor(text.length / 2);
        res.write(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(0, half) } }));
        res.write(event('content_block_delta', { index: 0, delta: { type: 'text_delta', text: text.slice(half) } }));
        res.write(event('content_block_stop', { index: 0 }));
      }
      res.write(
        event('message_delta', {
          delta: { stop_reason: refused ? 'refusal' : 'end_turn', stop_sequence: null },
          usage: { output_tokens: 200 },
        }),
      );
      res.write(event('message_stop', {}));
      res.end();
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    answer: (fn) => {
      responder = fn;
    },
    requests: () => [...seen],
    reset: () => {
      responder = () => ({ status: 500 });
      seen.length = 0;
    },
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}
