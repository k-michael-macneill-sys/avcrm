import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireCorporate } from '../middleware/auth';
import { financialProjection, financialSummary } from '../services/finance';
import { asyncHandler } from '../utils/async';
import { badRequest } from '../utils/errors';
import { parse } from '../utils/validate';

/** The Business Console's financial dashboard. Corporate only, like Reports. */
export const financeRouter = Router();

financeRouter.use(requireAuth, requireCorporate);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), { message: 'must be a real date' });

const windowSchema = z.object({
  branch_id: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

financeRouter.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const window = parse(windowSchema, req.query);
    if (window.from && window.to && window.to < window.from) {
      throw badRequest('`to` must fall on or after `from`');
    }
    res.json({
      data: await financialSummary(window),
      meta: { from: window.from ?? null, to: window.to ?? null, branch_id: window.branch_id ?? null },
    });
  }),
);

financeRouter.get(
  '/projection',
  asyncHandler(async (req, res) => {
    const { branch_id } = parse(windowSchema.pick({ branch_id: true }), req.query);
    res.json({ data: await financialProjection({ branch_id }), meta: { branch_id: branch_id ?? null } });
  }),
);
