import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../db/client';
import { rateLimit } from '../middleware/rateLimit';
import { requestCard } from '../services/cards';
import { leadForToken, optIn, unsubscribe } from '../services/coldEmail';
import { activeGateway } from '../services/gateway';
import { completeInvitation, openInvitation } from '../services/signing';
import { SIGNATURE_BOXES } from '../types/serviceAgreement';
import { asyncHandler } from '../utils/async';
import { ApiError, badRequest } from '../utils/errors';
import { logger } from '../utils/logger';
import { parse } from '../utils/validate';

/**
 * The only routes with no session in front of them besides sign-in. Two
 * kinds: what the browser needs to know before anyone logs in, and the
 * customer's own signing page, where the signed token in the path is the
 * whole of the permission.
 */
export const publicRouter = Router();

/** Nothing here may be secret: it is served to anyone who asks. */
publicRouter.get(
  '/config',
  asyncHandler(async (_req, res) => {
    const gateway = await activeGateway();
    res.json({
      data: {
        card_capture: gateway.canCharge,
        maps_api_key: config.maps.googleApiKey,
      },
    });
  }),
);

const tokenParamSchema = z.object({ token: z.string().min(10).max(2000) });

const signBodySchema = z.object({
  signature_png: z.string().min(30).max(800_000),
  confirmed: z.array(z.string().min(1).max(100)).max(50),
  // A service agreement: the boxes signed, and the name signed as.
  boxes: z.array(z.enum(SIGNATURE_BOXES)).max(10).optional(),
  signer_name: z.string().trim().max(200).optional(),
});

publicRouter.get(
  '/sign/:token',
  asyncHandler(async (req, res) => {
    const { token } = parse(tokenParamSchema, req.params);
    res.json({ data: await openInvitation(token) });
  }),
);

publicRouter.post(
  '/sign/:token',
  asyncHandler(async (req, res) => {
    const { token } = parse(tokenParamSchema, req.params);
    const body = parse(signBodySchema, req.body);

    const { contract, branch_id: branchId } = await completeInvitation(
      token,
      body,
      req.ip ?? null,
    );

    // Straight on to the card, while they are still on the page. The
    // contract stands either way: a card link that could not be made is the
    // office's to chase, not a reason to throw away a signature.
    let cardUrl: string | null = null;
    const gateway = await activeGateway();
    if (gateway.canCharge) {
      try {
        const scope = { kind: 'branch' as const, branchId };
        cardUrl = (await requestCard(contract.id, scope, null)).url;
      } catch (err) {
        logger.warn({ err, contract_id: contract.id }, 'Card link after remote signing failed');
      }
    }

    res.status(201).json({ data: { contract_id: contract.id, card_url: cardUrl } });
  }),
);

/*
 * Cold email opt-ins from a Google Ads landing page.
 *
 * The landing page lives on another site, so this takes either JSON (a
 * script on the page, hence the CORS headers — there is no cookie or token to
 * leak, so any origin may call it) or a plain HTML form post, which gets a
 * thank-you page back rather than JSON.
 */

const optInLimiter = rateLimit({
  name: 'opt-in-ip',
  windowMs: 60 * 60_000,
  max: 20,
  key: (req) => req.ip ?? null,
  message: 'Too many sign-ups from here. Try again later.',
  forgiveSuccess: false,
});

const checkbox = z
  .union([z.boolean(), z.literal('true'), z.literal('on'), z.literal('1'), z.literal('yes')])
  .transform(() => true as const);

const blank = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .optional()
    .transform((v) => (v ? v : null));

const optInSchema = z.object({
  branch_id: z.string().uuid().optional(),
  first_name: z.string().trim().min(1, 'Tell us your name').max(100),
  last_name: blank(100),
  email: z.string().trim().email('That email address does not look right').max(255),
  phone: blank(40),
  consent: checkbox,
  consent_text: blank(1000),
  campaign: blank(200),
  utm_campaign: blank(200),
  gclid: blank(500),
  // A honeypot: people never see it, form-filling bots fill it in.
  website: z.string().optional(),
});

function allowAnyOrigin(res: Response): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function isFormPost(req: Request): boolean {
  return req.is('application/x-www-form-urlencoded') === 'application/x-www-form-urlencoded';
}

