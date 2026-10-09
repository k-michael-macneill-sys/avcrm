import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, resolveActor, resolveBranchScope, sellersWrite } from '../middleware/auth';
import {
  agreementPreviewPdf,
  getAgreementForm,
  getAgreementModel,
  recordPaperAgreement,
  signAgreement,
  updateAgreement,
} from '../services/serviceAgreements';
import { SIGNATURE_BOXES } from '../types/serviceAgreement';
import { asyncHandler } from '../utils/async';
import { sendPdf } from '../utils/pdfResponse';
import { parse } from '../utils/validate';

/**
 * A service agreement, by the id of the quote it was written on: the form,
 * the document it generates, and signing it — on screen, or on paper and
 * uploaded. A new one is created from the customer, at
 * POST /customers/:id/agreements.
 */
export const serviceAgreementsRouter = Router();

serviceAgreementsRouter.use(requireAuth, sellersWrite);

const idParam = z.object({ id: z.string().uuid('id must be a UUID') });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a date like 2026-11-01');
const money = z.string().trim().max(20);

export const agreementBodySchema = z.object({
  property_id: z.string().uuid(),
  contract_type_id: z.string().uuid(),
  billing_plan_id: z.string().uuid(),
  package: z.enum(['basic', 'premium']),
  trigger_cm: z.number().min(0).max(100),
  season_start: isoDate,
  season_end: isoDate,
  assigned_operator_id: z.string().uuid().nullable().default(null),
  service_route_id: z.string().uuid().nullable().default(null),
  scope_item_ids: z.array(z.string().uuid()).max(100),
  addons: z.array(z.object({ addon_service_id: z.string().uuid(), price: money })).max(100).default([]),
  tag_ids: z.array(z.string().uuid()).max(50).default([]),
  normal_price: money,
  discount: money.default('0'),
  referral_credit: money.nullable().default(null),
  referred_by_customer_id: z.string().uuid().nullable().default(null),
  tax_code_id: z.string().uuid(),
  route_code: z.string().trim().max(60).nullable().default(null),
  driveway_car_lengths: z.number().int().min(1).max(20).nullable().default(null),
  driveway_width: z.enum(['single', 'double', 'triple']).nullable().default(null),
  property_notes: z.string().trim().max(2000).nullable().default(null),
  auto_renew: z.boolean().default(true),
});

const checklist = z.array(z.object({ item_code: z.string().trim().min(1), checked: z.boolean() })).default([]);

const signBodySchema = z.object({
  signature_key: z.string().trim().min(1).max(500),
  signer_name: z.string().trim().min(1).max(200),
  boxes: z.array(z.enum(SIGNATURE_BOXES)).min(1),
  signed_lat: z.number().min(-90).max(90).nullable().default(null),
  signed_lng: z.number().min(-180).max(180).nullable().default(null),
  checklist,
});

const paperBodySchema = z.object({
  pdf_key: z.string().trim().min(1).max(500),
  signer_name: z.string().trim().min(1).max(200),
  checklist,
});

const scopeOf = (req: Parameters<typeof resolveBranchScope>[0]) =>
  resolveBranchScope(req, req.query.branch_id as string | undefined);

serviceAgreementsRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json({ data: await getAgreementForm(id, scopeOf(req)) });
  }),
);

serviceAgreementsRouter.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(agreementBodySchema, req.body);
    res.json({ data: await updateAgreement(id, scopeOf(req), body, resolveActor(req)) });
  }),
);

/** Everything the agreement prints, for drawing it on the signing screen. */
serviceAgreementsRouter.get(
  '/:id/document',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParam, req.params);
    res.json({ data: await getAgreementModel(id, scopeOf(req)) });
  }),
);

/** The agreement as a PDF, unsigned: for printing a paper copy, or a look before signing. */
serviceAgreementsRouter.get(
  '/:id/preview.pdf',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParam, req.params);
    sendPdf(res, { bytes: await agreementPreviewPdf(id, scopeOf(req)), file_name: 'service-agreement.pdf' });
  }),
);

serviceAgreementsRouter.post(
  '/:id/sign',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(signBodySchema, req.body);
    res.status(201).json({ data: await signAgreement(id, scopeOf(req), body, resolveActor(req)) });
  }),
);

serviceAgreementsRouter.post(
  '/:id/paper',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParam, req.params);
    const body = parse(paperBodySchema, req.body);
    res.status(201).json({ data: await recordPaperAgreement(id, scopeOf(req), body, resolveActor(req)) });
  }),
);
