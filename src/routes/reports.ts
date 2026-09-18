import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireCorporate, resolveBranchScope } from '../middleware/auth';
import {
  branchSummary,
  monthlyRevenue,
  operatorScorecards,
} from '../services/reports';
import { asyncHandler } from '../utils/async';
import { badRequest } from '../utils/errors';
import { parse } from '../utils/validate';

/**
 * Roll-up reporting, which the spec puts behind corporate: "corporate sees all
 * branches and all roll-up reporting". Operators get their own run sheet
 * through /work-orders, not the branch's numbers.
 *
 * Every response echoes the window it was computed over, because a figure
 * without its date range is not a figure anyone should act on.
 */
export const reportsRouter = Router();

reportsRouter.use(requireAuth, requireCorporate);

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
    message: 'must be a real date',
  });

const windowSchema = z.object({
  branch_id: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

function windowOf(query: z.infer<typeof windowSchema>) {
  if (query.from && query.to && query.to < query.from) {
    throw badRequest('`to` must fall on or after `from`');
  }
  return { from: query.from, to: query.to };
}

/**
 * One row per branch. Corporate with no branch_id gets every branch side by
 * side — the cross-branch comparison; narrowing to one gives that branch's
 * roll-up. Same numbers, same query, different scope.
 */
reportsRouter.get(
  '/branch-summary',
  asyncHandler(async (req, res) => {
    const query = parse(windowSchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);
    const window = windowOf(query);

    res.json({
      data: await branchSummary(scope, window),
      meta: { from: query.from ?? null, to: query.to ?? null },
    });
  }),
);

/** The money, bucketed by the period it belongs to. */
reportsRouter.get(
  '/revenue',
  asyncHandler(async (req, res) => {
    const query = parse(windowSchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);
    const window = windowOf(query);

    res.json({
      data: await monthlyRevenue(scope, window),
      meta: { from: query.from ?? null, to: query.to ?? null },
    });
  }),
);

/** What each operator did, and what the customer said afterwards. */
reportsRouter.get(
  '/operators',
  asyncHandler(async (req, res) => {
    const query = parse(windowSchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);
    const window = windowOf(query);

    res.json({
      data: await operatorScorecards(scope, window),
      meta: { from: query.from ?? null, to: query.to ?? null },
    });
  }),
);
