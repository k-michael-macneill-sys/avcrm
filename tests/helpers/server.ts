import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { createApp } from '../../src/app';

/**
 * The real app over a real socket.
 *
 * Not supertest and not a mocked request object: the things most worth testing
 * here are middleware-shaped — the branch scope resolved from a token, the raw
 * body a webhook signature is computed over, a PDF's content type — and those
 * only behave truthfully when an actual HTTP request goes through the actual
 * stack. Port 0 lets the OS pick, so suites can run side by side.
 */

export interface TestServer {
  url: string;
  close: () => Promise<void>;
}

export async function startServer(): Promise<TestServer> {
  const server: Server = createApp().listen(0);
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

export interface Reply<T = unknown> {
  status: number;
  body: T;
  headers: Headers;
}

export interface CallOptions {
  token?: string | null;
  body?: unknown;
  headers?: Record<string, string>;
  /** For the webhook tests, where the bytes matter more than the JSON. */
  raw?: string;
}

/** One call, with the envelope already unwrapped. */
export async function call<T = any>(
  server: TestServer,
  method: string,
  path: string,
  options: CallOptions = {},
): Promise<Reply<T>> {
  const headers: Record<string, string> = { ...options.headers };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined && !headers['Content-Type']) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(`${server.url}${path}`, {
    method,
    headers,
    // Manual, so a 302 is something a test can assert on rather than
    // something fetch quietly follows out to the public internet.
    redirect: 'manual',
    body:
      options.raw !== undefined
        ? options.raw
        : options.body === undefined
          ? undefined
          : JSON.stringify(options.body),
  });

  const text = await response.text();
  let body: unknown = text;
  if (response.headers.get('content-type')?.includes('application/json')) {
    body = text ? JSON.parse(text) : null;
  }

  return { status: response.status, body: body as T, headers: response.headers };
}

/** A signed-in caller, which most tests need before anything else. */
export async function login(
  server: TestServer,
  email: string,
  password = 'Password123!',
): Promise<string> {
  const reply = await call<{ data: { token: string } }>(server, 'POST', '/auth/login', {
    body: { email, password },
  });
  if (reply.status !== 200) {
    throw new Error(`Login failed for ${email}: ${reply.status} ${JSON.stringify(reply.body)}`);
  }
  return reply.body.data.token;
}

/**
 * Waits for something the application does on purpose without being awaited.
 *
 * The completion notice is queued after the response goes back, so the
 * operator's phone is not held up by it. A test that read the queue straight
 * after the call would be testing the scheduler, not the behaviour — so it
 * polls, briefly, and fails with a real message rather than a timeout.
 */
export async function eventually<T>(
  what: string,
  check: () => Promise<T | null | undefined | false>,
  timeoutMs = 2000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;

  while (Date.now() < deadline) {
    last = await check();
    if (last) return last as T;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for ${what}`);
}
