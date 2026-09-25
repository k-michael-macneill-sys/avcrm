import { Router } from 'express';
import { z } from 'zod';
import {
  requireAuth,
  resolveActor,
  resolveBranchScope,
  sellersWrite,
} from '../middleware/auth';
import {
  changeContractStatus,
  createContract,
  getContract,
  listChecklistRequirements,
  listContracts,
  setChecklistItem,
  updateContract,
} from '../services/contracts';
import { CONTRACT_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const contractsRouter = Router();

contractsRouter.use(requireAuth, sellersWrite);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const checklistParamSchema = idParamSchema.extend({
  itemCode: z.string().trim().min(1).max(60),
});

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  status: z.enum(CONTRACT_STATUSES).optional(),
  customer_id: z.string().uuid().optional(),
  property_id: z.string().uuid().optional(),
  quote_id: z.string().uuid().optional(),
});

/**
 * The rep's device supplies the time it was signed, because the tablet may be
 * offline at the door and sync later. A minute of clock skew is tolerated;
 * anything further into the future is a broken clock, not a signature.
 */
const signedAt = z
  .string()
  .datetime({ offset: true })
  .transform((v) => new Date(v))
  .refine((d) => d.getTime() <= Date.now() + 60_000, {
    message: 'signed_at cannot be in the future',
  });

const paymentFields = {
  // A processor token. Raw card data is rejected by the service and by a
  // check constraint on the column.
  payment_method_token: z.string().trim().min(1).max(255).nullable().optional(),
  payment_method_last4: z
    .string()
    .trim()
    .regex(/^\d{4}$/, 'must be the last 4 digits')
    .nullable()
    .optional(),
  payment_method_brand: z.string().trim().min(1).max(40).nullable().optional(),
};

const createBodySchema = z.object({
  quote_id: z.string().uuid(),
  // Object storage key for the captured signature image.
  signature_image_url: z.string().trim().min(1).max(500),
  signed_at: signedAt.optional(),
  signed_lat: z.number().min(-90).max(90).nullable().default(null),
  signed_lng: z.number().min(-180).max(180).nullable().default(null),
  terms_version: z.string().trim().min(1).max(40),
  ...paymentFields,
  checklist: z
    .array(z.object({ item_code: z.string().trim().min(1), checked: z.boolean() }))
    .default([]),
});

const updateBodySchema = z.object({
  pdf_url: z.string().trim().min(1).max(500).nullable().optional(),
  ...paymentFields,
});

const statusBodySchema = z.object({ status: z.enum(CONTRACT_STATUSES) });

const checklistBodySchema = z.object({ checked: z.boolean() });

contractsRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json(
      await listContracts(
        scope,
        {
          status: query.status,
          customer_id: query.customer_id,
          property_id: query.property_id,
          quote_id: query.quote_id,
        },
        { page: query.page, page_size: query.page_size },
      ),
    );
  }),
);

contractsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await getContract(id, scope) });
  }),
);

/**
 * Signature capture. The quote must have been presented, and every required
 * checklist item must be ticked, or this returns 400 naming the ones that are
 * not.
 */
contractsRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parse(createBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    const contract = await createContract(
      body.quote_id,
      scope,
      {
        signature_image_url: body.signature_image_url,
        signed_at: body.signed_at ?? null,
        signed_lat: body.signed_lat,
        signed_lng: body.signed_lng,
        terms_version: body.terms_version,
        payment_method_token: body.payment_method_token ?? null,
        payment_method_last4: body.payment_method_last4 ?? null,
        payment_method_brand: body.payment_method_brand ?? null,
        checklist: body.checklist,
      },
      resolveActor(req),
    );

    res.status(201).json({ data: contract });
  }),
);

contractsRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    res.json({ data: await updateContract(id, scope, body, resolveActor(req)) });
  }),
);

contractsRouter.patch(
  '/:id/status',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const { status } = parse(statusBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    res.json({ data: await changeContractStatus(id, scope, status, resolveActor(req)) });
  }),
);

/** Ticking one of the optional boxes after the fact. */
contractsRouter.patch(
  '/:id/checklist/:itemCode',
  asyncHandler(async (req, res) => {
    const { id, itemCode } = parse(checklistParamSchema, req.params);
    const { checked } = parse(checklistBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    res.json({
      data: await setChecklistItem(id, itemCode, checked, scope, resolveActor(req)),
    });
  }),
);

/**
 * The checkbox list itself, seeded from config so the signature screen can
 * render it without a deploy. Mounted at /checklist-requirements, the same
 * way document requirements are.
 */
export const checklistRequirementsRouter = Router();

checklistRequirementsRouter.use(requireAuth);

checklistRequirementsRouter.get(
  '/',
  asyncHandler(async (_req, res) => {
    res.json({ data: await listChecklistRequirements() });
  }),
);
