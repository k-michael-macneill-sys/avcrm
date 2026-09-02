import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, resolveBranchScope } from '../middleware/auth';
import { getPayment, listPayments, recordPayment } from '../services/payments';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const paymentsRouter = Router();

paymentsRouter.use(requireAuth);

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const createBodySchema = z.object({
  branch_id: z.string().uuid().optional(),
  customer_id: z.string().uuid(),
  amount: z.number().positive().max(99_999_999),
  method: z.enum(PAYMENT_METHODS),
  description: z.string().trim().max(500).nullable().default(null),
});

paymentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const branchId = resolveBranchScope(req, query.branch_id);

    const result = await listPayments(
      branchId,
      { customer_id: query.customer_id, status: query.status },
      { page: query.page, page_size: query.page_size },
    );

    res.json(result);
  }),
);

paymentsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const branchId = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await getPayment(id, branchId) });
  }),
);

/** Card/ACH hit the mock gateway in services/paymentGateway.ts. */
paymentsRouter.post(
  '/',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const body = parse(createBodySchema, req.body);
    const branchId = resolveBranchScope(req, body.branch_id);

    const payment = await recordPayment(branchId, {
      customer_id: body.customer_id,
      amount: body.amount,
      method: body.method,
      description: body.description,
    });

    res.status(201).json({ data: payment });
  }),
);
