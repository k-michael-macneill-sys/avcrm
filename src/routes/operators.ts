import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db/client';
import { requireAuth, requireCorporate, resolveBranchScope } from '../middleware/auth';
import {
  listOperatorDocuments,
  listOperators,
  operatorCompliance,
  requirementsForProvince,
  reviewDocument,
  submitDocument,
} from '../services/operators';
import { asyncHandler } from '../utils/async';
import { forbidden, notFound, unauthorized } from '../utils/errors';
import { parse } from '../utils/validate';
import type { Request } from 'express';

export const operatorsRouter = Router();
export const documentRequirementsRouter = Router();

operatorsRouter.use(requireAuth);
documentRequirementsRouter.use(requireAuth);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });
const documentIdParamSchema = z.object({
  documentId: z.string().uuid('documentId must be a UUID'),
});

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

const listQuerySchema = z.object({
  branch_id: z.string().uuid().optional(),
  /** Only operators eligible for work order assignment (build step 4). */
  assignable: booleanish.optional(),
});

const submitSchema = z.object({
  requirement_code: z.string().trim().min(1).max(60),
  // Object storage key in a private bucket; the upload itself happens before
  // this call and is not proxied through the API.
  file_url: z.string().trim().min(1).max(1000),
  file_name: z.string().trim().min(1).max(255),
  mime_type: z.string().trim().min(1).max(120),
  file_size: z.number().int().positive().max(50 * 1024 * 1024),
  issued_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  expires_on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
});

const reviewSchema = z.object({
  status: z.enum(['approved', 'rejected']),
  rejection_reason: z.string().trim().min(1).max(1000).nullable().default(null),
});

/** An operator may see and act on their own record; corporate on anyone's. */
async function assertCanSeeOperator(req: Request, operatorId: string): Promise<void> {
  if (!req.user) throw unauthorized();
  if (req.user.role === 'corporate') return;
  if (req.user.id !== operatorId) {
    throw forbidden('You may only access your own operator record');
  }
}

documentRequirementsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const province = z
      .string()
      .trim()
      .min(2)
      .max(60)
      .optional()
      .parse(req.query.province);

    if (province) {
      res.json({ data: await requirementsForProvince(province) });
      return;
    }

    res.json({ data: await db('document_requirements').orderBy('code', 'asc').select('*') });
  }),
);

operatorsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);
    res.json({ data: await listOperators(scope, { assignable: query.assignable }) });
  }),
);

/**
 * Corporate reviews a submitted document. Declared before /:id/documents so
 * the literal path is never read as an operator id.
 */
operatorsRouter.patch(
  '/documents/:documentId/review',
  requireCorporate,
  asyncHandler(async (req, res) => {
    const { documentId } = parse(documentIdParamSchema, req.params);
    const body = parse(reviewSchema, req.body);
    if (!req.user) throw unauthorized();

    const document = await reviewDocument(documentId, req.user.id, {
      status: body.status,
      rejection_reason: body.rejection_reason,
    });

    res.json({ data: document });
  }),
);

operatorsRouter.get(
  '/:id/compliance',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    await assertCanSeeOperator(req, id);
    res.json({ data: await operatorCompliance(id) });
  }),
);

operatorsRouter.get(
  '/:id/documents',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    await assertCanSeeOperator(req, id);
    res.json({ data: await listOperatorDocuments(id) });
  }),
);

operatorsRouter.post(
  '/:id/documents',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(submitSchema, req.body);
    await assertCanSeeOperator(req, id);

    const operator = await db('users').where({ id }).first('id', 'role');
    if (!operator) throw notFound('Operator not found');

    res.status(201).json({ data: await submitDocument(id, body) });
  }),
);
