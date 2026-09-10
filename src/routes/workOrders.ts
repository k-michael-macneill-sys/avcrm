import { Router } from 'express';
import { z } from 'zod';
import {
  requireAuth,
  requireCorporate,
  resolveBranchScope,
  resolveCrewActor,
} from '../middleware/auth';
import {
  addServicePhoto,
  changeWorkOrderStatus,
  createWorkOrder,
  getWorkOrder,
  listPhotos,
  listWorkOrders,
  updateWorkOrder,
} from '../services/workOrders';
import { PHOTO_TYPES, SERVICE_TYPES, WORK_ORDER_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const workOrdersRouter = Router();

workOrdersRouter.use(requireAuth);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const timestamp = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v));

/**
 * A photo's taken_at comes from the image EXIF, so it is normally in the past
 * — an operator finishes the street and uploads from the truck. A minute of
 * clock skew is tolerated; further ahead means a broken clock.
 */
const pastTimestamp = timestamp.refine((d) => d.getTime() <= Date.now() + 60_000, {
  message: 'cannot be in the future',
});

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  contract_id: z.string().uuid().optional(),
  property_id: z.string().uuid().optional(),
  assigned_user_id: z.string().uuid().optional(),
  status: z.enum(WORK_ORDER_STATUSES).optional(),
  service_type: z.enum(SERVICE_TYPES).optional(),
  scheduled_from: timestamp.optional(),
  scheduled_to: timestamp.optional(),
});

const createBodySchema = z.object({
  contract_id: z.string().uuid(),
  assigned_user_id: z.string().uuid().nullable().default(null),
  scheduled_for: timestamp,
  service_type: z.enum(SERVICE_TYPES),
  operator_notes: z.string().trim().max(5000).nullable().default(null),
});

const updateBodySchema = z.object({
  assigned_user_id: z.string().uuid().nullable().optional(),
  scheduled_for: timestamp.optional(),
  service_type: z.enum(SERVICE_TYPES).optional(),
  operator_notes: z.string().trim().max(5000).nullable().optional(),
});

const statusBodySchema = z.object({
  status: z.enum(WORK_ORDER_STATUSES),
  skip_reason: z.string().trim().min(1).max(1000).nullable().optional(),
  operator_notes: z.string().trim().max(5000).nullable().optional(),
});

const photoBodySchema = z.object({
  photo_type: z.enum(PHOTO_TYPES),
  // Object storage key, not a public URL.
  file_url: z.string().trim().min(1).max(500),
  taken_at: pastTimestamp,
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
});

const branchOf = (req: { query: Record<string, unknown> }) =>
  req.query.branch_id as string | undefined;

workOrdersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json(
      await listWorkOrders(
        scope,
        {
          contract_id: query.contract_id,
          property_id: query.property_id,
          assigned_user_id: query.assigned_user_id,
          status: query.status,
          service_type: query.service_type,
          scheduled_from: query.scheduled_from,
          scheduled_to: query.scheduled_to,
        },
        { page: query.page, page_size: query.page_size },
      ),
    );
  }),
);

workOrdersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    res.json({ data: await getWorkOrder(id, resolveBranchScope(req, branchOf(req))) });
  }),
);

workOrdersRouter.get(
  '/:id/photos',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    // 404s if the visit is outside the caller's scope.
    await getWorkOrder(id, resolveBranchScope(req, branchOf(req)));
    res.json({ data: await listPhotos(id) });
  }),
);

/** Dispatch. Assigning an unapproved operator is refused by the onboarding gate. */
workOrdersRouter.post(
  '/',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const body = parse(createBodySchema, req.body);
    const scope = resolveBranchScope(req, branchOf(req));
    const { contract_id, ...input } = body;

    res.status(201).json({ data: await createWorkOrder(contract_id, scope, input) });
  }),
);

/** Rescheduling and reassignment are dispatch decisions, so corporate only. */
workOrdersRouter.patch(
  '/:id',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateBodySchema, req.body);
    const scope = resolveBranchScope(req, branchOf(req));

    res.json({ data: await updateWorkOrder(id, scope, body) });
  }),
);

/**
 * The operator's own screen. Completing needs a before and an after photo, and
 * fires the completion email to the customer and the branch manager.
 */
workOrdersRouter.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(statusBodySchema, req.body);
    const scope = resolveBranchScope(req, branchOf(req));

    res.json({
      data: await changeWorkOrderStatus(id, scope, resolveCrewActor(req), body),
    });
  }),
);

workOrdersRouter.post(
  '/:id/photos',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(photoBodySchema, req.body);
    const scope = resolveBranchScope(req, branchOf(req));

    res.status(201).json({
      data: await addServicePhoto(id, scope, resolveCrewActor(req), body),
    });
  }),
);
