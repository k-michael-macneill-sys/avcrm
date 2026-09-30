import { Router } from 'express';
import { resolveDeleter } from '../middleware/auth';
import { deleteUser } from '../services/deletion';
import { z } from 'zod';
import { db } from '../db/client';
import { requireAuth, requireCorporate, resolveBranchScope } from '../middleware/auth';
import { createUser, PUBLIC_USER_COLUMNS } from '../services/auth';
import { ONBOARDING_STATUSES, USER_ROLES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { badRequest, notFound } from '../utils/errors';
import { offsetOf, paginated, paginationSchema } from '../utils/pagination';
import { applyBranchScope } from '../utils/scope';
import { parse } from '../utils/validate';

export const usersRouter = Router();

usersRouter.use(requireAuth);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  role: z.enum(USER_ROLES).optional(),
  onboarding_status: z.enum(ONBOARDING_STATUSES).optional(),
});

const createSchema = z.object({
  email: z.string().trim().email().max(255),
  password: z.string().min(8).max(200),
  first_name: z.string().trim().min(1).max(100),
  last_name: z.string().trim().min(1).max(100),
  phone: z.string().trim().max(40).nullable().default(null),
  role: z.enum(USER_ROLES),
  branch_id: z.string().uuid().nullable().default(null),
});

const updateSchema = z.object({
  first_name: z.string().trim().min(1).max(100).optional(),
  last_name: z.string().trim().min(1).max(100).optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  branch_id: z.string().uuid().nullable().optional(),
  is_active: z.boolean().optional(),
  onboarding_status: z.enum(ONBOARDING_STATUSES).optional(),
});

usersRouter.get(
  '/',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    const base = applyBranchScope(db('users'), 'branch_id', scope);
    if (query.role) base.andWhere({ role: query.role });
    if (query.onboarding_status) {
      base.andWhere({ onboarding_status: query.onboarding_status });
    }

    const [rows, countRow] = await Promise.all([
      base
        .clone()
        .orderBy([
          { column: 'last_name', order: 'asc' },
          { column: 'first_name', order: 'asc' },
        ])
        .limit(query.page_size)
        .offset(offsetOf(query))
        .select([...PUBLIC_USER_COLUMNS]),
      base.clone().count<{ count: string }[]>({ count: '*' }).first(),
    ]);

    res.json(paginated(rows, Number(countRow?.count ?? 0), query));
  }),
);

/** Role is chosen here by a corporate user, never by the account holder. */
usersRouter.post(
  '/',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const body = parse(createSchema, req.body);
    res.status(201).json({ data: await createUser(body) });
  }),
);

usersRouter.patch(
  '/:id',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateSchema, req.body);
    if (Object.keys(body).length === 0) {
      throw badRequest('No updatable fields were provided');
    }

    const target = await db('users').where({ id }).first('id', 'role', 'branch_id');
    if (!target) throw notFound('User not found');

    // The users_field_staff_need_branch_check constraint backs this up, but
    // a 400 with a sentence beats a raw constraint error.
    const nextBranch = body.branch_id === undefined ? target.branch_id : body.branch_id;
    if (target.role !== 'corporate' && !nextBranch) {
      throw badRequest('Field staff must belong to a branch');
    }

    const [user] = await db('users')
      .where({ id })
      .update(body)
      .returning([...PUBLIC_USER_COLUMNS]);

    res.json({ data: user });
  }),
);

/** Deletes it and everything beneath it; corporate only. See services/deletion.ts. */
usersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    await deleteUser(id, resolveDeleter(req));
    res.status(204).send();
  }),
);
