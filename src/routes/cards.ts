import { Router } from 'express';
import { z } from 'zod';
import {
  requireAuth,
  resolveBranchScope,
  sellersWrite,
} from '../middleware/auth';
import { completeSetup, getCardSetup, listCardSetups, requestCard } from '../services/cards';
import { CARD_SETUP_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const cardSetupsRouter = Router();

cardSetupsRouter.use(requireAuth, sellersWrite);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  contract_id: z.string().uuid().optional(),
  status: z.enum(CARD_SETUP_STATUSES).optional(),
});

const requestSchema = z.object({ contract_id: z.string().uuid() });

cardSetupsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json(
      await listCardSetups(
        scope,
        {
          customer_id: query.customer_id,
          contract_id: query.contract_id,
          status: query.status,
        },
        { page: query.page, page_size: query.page_size },
      ),
    );
  }),
);

/**
 * Asks the customer for a card. Nothing sensitive comes back through here —
 * the response carries a link to the processor's own page, which is where the
 * card is typed.
 */
cardSetupsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parse(requestSchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    if (!req.user) throw unauthorized();

    res.status(201).json({ data: await requestCard(body.contract_id, scope, req.user.id) });
  }),
);

/**
 * Asks the processor whether they finished, for when the webhook has not
 * landed yet and a rep is standing there waiting.
 */
cardSetupsRouter.post(
  '/:id/refresh',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    const setup = await getCardSetup(id, scope);

    res.json({ data: (await completeSetup(setup.provider_session_id)) ?? setup });
  }),
);
