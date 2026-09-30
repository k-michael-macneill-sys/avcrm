import { Router } from 'express';
import { z } from 'zod';
import {
  requireAuth,
  requireCorporate,
  requireRole,
  resolveBranchScope,
  resolveWriteBranch,
} from '../middleware/auth';
import {
  coldEmailStats,
  DRIP_SEQUENCE,
  getEmailLead,
  listEmailLeads,
  optIn,
  stopEmailLead,
} from '../services/coldEmail';
import { EMAIL_LEAD_STATUSES, OPT_IN_SOURCES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
import { parse } from '../utils/validate';

/**
 * The cold email pipeline. Corporate runs it from the Business Console;
 * sales reps may add a door-to-door opt-in, since they are the ones at the
 * door, but the list and its history are corporate's.
 *
 * Google Ads opt-ins arrive without a session, through POST /public/opt-in.
 */
export const coldEmailRouter = Router();

coldEmailRouter.use(requireAuth);

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => (v === '' ? null : v));

const listSchema = z.object({
  branch_id: z.string().uuid().optional(),
  status: z.enum(EMAIL_LEAD_STATUSES).optional(),
  source: z.enum(OPT_IN_SOURCES).optional(),
});

const createSchema = z.object({
  branch_id: z.string().uuid().optional(),
  first_name: z.string().trim().min(1).max(100),
  last_name: optionalText(100),
  email: z.string().trim().email().max(255),
  phone: optionalText(40),
  source: z.enum(OPT_IN_SOURCES),
  campaign: optionalText(200),
  // Somebody has to have said yes. The box on the form is that yes.
  consent: z.literal(true, {
    errorMap: () => ({ message: 'They must agree to receive emails before being added' }),
  }),
});

const stopSchema = z.object({ status: z.enum(['unsubscribed', 'converted']) });
const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

coldEmailRouter.get('/sequence', requireCorporate, (_req, res) => {
  res.json({ data: DRIP_SEQUENCE });
});

coldEmailRouter.get(
  '/stats',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { branch_id } = parse(listSchema, req.query);
    res.json({ data: await coldEmailStats(resolveBranchScope(req, branch_id)) });
  }),
);

coldEmailRouter.get(
  '/leads',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { branch_id, ...filters } = parse(listSchema, req.query);
    res.json({ data: await listEmailLeads(resolveBranchScope(req, branch_id), filters) });
  }),
);

coldEmailRouter.get(
  '/leads/:id',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await getEmailLead(id, resolveBranchScope(req)) });
  }),
);

coldEmailRouter.post(
  '/leads',
  requireRole('corporate', 'sales', 'branch'),
  asyncHandler(async (req, res) => {
    const { consent: _consent, branch_id, ...body } = parse(createSchema, req.body);
    if (!req.user) throw unauthorized();

    const result = await optIn({
      ...body,
      branch_id: resolveWriteBranch(req, branch_id),
      created_by_user_id: req.user.id,
    });
    res.status(result.enrolled ? 201 : 200).json({ data: result });
  }),
);

coldEmailRouter.post(
  '/leads/:id/stop',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const { status } = parse(stopSchema, req.body);
    res.json({ data: await stopEmailLead(id, status, resolveBranchScope(req)) });
  }),
);
