import { Router } from 'express';
import { z } from 'zod';
import {
  requireAuth,
  resolveActor,
  resolveBranchScope,
} from '../middleware/auth';
import { listContracts } from '../services/contracts';
import {
  changeQuoteStatus,
  createQuote,
  deleteQuote,
  getQuote,
  listQuotes,
  updateQuote,
} from '../services/quotes';
import { BILLING_TYPES, QUOTE_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const quotesRouter = Router();

quotesRouter.use(requireAuth);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

/**
 * Money arrives as a JSON number and is stored as numeric(10,2). Anything
 * finer than a cent is a mistake worth surfacing rather than rounding away.
 */
const money = z
  .number()
  .min(0)
  .max(99_999_999.99)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
    message: 'must be a whole number of cents',
  });

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
    message: 'must be a real date',
  });

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  property_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  status: z.enum(QUOTE_STATUSES).optional(),
  billing_type: z.enum(BILLING_TYPES).optional(),
  created_by_user_id: z.string().uuid().optional(),
});

/**
 * What the visit includes beyond clearing the drive. No prices of their own:
 * the rep prices the job as a whole, and these tell the crew what to bring.
 */
const addonFields = {
  addon_salt: z.boolean().default(false),
  addon_vehicle: z.boolean().default(false),
  addon_stairs: z.boolean().default(false),
};

const createBodySchema = z
  .object({
    property_id: z.string().uuid(),
    billing_type: z.enum(BILLING_TYPES),
    initial_price: money,
    discounted_price: money,
    recurring_price: money.nullable().default(null),
    season_start: isoDate,
    season_end: isoDate,
    // A quote can be written up in advance or presented on the spot.
    status: z.enum(['draft', 'presented']).default('draft'),
    notes: z.string().trim().max(5000).nullable().default(null),
    ...addonFields,
  })
  .refine((v) => v.discounted_price <= v.initial_price, {
    message: 'discounted_price cannot be higher than initial_price',
    path: ['discounted_price'],
  })
  .refine((v) => v.season_end > v.season_start, {
    message: 'season_end must fall after season_start',
    path: ['season_end'],
  })
  .refine((v) => v.recurring_price === null || v.billing_type === 'monthly', {
    message: 'recurring_price applies to monthly billing only: seasonal is one payment',
    path: ['recurring_price'],
  });

const updateBodySchema = z.object({
  billing_type: z.enum(BILLING_TYPES).optional(),
  initial_price: money.optional(),
  discounted_price: money.optional(),
  recurring_price: money.nullable().optional(),
  season_start: isoDate.optional(),
  season_end: isoDate.optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  addon_salt: z.boolean().optional(),
  addon_vehicle: z.boolean().optional(),
  addon_stairs: z.boolean().optional(),
});

const statusBodySchema = z.object({ status: z.enum(QUOTE_STATUSES) });

quotesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json(
      await listQuotes(
        scope,
        {
          property_id: query.property_id,
          customer_id: query.customer_id,
          status: query.status,
          billing_type: query.billing_type,
          created_by_user_id: query.created_by_user_id,
        },
        { page: query.page, page_size: query.page_size },
      ),
    );
  }),
);

quotesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await getQuote(id, scope) });
  }),
);

/** The contract this quote turned into, if it has been signed. */
quotesRouter.get(
  '/:id/contract',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    // 404s if the quote is outside the caller's scope.
    await getQuote(id, scope);

    const contracts = await listContracts(
      scope,
      { quote_id: id },
      { page: 1, page_size: 1 },
    );
    res.json({ data: contracts.data[0] ?? null });
  }),
);

quotesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parse(createBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    if (!req.user) throw unauthorized();

    const { property_id, ...input } = body;
    const quote = await createQuote(
      property_id,
      req.user.id,
      scope,
      input,
      resolveActor(req),
    );

    res.status(201).json({ data: quote });
  }),
);

quotesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    res.json({ data: await updateQuote(id, scope, body, resolveActor(req)) });
  }),
);

/**
 * The lifecycle move, kept separate from re-pricing so the allowed
 * transitions live in one place.
 */
quotesRouter.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const { status } = parse(statusBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    res.json({ data: await changeQuoteStatus(id, scope, status, resolveActor(req)) });
  }),
);

quotesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    await deleteQuote(id, scope);
    res.status(204).send();
  }),
);
