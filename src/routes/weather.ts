import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireCorporate, resolveBranchScope } from '../middleware/auth';
import { WEATHER_REGION_KEYS, type WeatherRegionKey } from '../config/weatherRegions';
import { dispatchMap } from '../services/dispatchMap';
import { radarFrames, snowSummary, UpstreamError } from '../services/snowSummary';
import { checkBranch, listWeatherRuns, weatherSettings } from '../services/weather';
import { asyncHandler } from '../utils/async';
import { ApiError, notFound } from '../utils/errors';
import { parse } from '../utils/validate';
import { db } from '../db/client';

/**
 * Weather, in the Operations Console.
 *
 * The weather map (snow summary, radar frames, the dispatch layer) is for
 * anyone signed in: crews and branches watch the same storm the office does,
 * and each sees only their own branch's customers. The weather bot's routes
 * — its rules, its decisions, a manual check — stay corporate's.
 */
export const weatherRouter = Router();

weatherRouter.use(requireAuth);

const regionSchema = z.object({
  region: z.enum(WEATHER_REGION_KEYS as [WeatherRegionKey, ...WeatherRegionKey[]]),
});
const dispatchSchema = z.object({ branch_id: z.string().uuid().optional() });
const runsSchema = z.object({ branch_id: z.string().uuid().optional() });
const checkSchema = z.object({
  branch_id: z.string().uuid(),
  /** False (the default) looks without sending anything. */
  send: z.boolean().default(false),
});

/** An outside weather service that did not answer is its failure, not the caller's. */
function upstream(err: unknown): never {
  if (err instanceof UpstreamError) {
    throw new ApiError(502, 'upstream_unavailable', `The weather service did not answer (${err.message})`);
  }
  throw err;
}

weatherRouter.get(
  '/snow-summary',
  asyncHandler(async (req, res) => {
    const { region } = parse(regionSchema, req.query);
    const summary = await snowSummary(region).catch(upstream);
    res.json({ data: summary });
  }),
);

weatherRouter.get(
  '/radar',
  asyncHandler(async (_req, res) => {
    res.json({ data: await radarFrames().catch(upstream) });
  }),
);

weatherRouter.get(
  '/dispatch-map',
  asyncHandler(async (req, res) => {
    const { branch_id } = parse(dispatchSchema, req.query);
    res.json({ data: await dispatchMap(resolveBranchScope(req, branch_id)) });
  }),
);

weatherRouter.get('/settings', requireCorporate, (_req, res) => {
  res.json({ data: weatherSettings() });
});

weatherRouter.get(
  '/runs',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { branch_id } = parse(runsSchema, req.query);
    res.json({ data: await listWeatherRuns(branch_id) });
  }),
);

weatherRouter.post(
  '/check',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { branch_id, send } = parse(checkSchema, req.body);
    const branch = await db('branches').where({ id: branch_id }).first();
    if (!branch) throw notFound('No such branch');
    res.json({ data: await checkBranch(branch, { dryRun: !send }) });
  }),
);
