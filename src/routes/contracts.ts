import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, resolveBranchScope } from '../middleware/auth';
import { createContract, getContract, listContracts } from '../services/contracts';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const contractsRouter = Router();

contractsRouter.use(requireAuth);

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  active_on: isoDate.optional(),
});

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const createBodySchema = z
  .object({
    branch_id: z.string().uuid().optional(),
    customer_id: z.string().uuid(),
    price: z.number().nonnegative().max(99_999_999),
    start_date: isoDate,
    end_date: isoDate,
    auto_renew: z.boolean().default(false),
    terms: z.string().trim().max(10_000).nullable().default(null),
  })
  .refine((value) => value.end_date >= value.start_date, {
    message: 'end_date must be on or after start_date',
    path: ['end_date'],
  });

contractsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const branchId = resolveBranchScope(req, query.branch_id);

    const result = await listContracts(
      branchId,
      { customer_id: query.customer_id, active_on: query.active_on },
      { page: query.page, page_size: query.page_size },
    );

    res.json(result);
  }),
);

contractsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const branchId = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await getContract(id, branchId) });
  }),
);

contractsRouter.post(
  '/',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const body = parse(createBodySchema, req.body);
    const branchId = resolveBranchScope(req, body.branch_id);

    const contract = await createContract(branchId, {
      customer_id: body.customer_id,
      price: body.price,
      start_date: body.start_date,
      end_date: body.end_date,
      auto_renew: body.auto_renew,
      terms: body.terms,
    });

    res.status(201).json({ data: contract });
  }),
);
