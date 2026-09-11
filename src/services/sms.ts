import { randomUUID } from 'node:crypto';
import { config } from '../config';
import { logger } from '../utils/logger';
import { badRequest } from '../utils/errors';
import {
  readIntegration,
  resolveValues,
  SMS_KEY,
} from './integrations';
import { readMessageId, smsProvider, type ProviderDefinition } from './smsProviders';
import { SendFailure, type SendResult } from './transport';

/**
 * How a text message leaves the building.
 *
 * Unlike mail there is no SMTP for SMS — every gateway has its own HTTP API —
 * so rather than pick one for the company, the provider is configured by an
 * administrator in the settings screen and this file is the thing that reads
 * that configuration and makes the call. Changing provider is a form, not a
 * release.
 *
 * Nothing is sent until an administrator switches it on. Until then this logs
 * what it would have sent, which is exactly what the previous mock did — the
 * difference is that the mock can now be replaced without touching code.
 */

const TIMEOUT_MS = 15_000;

/**
 * Points a provider's request at SMS_API_BASE instead of its real host, so
 * the driver can be run against a stand-in. The path is left alone — that is
 * what carries the provider's own shape, which is the part worth testing.
 */
function retarget(url: string): string {
  if (!config.sms.apiBase) return url;
  const target = new URL(url);
  const base = new URL(config.sms.apiBase);
  target.protocol = base.protocol;
  target.host = base.host;
  return target.toString();
}

/** SMS_REDIRECT_TO, for the same reason MAIL_REDIRECT_TO exists. */
function recipientFor(to: string, body: string): { to: string; body: string } {
  if (!config.sms.redirectTo) return { to, body };
  return {
    to: config.sms.redirectTo,
    // The real recipient has to survive the redirect or the copy is useless.
    body: `[to: ${to}] ${body}`,
  };
}

/**
 * Whether another attempt could work.
 *
 * A 4xx is the gateway saying the number is wrong or the credential is not
 * accepted, and no amount of retrying changes either. 408, 425 and 429 are
 * timing, not judgement, and 5xx is their problem — all worth another go, as
 * is a connection that never opened.
 */
function classifyStatus(status: number, message: string): SendFailure {
  const temporary = status === 408 || status === 425 || status === 429 || status >= 500;
  return new SendFailure(message, !temporary, String(status));
}

async function post(
  request: { url: string; headers: Record<string, string>; body: string },
): Promise<{ status: number; text: string }> {
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: request.body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return { status: response.status, text: await response.text() };
  } catch (err) {
    // Never reached the gateway: DNS, refused, or timed out. Always worth
    // another go — the message may well be fine.
    throw new SendFailure(
      err instanceof Error ? err.message : 'The SMS gateway could not be reached',
      false,
      'unreachable',
    );
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/**
 * The gateway's own words, trimmed. A provider that answers with an HTML
 * error page would otherwise put a whole document in the log row.
 */
function reason(payload: unknown, text: string, status: number): string {
  const fromBody =
    payload && typeof payload === 'object'
      ? ((payload as Record<string, unknown>).message
          ?? (payload as Record<string, unknown>).error_text
          ?? (payload as Record<string, unknown>).description)
      : null;

  const detail = typeof fromBody === 'string' && fromBody ? fromBody : text.trim();
  return detail ? `${status}: ${detail.slice(0, 300)}` : `The gateway answered ${status}`;
}

export interface DeliverOptions {
  /**
   * Sends through a configured provider that has not been switched on yet.
   * That is the whole point of the test button on the settings screen.
   */
  ignoreEnabled?: boolean;
}

export async function deliverSms(
  to: string,
  body: string,
  options: DeliverOptions = {},
): Promise<SendResult> {
  const row = await readIntegration(SMS_KEY);
  const provider: ProviderDefinition | null = row ? smsProvider(row.provider) : null;
  const live = Boolean(row && provider && (row.is_enabled || options.ignoreEnabled));

  if (!row || !provider || !live) {
    if (options.ignoreEnabled) {
      throw badRequest(
        'No SMS provider is configured. Pick one and save it before sending a test.',
      );
    }
    // The old mock's behaviour, kept deliberately: an install with no SMS
    // account queues, renders and logs everything, and simply does not send.
    const redirected = recipientFor(to, body);
    logger.warn(
      { channel: 'sms', to: redirected.to, body: redirected.body },
      'SMS not sent: no provider is switched on',
    );
    return { provider_message_id: `unsent-sms-${randomUUID()}` };
  }

  const values = resolveValues(row);
  const target = recipientFor(to, body);
  const message = { to: target.to, from: values.from ?? '', body: target.body };
  const request = provider.build(values, message);

  if (!request.url) {
    throw new SendFailure('The SMS provider has no endpoint configured', true, 'misconfigured');
  }

  const { status, text } = await post({ ...request, url: retarget(request.url) });
  const payload = parse(text);

  if (status < 200 || status >= 300) {
    throw classifyStatus(status, reason(payload, text, status));
  }

  // A gateway that answers 200 and refuses in the body — Vonage does this.
  const refused = provider.bodyError?.(payload) ?? null;
  if (refused) {
    throw new SendFailure(refused, true, 'rejected');
  }

  return {
    provider_message_id:
      readMessageId(provider, values, payload) ?? `${provider.id}-${randomUUID()}`,
  };
}
