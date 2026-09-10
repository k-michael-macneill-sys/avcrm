import { randomUUID } from 'node:crypto';
import { logger } from '../utils/logger';

/**
 * MOCK TRANSPORT. Email and SMS are logged, not sent. Replace the bodies when
 * a provider is chosen; callers should not need to change.
 *
 * Nothing in the application calls these directly any more — everything
 * outbound goes through the queue in services/messages.ts, and the worker
 * (npm run job:message-queue) is the only caller. That is what makes
 * message_log a complete record of what the system said to anyone.
 */

export interface SendResult {
  /** The provider's id for the message, recorded against the log row. */
  provider_message_id: string;
}

export async function sendEmail(
  to: string,
  subject: string,
  body: string,
): Promise<SendResult> {
  logger.info({ mock: true, channel: 'email', to, subject, body }, 'Mock email');
  return { provider_message_id: `mock-email-${randomUUID()}` };
}

export async function sendSms(to: string, body: string): Promise<SendResult> {
  logger.info({ mock: true, channel: 'sms', to, body }, 'Mock SMS');
  return { provider_message_id: `mock-sms-${randomUUID()}` };
}
