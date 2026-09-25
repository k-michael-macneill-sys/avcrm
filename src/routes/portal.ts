import { Router } from 'express';
import { z } from 'zod';
import { rateLimit } from '../middleware/rateLimit';
import {
  getPortalCardSetup,
  getPortalInvoice,
  payPortalInvoice,
  saveCardFromPortal,
} from '../services/portal';
import { asyncHandler } from '../utils/async';
import { parse } from '../utils/validate';

/**
 * The customer's side: no session, because the customer has no account. The
 * random token in the link is the capability, and each token only ever
 * reaches its own bill or its own card request.
 *
 * Responses are `no-store`: they name a customer and what they owe.
 */
export const portalRouter = Router();

const tokenSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{20,80}$/, 'That link is not valid'),
});

const cardSchema = z.object({
  source_id: z.string().trim().min(1).max(500),
  verification_token: z.string().trim().min(1).max(2000).nullable().default(null),
});

const signedCardSchema = cardSchema.extend({
  signer_name: z.string().trim().min(2, 'Type your name as you signed it').max(120),
  signature_png: z.string().min(1, 'Please sign in the box').max(1_000_000),
});

/**
 * A public form that takes cards is exactly what card testers look for, so
 * failures are counted per address. Success is forgiven: a customer who pays
 * is not the problem.
 */
const payLimiter = rateLimit({
  name: 'portal-pay-ip',
  windowMs: 15 * 60 * 1000,
  max: 10,
  key: (req) => req.ip ?? null,
  message: 'Too many attempts from here. Please wait a few minutes and try again.',
});

portalRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

portalRouter.get(
  '/invoices/:token',
  asyncHandler(async (req, res) => {
    const { token } = parse(tokenSchema, req.params);
    res.json({ data: await getPortalInvoice(token) });
  }),
);

portalRouter.post(
  '/invoices/:token/pay',
  payLimiter,
  asyncHandler(async (req, res) => {
    const { token } = parse(tokenSchema, req.params);
    const body = parse(cardSchema, req.body);
    res.json({ data: await payPortalInvoice(token, body, req.ip ?? null) });
  }),
);

portalRouter.get(
  '/cards/:token',
  asyncHandler(async (req, res) => {
    const { token } = parse(tokenSchema, req.params);
    res.json({ data: await getPortalCardSetup(token) });
  }),
);

portalRouter.post(
  '/cards/:token',
  payLimiter,
  asyncHandler(async (req, res) => {
    const { token } = parse(tokenSchema, req.params);
    const body = parse(signedCardSchema, req.body);
    res.json({ data: await saveCardFromPortal(token, body, req.ip ?? null) });
  }),
);
