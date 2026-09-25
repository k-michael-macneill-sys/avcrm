import express, { Router } from 'express';
import { completeSetup } from '../services/cards';
import { gateway } from '../services/gateway';
import {
  handleIncomingWebhook,
  verifyMetaSignature,
  verifyWebhookChallenge,
} from '../services/metaMessaging';
import { reconcilePayment } from '../services/payments';
import { asyncHandler } from '../utils/async';
import { badRequest } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * What the processor tells us after the fact.
 *
 * This is unauthenticated HTTP from the internet, so the signature is the
 * only thing that makes it trustworthy — which is why the body has to stay a
 * raw Buffer. The parser is mounted here rather than globally, and this
 * router is mounted before express.json in app.ts for the same reason: once
 * the body has been parsed and re-serialised the signature no longer matches.
 *
 * Every handler is idempotent, keyed on the processor's own ids, because a
 * webhook that is delivered twice is normal rather than exceptional.
 */
export const webhooksRouter = Router();

webhooksRouter.post(
  '/stripe',
  express.raw({ type: 'application/json', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const event = gateway.verifyWebhook(
      req.body as Buffer,
      req.header('stripe-signature'),
    );

    logger.info({ event_id: event.id, type: event.type }, 'Webhook received');

    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded': {
        const sessionId = String(event.data.id ?? '');
        if (sessionId) await completeSetup(sessionId);
        break;
      }

      case 'payment_intent.succeeded': {
        await reconcilePayment(String(event.data.id ?? ''), 'succeeded', null);
        break;
      }

      case 'payment_intent.payment_failed': {
        const error = event.data.last_payment_error as
          | { message?: string }
          | undefined;
        await reconcilePayment(
          String(event.data.id ?? ''),
          'failed',
          error?.message ?? 'The card was declined',
        );
        break;
      }

      case 'charge.refunded': {
        const intent = event.data.payment_intent;
        if (typeof intent === 'string') {
          await reconcilePayment(intent, 'refunded', null);
        }
        break;
      }

      default:
        // Stripe sends far more than this cares about; acknowledging keeps it
        // from retrying something we will never act on.
        logger.debug({ type: event.type }, 'Webhook ignored');
    }

    // A 200 is the acknowledgement. Anything else and it comes back.
    res.json({ received: true });
  }),
);

/**
 * Meta's one-time handshake, when the webhook is subscribed in the app
 * dashboard: echo the challenge back as plain text, or refuse.
 */
webhooksRouter.get('/meta', (req, res, next) => {
  try {
    const challenge = verifyWebhookChallenge(req.query as Record<string, unknown>);
    res.type('text/plain').send(challenge);
  } catch (err) {
    next(err);
  }
});

/**
 * Facebook Page and Instagram direct messages. Signed with the app secret
 * over the raw body, like Stripe's; stored idempotently on Meta's message id,
 * because Meta redelivers anything it did not get a 200 for.
 */
webhooksRouter.post(
  '/meta',
  express.raw({ type: 'application/json', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    verifyMetaSignature(raw, req.header('x-hub-signature-256'));

    let payload: unknown;
    try {
      payload = JSON.parse(raw.toString('utf8'));
    } catch {
      throw badRequest('Webhook body is not JSON');
    }

    const summary = await handleIncomingWebhook(payload);
    logger.info(summary, 'Meta webhook received');

    res.type('text/plain').send('EVENT_RECEIVED');
  }),
);
