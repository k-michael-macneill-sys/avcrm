import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { requireAuth, requireCorporate } from '../middleware/auth';
import { BRANCH_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { badRequest, notFound } from '../utils/errors';
import { parse } from '../utils/validate';

export const branchesRouter = Router();

branchesRouter.use(requireAuth);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  province: z.string().trim().min(2).max(60),
  // IANA zone name; drives scheduling and automation send times.
  timezone: z.string().trim().min(1).max(64).default('America/Toronto'),
  status: z.enum(BRANCH_STATUSES).default('active'),
});

const updateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  province: z.string().trim().min(2).max(60).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  status: z.enum(BRANCH_STATUSES).optional(),
  manager_user_id: z.string().uuid().nullable().optional(),
});

/** Operators see their own branch; corporate sees all of them. */
branchesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = db('branches').orderBy('name', 'asc');
    if (req.user?.role !== 'corporate') {
      query.where({ id: req.user?.branch_id ?? '' });
    }
    res.json({ data: await query.select('*') });
  }),
);

branchesRouter.post(
  '/',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const body = parse(createSchema, req.body);
    const [branch] = await db('branches').insert(body).returning('*');
    res.status(201).json({ data: branch });
  }),
);

branchesRouter.patch(
  '/:id',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateSchema, req.body);
    if (Object.keys(body).length === 0) {
      throw badRequest('No updatable fields were provided');
    }

    if (body.manager_user_id) {
      // The manager receives service photo emails and document expiry
      // warnings, so they have to actually belong to this branch.
      const manager = await db('users')
        .where({ id: body.manager_user_id })
        .first('id', 'branch_id');
      if (!manager || manager.branch_id !== id) {
        throw badRequest('manager_user_id must be a user in this branch');
      }
    }

    const [branch] = await db('branches').where({ id }).update(body).returning('*');
    if (!branch) throw notFound('Branch not found');
    res.json({ data: branch });
  }),
);
