import { Router } from 'express';
import { z } from 'zod';
import {
  requireAuth,
  requireCorporate,
  resolveActor,
  resolveBranchScope,
} from '../middleware/auth';
import { listBranchPayments, refundPayment } from '../services/payments';
import { PAYMENT_METHODS, PAYMENT_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

/**
 * Payments are recorded against an invoice (POST /invoices/:id/payments).
 * This router is the cross-invoice view and the refund.
 */
export const paymentsRouter = Router();

paymentsRouter.use(requireAuth);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  status: z.enum(PAYMENT_STATUSES).optional(),
  method: z.enum(PAYMENT_METHODS).optional(),
  invoice_id: z.string().uuid().optional(),
});

paymentsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json(
      await listBranchPayments(
        scope,
        {
          status: query.status,
          method: query.method,
          invoice_id: query.invoice_id,
        },
        { page: query.page, page_size: query.page_size },
      ),
    );
  }),
);

/** Giving money back is a corporate decision, and an audited one. */
paymentsRouter.post(
  '/:id/refund',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    res.json({ data: await refundPayment(id, scope, resolveActor(req)) });
  }),
);
