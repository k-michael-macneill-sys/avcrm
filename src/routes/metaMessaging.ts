import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, resolveBranchScope } from '../middleware/auth';
import {
  MAX_MESSAGE_LENGTH,
  listConversationMessages,
  listConversations,
  queueMetaReply,
  updateConversation,
} from '../services/metaMessaging';
import { META_PLATFORMS } from '../types/models';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

/**
 * The Facebook and Instagram inbox. Customer conversations are the sales
 * side's, so sellers only; branch scope decides which threads, and an
 * unassigned thread is visible to corporate alone until it is routed.
 *
 * The public half — Meta's webhook — lives in routes/webhooks.ts, because it
 * needs the raw body and is mounted before the JSON parser.
 */
export const metaMessagingRouter = Router();

metaMessagingRouter.use(requireAuth, requireRole('corporate', 'sales'));

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  platform: z.enum(META_PLATFORMS).optional(),
  customer_id: z.string().uuid().optional(),
  unassigned: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

const replySchema = z.object({
  message_text: z.string().trim().min(1, 'A reply needs some text').max(MAX_MESSAGE_LENGTH),
});

const updateSchema = z
  .object({
    branch_id: z.string().uuid().optional(),
    customer_id: z.string().uuid().nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

metaMessagingRouter.get(
  '/conversations',
  asyncHandler(async (req, res) => {
    const { branch_id, platform, customer_id, unassigned, ...pagination } = parse(
      listQuerySchema,
      req.query,
    );
    res.json(
      await listConversations(
        resolveBranchScope(req, branch_id),
        { platform, customer_id, unassigned },
        pagination,
      ),
    );
  }),
);

metaMessagingRouter.patch(
  '/conversations/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateSchema, req.body);
    res.json({ data: await updateConversation(id, resolveBranchScope(req), body) });
  }),
);

metaMessagingRouter.get(
  '/conversations/:id/messages',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const pagination = parse(paginationSchema, req.query);
    res.json(await listConversationMessages(id, resolveBranchScope(req), pagination));
  }),
);

/** Queues the reply and answers 202: the message-queue worker sends it. */
metaMessagingRouter.post(
  '/conversations/:id/messages',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const { message_text } = parse(replySchema, req.body);
    if (!req.user) throw unauthorized();

    res.status(202).json({
      data: await queueMetaReply(id, message_text, req.user.id, resolveBranchScope(req)),
    });
  }),
);
