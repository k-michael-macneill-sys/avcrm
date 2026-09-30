import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireCorporate, resolveActor } from '../middleware/auth';
import {
  createExpense,
  deleteExpense,
  EXPENSE_CATEGORY_INFO,
  EXPENSE_SORTS,
  listExpenses,
} from '../services/expenses';
import { EXPENSE_CATEGORIES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { badRequest, unauthorized } from '../utils/errors';
import { parse } from '../utils/validate';

/**
 * Bookkeeping, in the Business Console. The company's books are corporate's
 * business, so every route here is behind the corporate role.
 */
export const expensesRouter = Router();

expensesRouter.use(requireAuth, requireCorporate);

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
  category: z.enum(EXPENSE_CATEGORIES).optional(),
  branch_id: z.string().uuid().optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
});

const createSchema = z.object({
  // Null for a cost that belongs to the whole company.
  branch_id: z.string().uuid().nullable().default(null),
  category: z.enum(EXPENSE_CATEGORIES),
  description: optionalText(500),
  vendor: optionalText(200),
  amount: z.coerce
    .number({ invalid_type_error: 'must be a number' })
    .positive('must be more than zero')
    .max(10_000_000)
    .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
      message: 'must be in dollars and cents',
    }),
  spent_on: isoDate.nullable().default(null),
  receipt_key: optionalText(300),
});

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
    res.json({ data: await listExpenses(filters) });
  }),
);

expensesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parse(createSchema, req.body);
    if (!req.user) throw unauthorized();
    res.status(201).json({ data: await createExpense(req.user, resolveActor(req), body) });
  }),
);

expensesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    await deleteExpense(id, resolveActor(req));
    res.status(204).end();
  }),
);
