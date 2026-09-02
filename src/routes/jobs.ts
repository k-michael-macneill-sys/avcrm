import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, resolveBranchScope } from '../middleware/auth';
import { createJob, getJob, listJobs, updateJobStatus } from '../services/jobs';
import { JOB_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const jobsRouter = Router();

jobsRouter.use(requireAuth);

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  status: z.enum(JOB_STATUSES).optional(),
  customer_id: z.string().uuid().optional(),
  scheduled_from: z.string().datetime().optional(),
  scheduled_to: z.string().datetime().optional(),
});

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const createBodySchema = z.object({
  branch_id: z.string().uuid().optional(),
  customer_id: z.string().uuid(),
  status: z.enum(JOB_STATUSES).default('scheduled'),
  scheduled_date: z.string().datetime().nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
});

const statusBodySchema = z.object({ status: z.enum(JOB_STATUSES) });

jobsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const branchId = resolveBranchScope(req, query.branch_id);

    const result = await listJobs(
      branchId,
      {
        status: query.status,
        customer_id: query.customer_id,
        scheduled_from: query.scheduled_from,
        scheduled_to: query.scheduled_to,
      },
      { page: query.page, page_size: query.page_size },
    );

    res.json(result);
  }),
);

jobsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const branchId = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await getJob(id, branchId) });
  }),
);

jobsRouter.post(
  '/',
  requireRole('admin', 'manager', 'dispatcher'),
  asyncHandler(async (req, res) => {
    const body = parse(createBodySchema, req.body);
    const branchId = resolveBranchScope(req, body.branch_id);

    const job = await createJob(branchId, {
      customer_id: body.customer_id,
      status: body.status,
      scheduled_date: body.scheduled_date,
      notes: body.notes,
    });

    res.status(201).json({ data: job });
  }),
);

jobsRouter.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(statusBodySchema, req.body);
    const branchId = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await updateJobStatus(id, branchId, body.status) });
  }),
);
