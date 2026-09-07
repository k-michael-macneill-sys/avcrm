import { logger } from '../utils/logger';

/**
 * MOCK. Email and SMS are logged, not sent. Replace the bodies when a provider
 * is chosen; callers should not need to change.
 */
export async function sendEmail(to: string, subject: string, body: string): Promise<void> {
  logger.info({ mock: true, channel: 'email', to, subject, body }, 'Mock email');
}

export async function sendSms(to: string, body: string): Promise<void> {
  logger.info({ mock: true, channel: 'sms', to, body }, 'Mock SMS');
}
