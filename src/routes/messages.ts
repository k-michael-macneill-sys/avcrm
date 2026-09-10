import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, resolveBranchScope } from '../middleware/auth';
import { listMessageLog, listMessageTemplates } from '../services/messages';
import { MESSAGE_CHANNELS, MESSAGE_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

/**
 * Read-only. There is no endpoint that sends a message: callers enqueue
 * through the service, and the worker is the only thing that talks to a
 * provider.
 */
export const messageLogRouter = Router();

messageLogRouter.use(requireAuth);

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  status: z.enum(MESSAGE_STATUSES).optional(),
  channel: z.enum(MESSAGE_CHANNELS).optional(),
  template_code: z.string().trim().min(1).max(60).optional(),
  customer_id: z.string().uuid().optional(),
  work_order_id: z.string().uuid().optional(),
});

messageLogRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json(
      await listMessageLog(
        scope,
        {
          status: query.status,
          channel: query.channel,
          template_code: query.template_code,
          customer_id: query.customer_id,
          work_order_id: query.work_order_id,
        },
        { page: query.page, page_size: query.page_size },
      ),
    );
  }),
);

/** Seeded config: the global set, plus the caller's branch overrides. */
export const messageTemplatesRouter = Router();

messageTemplatesRouter.use(requireAuth);

messageTemplatesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await listMessageTemplates(scope) });
  }),
);
