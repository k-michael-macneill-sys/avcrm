import express, { Router } from 'express';
import { completeSetup } from '../services/cards';
import { gateway } from '../services/gateway';
import { reconcilePayment } from '../services/payments';
import { asyncHandler } from '../utils/async';
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
