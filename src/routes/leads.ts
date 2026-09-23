import { Router } from 'express';
import { z } from 'zod';
import {
  requireAuth,
  requireRole,
  resolveBranchScope,
  resolveWriteBranch,
} from '../middleware/auth';
import {
  createPin,
  deletePin,
  listCustomerPins,
  listPins,
  updatePin,
} from '../services/leads';
import { PIN_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
import { parse } from '../utils/validate';

/**
 * The leads map. Door-knock pins are the sales side's own record and only
 * sellers see them; the customer pins — signed houses and what they pay for —
 * are for anyone in the branch, because the crew needs them too.
 */
export const leadsRouter = Router();

leadsRouter.use(requireAuth);

const sellers = requireRole('corporate', 'sales');

const boundsSchema = z
  .object({
    north: z.coerce.number().min(-90).max(90),
    south: z.coerce.number().min(-90).max(90),
    east: z.coerce.number().min(-180).max(180),
    west: z.coerce.number().min(-180).max(180),
    branch_id: z.string().uuid().optional(),
  })
  .refine((b) => b.north >= b.south, { message: 'north must not be below south', path: ['north'] });

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .default(null)
    .transform((v) => (v === '' ? null : v));

const leadContactSchema = z
  .object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(255).nullable().default(null),
    phone: z.string().trim().max(40).nullable().default(null),
  })
  .refine((c) => !!c.email || !!c.phone, {
    message: 'A lead needs an email or a phone number to follow up on',
    path: ['email'],
  });

const createSchema = z.object({
  branch_id: z.string().uuid().optional(),
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
  address_line1: optionalText(200),
  city: optionalText(120),
  province: optionalText(60),
  postal_code: optionalText(12),
  status: z.enum(PIN_STATUSES),
  notes: optionalText(2000),
  lead: leadContactSchema.nullable().default(null),
});

const updateSchema = z
  .object({
    status: z.enum(PIN_STATUSES).optional(),
    notes: optionalText(2000).optional(),
    lead: leadContactSchema.nullable().optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: 'Nothing to change' });

leadsRouter.get(
  '/pins',
  sellers,
  asyncHandler(async (req, res) => {
    const { branch_id, ...bounds } = parse(boundsSchema, req.query);
    res.json({ data: await listPins(resolveBranchScope(req, branch_id), bounds) });
  }),
);

leadsRouter.post(
  '/pins',
  sellers,
  asyncHandler(async (req, res) => {
    const body = parse(createSchema, req.body);
    if (!req.user) throw unauthorized();
    const branchId = resolveWriteBranch(req, body.branch_id);

    res.status(201).json({
      data: await createPin(branchId, req.user.id, resolveBranchScope(req, branchId), body),
    });
  }),
);

leadsRouter.patch(
  '/pins/:id',
  sellers,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateSchema, req.body);
    if (!req.user) throw unauthorized();

    res.json({ data: await updatePin(id, req.user.id, resolveBranchScope(req), body) });
  }),
);

leadsRouter.delete(
  '/pins/:id',
  sellers,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    if (!req.user) throw unauthorized();

    await deletePin(id, req.user, resolveBranchScope(req));
    res.status(204).end();
  }),
);

/** Signed houses. Every role: the crew's route is built from these. */
leadsRouter.get(
  '/customers',
  asyncHandler(async (req, res) => {
    const { branch_id, ...bounds } = parse(boundsSchema, req.query);
    res.json({ data: await listCustomerPins(resolveBranchScope(req, branch_id), bounds) });
  }),
);