function page(res: Response, status: number, title: string, body: string): void {
  const escape = (text: string) =>
    text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
  res
    .status(status)
    .type('html')
    .send(
      `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
        `<meta name="viewport" content="width=device-width, initial-scale=1">` +
        `<title>${escape(title)}</title>` +
        `<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1a1a1a;background:#fff}` +
        `button{font:inherit;padding:.6rem 1rem;border-radius:.5rem;border:1px solid #888;background:#f2f2f2;cursor:pointer}` +
        `@media (prefers-color-scheme:dark){body{color:#eee;background:#111}button{background:#222;color:#eee}}</style>` +
        `</head><body><h1>${escape(title)}</h1>${body}</body></html>`,
    );
}

/** Which branch a landing page means, when it does not say. */
/** A link that is not ours is a page saying so; anything else is a real error. */
function missing(err: unknown): null {
  if (err instanceof ApiError && err.status === 404) return null;
  throw err;
}

async function defaultBranch(): Promise<string> {
  const active = await db('branches').where({ status: 'active' }).select('id');
  if (active.length === 1 && active[0]) return active[0].id as string;
  throw badRequest('branch_id is required: there is more than one branch');
}

publicRouter.options('/opt-in', (_req, res) => {
  allowAnyOrigin(res);
  res.status(204).end();
});

publicRouter.post(
  '/opt-in',
  express.urlencoded({ extended: false, limit: '20kb' }),
  (_req, res, next) => {
    allowAnyOrigin(res);
    next();
  },
  optInLimiter,
  asyncHandler(async (req, res) => {
    const form = isFormPost(req);
    const parsed = optInSchema.safeParse(req.body);
    if (!parsed.success) {
      if (form) {
        const reason = parsed.error.issues[0]?.message ?? 'Something on the form was missing';
        page(res, 400, 'Almost there', `<p>${reason.replace(/[<>&]/g, '')}. Please go back and try again.</p>`);
        return;
      }
      throw badRequest(
        'Request validation failed',
        parsed.error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
      );
    }
    const body = parsed.data;

    // A bot filled in the invisible field: say thanks, do nothing.
    if (!body.website) {
      await optIn({
        branch_id: body.branch_id ?? (await defaultBranch()),
        first_name: body.first_name,
        last_name: body.last_name,
        email: body.email,
        phone: body.phone,
        source: 'google_ads',
        consent_text: body.consent_text,
        campaign: body.campaign ?? body.utm_campaign,
        gclid: body.gclid,
      });
    }

    if (form) {
      page(res, 201, 'Thanks — you are on the list', '<p>Check your inbox: we have sent a confirmation email.</p>');
      return;
    }
    // Never says whether the address was already on the list.
    res.status(201).json({ data: { subscribed: true } });
  }),
);

/*
 * The unsubscribe link in every email. Opening the link shows a button, and
 * only pressing it unsubscribes — mail scanners follow links in emails, and
 * one of them fetching the page must not unsubscribe anybody.
 */

publicRouter.get(
  '/unsubscribe/:token',
  asyncHandler(async (req, res) => {
    const { token } = parse(tokenParamSchema, req.params);
    const lead = await leadForToken(token).catch(missing);
    if (!lead) {
      page(res, 404, 'Link not recognised', '<p>That unsubscribe link has expired or is not ours.</p>');
      return;
    }
    if (lead.status === 'unsubscribed') {
      page(res, 200, 'You are unsubscribed', '<p>You will not get any more of these emails.</p>');
      return;
    }
    page(
      res,
      200,
      'Unsubscribe',
      `<p>Stop sending snow clearing emails to this address?</p>` +
        `<form method="post"><button type="submit">Yes, unsubscribe me</button></form>`,
    );
  }),
);

publicRouter.post(
  '/unsubscribe/:token',
  express.urlencoded({ extended: false, limit: '1kb' }),
  asyncHandler(async (req, res) => {
    const { token } = parse(tokenParamSchema, req.params);
    const lead = await unsubscribe(token).catch(missing);
    if (!lead) {
      page(res, 404, 'Link not recognised', '<p>That unsubscribe link has expired or is not ours.</p>');
      return;
    }
    page(res, 200, 'You are unsubscribed', '<p>You will not get any more of these emails.</p>');
  }),
);
