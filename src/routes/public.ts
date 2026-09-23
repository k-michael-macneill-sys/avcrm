import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config';
import { requestCard } from '../services/cards';
import { gateway } from '../services/gateway';
import { completeInvitation, openInvitation } from '../services/signing';
import { asyncHandler } from '../utils/async';
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
publicRouter.get('/config', (_req, res) => {
  res.json({
    data: {
      card_capture: gateway.name === 'stripe',
      maps_api_key: config.maps.googleApiKey,
    },
  });
});

const tokenParamSchema = z.object({ token: z.string().min(10).max(2000) });

const signBodySchema = z.object({
  signature_png: z.string().min(30).max(800_000),
  confirmed: z.array(z.string().min(1).max(100)).max(50),
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
    if (gateway.name === 'stripe') {
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
