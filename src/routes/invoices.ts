import { Router } from 'express';
import { resolveDeleter } from '../middleware/auth';
import { deleteInvoice } from '../services/deletion';
import { z } from 'zod';
import {
  requireAuth,
  requireCorporate,
  resolveActor,
  resolveBranchScope,
} from '../middleware/auth';
import {
  createInvoice,
  getInvoice,
  listInvoices,
  listPayments,
  sendInvoice,
  voidInvoice,
} from '../services/invoices';
import { invoicePdf } from '../services/documents';
import { chargeInvoice, recordPayment } from '../services/payments';
import { payLinkFor } from '../services/portal';
import { INVOICE_STATUSES, PAYMENT_METHODS } from '../types/models';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
import { sendPdf } from '../utils/pdfResponse';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const invoicesRouter = Router();

invoicesRouter.use(requireAuth);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
    message: 'must be a real date',
  });

/** Money is numeric(10,2): anything finer than a cent is a mistake. */
const money = z
  .number()
  .min(0)
  .max(99_999_999.99)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
    message: 'must be a whole number of cents',
  });

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  status: z.enum(INVOICE_STATUSES).optional(),
  customer_id: z.string().uuid().optional(),
  contract_id: z.string().uuid().optional(),
  outstanding: booleanish.optional(),
});

const createBodySchema = z
  .object({
    contract_id: z.string().uuid(),
    billing_period_start: isoDate,
    billing_period_end: isoDate,
    amount_due: money,
    due_date: isoDate,
  })
  .refine((v) => v.billing_period_end > v.billing_period_start, {
    message: 'billing_period_end must fall after billing_period_start',
    path: ['billing_period_end'],
  });

const paymentBodySchema = z
  .object({
    amount: money.refine((v) => v > 0, { message: 'must be more than zero' }),
    method: z.enum(PAYMENT_METHODS),
    provider_transaction_id: z.string().trim().min(1).max(255).nullable().default(null),
    status: z.enum(['pending', 'succeeded', 'failed']).default('succeeded'),
    failure_reason: z.string().trim().min(1).max(1000).nullable().default(null),
  })
  .refine((v) => v.status !== 'failed' || !!v.failure_reason, {
    message: 'failure_reason is required when a payment failed',
    path: ['failure_reason'],
  });

const branchOf = (req: { query: Record<string, unknown> }) =>
  req.query.branch_id as string | undefined;

invoicesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json(
      await listInvoices(
        scope,
        {
          status: query.status,
          customer_id: query.customer_id,
          contract_id: query.contract_id,
          outstanding: query.outstanding,
        },
        { page: query.page, page_size: query.page_size },
      ),
    );
  }),
);

invoicesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await getInvoice(id, resolveBranchScope(req, branchOf(req))) });
  }),
);

/**
 * The customer's link to this bill, for staff to text or read out. Made on
 * first use and the same every time after, so it matches the one emailed.
 */
invoicesRouter.get(
  '/:id/pay-link',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await payLinkFor(id, resolveBranchScope(req, branchOf(req))) });
  }),
);

invoicesRouter.get(
  '/:id/payments',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    // 404s if the invoice is outside the caller's scope.
    await getInvoice(id, resolveBranchScope(req, branchOf(req)));
    res.json({ data: await listPayments(id) });
  }),
);

/**
 * A manually raised bill. The season plan is billed by `job:billing`; this is
 * for what it does not cover — a one-off ice removal call, say.
 */
invoicesRouter.post(
  '/',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const body = parse(createBodySchema, req.body);
    const scope = resolveBranchScope(req, branchOf(req));
    const { contract_id, ...input } = body;

    res.status(201).json({ data: await createInvoice(contract_id, scope, input) });
  }),
);

invoicesRouter.post(
  '/:id/send',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await sendInvoice(id, resolveBranchScope(req, branchOf(req))) });
  }),
);

invoicesRouter.post(
  '/:id/void',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await voidInvoice(id, resolveBranchScope(req, branchOf(req))) });
  }),
);

/**
 * Charges the card the customer saved. A decline is not an error here — it
 * comes back as a recorded failed payment, which is what tells the customer
 * and flags the branch manager.
 */
invoicesRouter.post(
  '/:id/charge',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, branchOf(req));

    res.json({ data: await chargeInvoice(id, scope, resolveActor(req)) });
  }),
);

/**
 * Books money, or records that a charge failed. A failed card charge queues
 * the notice to the customer and flags the branch manager.
 */
invoicesRouter.post(
  '/:id/payments',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(paymentBodySchema, req.body);
    const scope = resolveBranchScope(req, branchOf(req));

    res.status(201).json({
      data: await recordPayment(id, scope, body, resolveActor(req)),
    });
  }),
);

/**
 * The bill as something to print, attach to an email, or hand over.
 *
 * Rendered on first request and kept; regenerated by itself once a payment
 * lands, so what downloads always agrees with what the screen says.
 */
invoicesRouter.get(
  '/:id/pdf',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    if (!req.user) throw unauthorized();

    const document = await invoicePdf(id, scope, req.user);
    sendPdf(res, document);
  }),
);

/** Deletes it and everything beneath it; corporate only. See services/deletion.ts. */
invoicesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    await deleteInvoice(id, resolveBranchScope(req, req.query.branch_id as string | undefined), resolveDeleter(req));
    res.status(204).send();
  }),
);
