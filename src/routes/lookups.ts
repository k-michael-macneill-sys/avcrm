import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireCorporate, resolveActor } from '../middleware/auth';
import { createLookup, listLookup, listLookups, LOOKUP_TABLES, updateLookup } from '../services/lookups';
import { asyncHandler } from '../utils/async';
import { parse } from '../utils/validate';

/**
 * The contract form's lists. Anyone signed in reads the active rows; the
 * office (corporate) sees the retired ones too, and is the only one who
 * changes them — from the Lists tab in Settings.
 */
export const lookupsRouter = Router();

lookupsRouter.use(requireAuth);

const tableParam = z.object({ table: z.enum(LOOKUP_TABLES as [string, ...string[]]) });
const rowParam = tableParam.extend({ id: z.string().uuid('id must be a UUID') });
const listQuery = z.object({
  include_inactive: z
    .enum(['true', 'false'])
    .optional()
    .transform((v) => v === 'true'),
  branch_id: z.string().uuid().optional(),
});

type Table = (typeof LOOKUP_TABLES)[number];

lookupsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuery, req.query);
    const includeInactive = query.include_inactive && req.user?.role === 'corporate';
    // Everyone below corporate sees their own branch's routes.
    const branchId = req.user?.role === 'corporate' ? (query.branch_id ?? null) : (req.user?.branch_id ?? null);
    res.json({ data: await listLookups({ includeInactive, branchId }) });
  }),
);

lookupsRouter.get(
  '/:table',
  asyncHandler(async (req, res) => {
    const { table } = parse(tableParam, req.params);
    const query = parse(listQuery, req.query);
    const includeInactive = query.include_inactive && req.user?.role === 'corporate';
    res.json({ data: await listLookup(table as Table, { includeInactive }) });
  }),
);

lookupsRouter.post(
  '/:table',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { table } = parse(tableParam, req.params);
    res.status(201).json({ data: await createLookup(table as Table, req.body, resolveActor(req)) });
  }),
);

lookupsRouter.patch(
  '/:table/:id',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { table, id } = parse(rowParam, req.params);
    res.json({ data: await updateLookup(table as Table, id, req.body, resolveActor(req)) });
  }),
);
