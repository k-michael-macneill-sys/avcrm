import { Router } from 'express';
import { db } from '../db/client';
import { requireAuth } from '../middleware/auth';
import { asyncHandler } from '../utils/async';

export const branchesRouter = Router();

branchesRouter.use(requireAuth);

/** Read-only for now; branches are created by seeds or an admin migration. */
branchesRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    const branches = await db('branches').orderBy('name', 'asc').select('*');
    res.json({ data: branches });
  }),
);
