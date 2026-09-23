import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, resolveActor, resolveBranchScope, resolveWriteBranch } from '../middleware/auth';
import { openDeal, settleCollectedPayment } from '../services/sales';
import { requestSignature } from '../services/signing';
import { BILLING_TYPES, CUSTOMER_STATUSES, PREFERRED_CONTACTS } from '../types/models';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
import { parse } from '../utils/validate';

/**
 * The sales flow's own endpoint. Everything here can be done through
 * /customers, /properties and /quotes one at a time; this exists because the
 * rep at the door is doing one thing, not three, and a half-finished deal is
 * worse than a failed one.
 */
export const salesRouter = Router();

salesRouter.use(requireAuth);

const money = z
  .number()
  .min(0)
  .max(99_999_999.99)
  .refine((v) => Math.abs(v * 100 - Math.round(v * 100)) < 1e-6, {
    message: 'must be a whole number of cents',
  });

const isoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'must be a YYYY-MM-DD date')
  .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), {
    message: 'must be a real date',
  });

const customerSchema = z
  .object({
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(255).nullable().default(null),
    phone: z.string().trim().max(40).nullable().default(null),
    preferred_contact: z.enum(PREFERRED_CONTACTS).default('email'),
    notes: z.string().trim().max(5000).nullable().default(null),
    // Signing today, so active rather than the lead default.
    status: z.enum(CUSTOMER_STATUSES).default('active'),
  })
  .refine((v) => v.preferred_contact !== 'email' || !!v.email, {
    message: 'email is required when preferred_contact is "email"',
    path: ['email'],
  })
  .refine((v) => v.preferred_contact !== 'sms' || !!v.phone, {
    message: 'phone is required when preferred_contact is "sms"',
    path: ['phone'],
  })
  .refine((v) => v.preferred_contact !== 'both' || (!!v.email && !!v.phone), {
    message: 'email and phone are both required when preferred_contact is "both"',
    path: ['preferred_contact'],
  });

const propertySchema = z.object({
  address_line1: z.string().trim().min(1).max(200),
  // The unit or apartment number, where there is one.
  address_line2: z.string().trim().max(200).nullable().default(null),
  city: z.string().trim().min(1).max(120),
  province: z.string().trim().min(2).max(60),
  postal_code: z.string().trim().min(3).max(12),
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  driveway_size_cars: z.number().int().min(1).max(6).nullable().default(null),
  /**
   * The permanent job notes: gate codes, where to pile the snow, the dog.
   * They live on the property so every future visit shows them, not just
   * the first one.
   */
  access_notes: z.string().trim().max(5000).nullable().default(null),
  priority_flag: z.boolean().default(false),
});

const quoteSchema = z
  .object({
    billing_type: z.enum(BILLING_TYPES),
    initial_price: money,
    discounted_price: money,
    recurring_price: money.nullable().default(null),
    season_start: isoDate,
    season_end: isoDate,
    /** The initial job notes: what this first visit in particular needs. */
    notes: z.string().trim().max(5000).nullable().default(null),
    addon_salt: z.boolean().default(false),
    addon_vehicle: z.boolean().default(false),
    addon_stairs: z.boolean().default(false),
  })
  .refine((v) => v.discounted_price <= v.initial_price, {
    message: 'discounted_price cannot be higher than initial_price',
    path: ['discounted_price'],
  })
  .refine((v) => v.season_end > v.season_start, {
    message: 'season_end must fall after season_start',
    path: ['season_end'],
  })
  .refine((v) => v.recurring_price === null || v.billing_type === 'monthly', {
    message: 'recurring_price applies to monthly billing only: seasonal is one payment',
    path: ['recurring_price'],
  });

const openDealSchema = z
  .object({
    branch_id: z.string().uuid().optional(),
    customer: customerSchema.optional(),
    customer_id: z.string().uuid().optional(),
    property: propertySchema,
    quote: quoteSchema,
  })
  .refine((v) => !!v.customer !== !!v.customer_id, {
    message: 'Provide either customer (new) or customer_id (an existing lead), not both',
    path: ['customer'],
  });

/**
 * Pages one and two of the sales flow, in one transaction: who they are,
 * where they live, and what they are being sold.
 */
salesRouter.post(
  '/deals',
  asyncHandler(async (req, res) => {
    const body = parse(openDealSchema, req.body);
    if (!req.user) throw unauthorized();

    const scope = resolveBranchScope(req, body.branch_id);
    // A new customer is filed in the caller's branch, or the one corporate
    // named. A lead being converted already has one, and it is not moved.
    const branchId = body.customer_id ? null : resolveWriteBranch(req, body.branch_id);

    const result = await openDeal(
      branchId,
      req.user.id,
      scope,
      {
        customer: body.customer,
        customer_id: body.customer_id,
        property: body.property,
        quote: body.quote,
      },
      resolveActor(req),
    );

    res.status(201).json({ data: result });
  }),
);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

/**
 * "Email completion": for a customer who is not standing in front of the rep.
 * Sends them a link to sign and add their card themselves.
 */
salesRouter.post(
  '/quotes/:id/signing-request',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    if (!req.user) throw unauthorized();
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    const result = await requestSignature(id, scope, req.user.id);
    res.status(201).json({
      data: { request: result.request, url: result.url, sent_to: result.request.sent_to },
    });
  }),
);

const collectedSchema = z.object({ method: z.enum(['cash', 'cheque']) });

/** The cash or cheque a rep took at the door for a seasonal contract. */
salesRouter.post(
  '/contracts/:id/collected-payment',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(collectedSchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    res.status(201).json({
      data: await settleCollectedPayment(id, scope, body.method, resolveActor(req)),
    });
  }),
);
