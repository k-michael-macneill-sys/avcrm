import express, { Router } from 'express';
import { squareGateway } from '../services/gateway';
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

/**
 * Square's notifications. A payment taken from the invoice link is booked
 * the moment Square answers, so these matter for what happens afterwards:
 * a payment that settles later, and a refund made in the Square Dashboard
 * rather than here.
 *
 * Checked against the stored signature key even when Square is switched off,
 * because money already taken through it still has to reconcile.
 */
webhooksRouter.post(
  '/square',
  express.raw({ type: 'application/json', limit: '1mb' }),
  asyncHandler(async (req, res) => {
    const square = await squareGateway();
    if (!square) {
      throw badRequest('Square is not connected');
    }

    const event = square.verifyWebhook(
      req.body as Buffer,
      req.header('x-square-hmacsha256-signature'),
    );

    logger.info({ event_id: event.id, type: event.type }, 'Square webhook received');

    switch (event.type) {
      case 'payment.created':
      case 'payment.updated': {
        const payment = event.data.payment as { id?: string; status?: string } | undefined;
        if (!payment?.id) break;
        if (payment.status === 'COMPLETED') {
          await reconcilePayment(payment.id, 'succeeded', null);
        } else if (payment.status === 'FAILED' || payment.status === 'CANCELED') {
          await reconcilePayment(payment.id, 'failed', 'The payment was not completed');
        }
        break;
      }

      case 'refund.created':
      case 'refund.updated': {
        const refund = event.data.refund as { payment_id?: string; status?: string } | undefined;
        if (refund?.payment_id && refund.status === 'COMPLETED') {
          await reconcilePayment(refund.payment_id, 'refunded', null);
        }
        break;
      }

      default:
        logger.debug({ type: event.type }, 'Square webhook ignored');
    }

    res.json({ received: true });
  }),
);
