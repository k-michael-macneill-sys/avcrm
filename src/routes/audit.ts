import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireCorporate } from '../middleware/auth';
import { listAuditLog } from '../services/audit';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

/**
 * Read-only, corporate-only. There is no write endpoint: entries are made by
 * the services that change something, inside the same transaction.
 */
export const auditLogRouter = Router();

auditLogRouter.use(requireAuth, requireCorporate);

const listQuerySchema = paginationSchema.extend({
  entity_type: z.string().trim().min(1).max(60).optional(),
  entity_id: z.string().uuid().optional(),
  user_id: z.string().uuid().optional(),
  action: z.string().trim().min(1).max(60).optional(),
});

auditLogRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);

    res.json(
      await listAuditLog(
        {
          entity_type: query.entity_type,
          entity_id: query.entity_id,
          user_id: query.user_id,
          action: query.action,
        },
        { page: query.page, page_size: query.page_size },
      ),
    );
  }),
);
