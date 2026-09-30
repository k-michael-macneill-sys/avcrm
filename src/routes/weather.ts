import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireCorporate } from '../middleware/auth';
import { checkBranch, listWeatherRuns, weatherSettings } from '../services/weather';
import { asyncHandler } from '../utils/async';
import { notFound } from '../utils/errors';
import { parse } from '../utils/validate';
import { db } from '../db/client';

/**
 * The weather bot, in the Operations Console. It runs on its own from the
 * scheduler; these routes show what it decided and let the office look at
 * tonight's forecast — or send tonight's notices — without waiting for it.
 */
export const weatherRouter = Router();

weatherRouter.use(requireAuth, requireCorporate);

const runsSchema = z.object({ branch_id: z.string().uuid().optional() });
const checkSchema = z.object({
  branch_id: z.string().uuid(),
  /** False (the default) looks without sending anything. */
  send: z.boolean().default(false),
});

weatherRouter.get('/settings', (_req, res) => {
  res.json({ data: weatherSettings() });
});

weatherRouter.get(
  '/runs',
  asyncHandler(async (req, res) => {
    const { branch_id } = parse(runsSchema, req.query);
    res.json({ data: await listWeatherRuns(branch_id) });
  }),
);

weatherRouter.post(
  '/check',
  asyncHandler(async (req, res) => {
    const { branch_id, send } = parse(checkSchema, req.body);
    const branch = await db('branches').where({ id: branch_id }).first();
    if (!branch) throw notFound('No such branch');
    res.json({ data: await checkBranch(branch, { dryRun: !send }) });
  }),
);
