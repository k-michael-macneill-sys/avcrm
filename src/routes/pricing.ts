import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, resolveBranchScope } from '../middleware/auth';
import { listPricingGuide, suggestPrice } from '../services/pricing';
import { BILLING_TYPES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { parse } from '../utils/validate';

/**
 * Seeded config, read-only over the API — the same shape as
 * /document-requirements. It pre-fills a quote's list price; the rep is never
 * blocked from overriding it.
 */
export const pricingGuideRouter = Router();

pricingGuideRouter.use(requireAuth);

const listQuerySchema = z.object({
  branch_id: z.string().uuid().optional(),
  driveway_size_cars: z.coerce.number().int().min(1).max(6).optional(),
  billing_type: z.enum(BILLING_TYPES).optional(),
});

const suggestQuerySchema = z.object({
  property_id: z.string().uuid(),
  billing_type: z.enum(BILLING_TYPES),
  branch_id: z.string().uuid().optional(),
});

pricingGuideRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json({
      data: await listPricingGuide(scope, {
        driveway_size_cars: query.driveway_size_cars,
        billing_type: query.billing_type,
      }),
    });
  }),
);

/**
 * What the quote screen opens with for one property. Returns a null price
 * rather than an error when the branch has no guide row for that driveway
 * size — an unpriced size is a gap in config, not a failed request.
 */
pricingGuideRouter.get(
  '/suggest',
  asyncHandler(async (req, res) => {
    const query = parse(suggestQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json({ data: await suggestPrice(query.property_id, query.billing_type, scope) });
  }),
);
