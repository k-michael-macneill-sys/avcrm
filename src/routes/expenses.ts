import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, resolveActor, resolveBranchScope } from '../middleware/auth';
import type { Request } from 'express';
import {
  deleteStatement,
  importStatement,
  listReviewTransactions,
  listStatements,
  resolveTransaction,
  retryStatement,
  scanReceipt,
} from '../services/bookkeepingAi';
import { claudeEnabled } from '../services/claude';
import {
  createExpense,
  deleteExpense,
  EXPENSE_CATEGORY_INFO,
  EXPENSE_SORTS,
  listExpenses,
  updateExpense,
} from '../services/expenses';
import { writeYearEndExport } from '../services/yearEndExport';
import { EXPENSE_CATEGORIES, EXPENSE_STATUSES } from '../types/models';
import { logger } from '../utils/logger';
import { asyncHandler } from '../utils/async';
import { badRequest, unauthorized } from '../utils/errors';
import { parse } from '../utils/validate';

/**
 * Bookkeeping, in the Business Console. Corporate keeps the whole company's
 * books, including costs that belong to no branch; a branch's own sign-in
 * keeps that branch's, and sees nothing else.
 */
export const expensesRouter = Router();

expensesRouter.use(requireAuth, requireRole('corporate', 'branch'));

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), { message: 'must be a real date' });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => (v === '' ? null : v));

const listSchema = z.object({
  sort: z.enum(EXPENSE_SORTS).default('recent'),
  status: z.enum(EXPENSE_STATUSES).optional(),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  branch_id: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const money = z.coerce
  .number({ invalid_type_error: 'must be a number' })
  .max(10_000_000)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
    message: 'must be in dollars and cents',
  });
const percent = z.coerce.number().int().min(0).max(100);

const createSchema = z.object({
  // Null for a cost that belongs to the whole company.
  branch_id: z.string().uuid().nullable().default(null),
  category: z.enum(EXPENSE_CATEGORIES),
  description: optionalText(500),
  vendor: optionalText(200),
  amount: money.refine((v) => v > 0, { message: 'must be more than zero' }),
  spent_on: isoDate.nullable().default(null),
  receipt_key: optionalText(300),
  gst_hst: money.refine((v) => v >= 0, { message: 'cannot be negative' }).nullable().default(null),
  deductible_percent: percent.nullable().default(null),
});

const updateSchema = z
  .object({
    branch_id: z.string().uuid().nullable(),
    category: z.enum(EXPENSE_CATEGORIES),
    description: optionalText(500),
    vendor: optionalText(200),
    amount: money.refine((v) => v > 0, { message: 'must be more than zero' }),
    spent_on: isoDate,
    gst_hst: money.refine((v) => v >= 0, { message: 'cannot be negative' }).nullable(),
    deductible_percent: percent,
    status: z.enum(EXPENSE_STATUSES),
  })
  .partial();

const scanSchema = z.object({
  receipt_key: z.string().trim().min(1).max(300),
  branch_id: z.string().uuid().nullable().default(null),
});

const statementSchema = z.object({
  file_key: z.string().trim().min(1).max(300),
  branch_id: z.string().uuid().nullable().default(null),
});

const resolveSchema = z.object({
  decision: z.enum(['business', 'personal', 'transfer', 'income']),
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  deductible_percent: percent.optional(),
});

const exportSchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  branch_id: z.string().uuid().optional(),
});

/** A branch files against itself; only corporate has company-wide costs. */
function branchFor(req: Request, requested: string | null): string | null {
  if (req.user?.role === 'corporate') return requested;
  const scope = resolveBranchScope(req, requested ?? undefined);
  return scope.kind === 'branch' ? scope.branchId : requested;
}

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

/** The dropdown, served rather than hard-coded so the list lives in one place. */
expensesRouter.get('/categories', (_req, res) => {
  res.json({ data: EXPENSE_CATEGORY_INFO });
});

expensesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const filters = parse(listSchema, req.query);
    if (filters.from && filters.to && filters.to < filters.from) {
      throw badRequest('`to` must fall on or after `from`');
    }
    const scope = resolveBranchScope(req, filters.branch_id);
    res.json({
      data: await listExpenses({ ...filters, branch_id: scope.kind === 'branch' ? scope.branchId : undefined }),
    });
  }),
);

expensesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parse(createSchema, req.body);
    if (!req.user) throw unauthorized();
    body.branch_id = branchFor(req, body.branch_id);
    res.status(201).json({ data: await createExpense(req.user, resolveActor(req), body) });
  }),
);

/** Whether scanning is on: the page greys the buttons out when it is not. */
expensesRouter.get('/automation', (_req, res) => {
  res.json({ data: { enabled: claudeEnabled() } });
});

/** One receipt, read by Claude and filed: in the books, or waiting for review. */
expensesRouter.post(
  '/scan',
  asyncHandler(async (req, res) => {
    const body = parse(scanSchema, req.body);
    if (!req.user) throw unauthorized();
    body.branch_id = branchFor(req, body.branch_id);
    res.status(201).json({ data: await scanReceipt(req.user, resolveActor(req), body) });
  }),
);

expensesRouter.get(
  '/statements',
  asyncHandler(async (req, res) => {
    res.json({ data: await listStatements(resolveBranchScope(req)) });
  }),
);

/** Starts reading a statement and answers at once; the list shows it as processing. */
expensesRouter.post(
  '/statements',
  asyncHandler(async (req, res) => {
    const body = parse(statementSchema, req.body);
    if (!req.user) throw unauthorized();
    body.branch_id = branchFor(req, body.branch_id);
    res.status(202).json({ data: await importStatement(req.user, resolveActor(req), body) });
  }),
);

expensesRouter.post(
  '/statements/:id/retry',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.status(202).json({ data: await retryStatement(id, resolveBranchScope(req)) });
  }),
);

expensesRouter.delete(
  '/statements/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    await deleteStatement(id, resolveActor(req), resolveBranchScope(req));
    res.status(204).end();
  }),
);

/** Bank lines Claude was not sure about. */
expensesRouter.get(
  '/bank-transactions/review',
  asyncHandler(async (req, res) => {
    res.json({ data: await listReviewTransactions(resolveBranchScope(req)) });
  }),
);

expensesRouter.post(
  '/bank-transactions/:id/resolve',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(resolveSchema, req.body);
    res.json({ data: await resolveTransaction(id, resolveActor(req), body, resolveBranchScope(req)) });
  }),
);

/** The year's books for the accountant, as one ZIP. */
expensesRouter.get(
  '/export',
  asyncHandler(async (req, res) => {
    const { year, branch_id } = parse(exportSchema, req.query);
    const scope = resolveBranchScope(req, branch_id);
    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="books-${year}.zip"`,
      'Cache-Control': 'no-store',
    });
    try {
      await writeYearEndExport(year, scope, res);
      res.end();
    } catch (err) {
      // Headers are gone by now: all that can be done is cut the download short.
      logger.error({ err, year }, 'Year-end export failed');
      res.destroy(err instanceof Error ? err : new Error(String(err)));
    }
  }),
);

/** Corrects an entry, or approves one waiting for review (status: filed). */
expensesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateSchema, req.body);
    if (body.branch_id !== undefined && req.user?.role !== 'corporate') delete body.branch_id;
    res.json({ data: await updateExpense(id, resolveActor(req), body, resolveBranchScope(req)) });
  }),
);

expensesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    await deleteExpense(id, resolveActor(req), resolveBranchScope(req));
    res.status(204).end();
  }),
);
