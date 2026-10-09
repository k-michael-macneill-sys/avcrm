import { Router } from 'express';
import { deleteCustomer } from '../services/deletion';
import { z } from 'zod';
import {
  requireAuth,
  resolveActor,
  resolveBranchScope,
  resolveWriteBranch,
  sellersWrite,
  resolveDeleter,
} from '../middleware/auth';
import {
  addNote,
  assignSmsThread,
  getCustomerSummary,
  listNotes,
  sendCustomerSms,
  setPhones,
  setSmsOptOut,
  smsThread,
  threadAssignees,
} from '../services/customerProfile';
import { createAgreement } from '../services/serviceAgreements';
import { NOTE_KINDS, PHONE_TYPES } from '../types/serviceAgreement';
import { agreementBodySchema } from './serviceAgreements';
import {
  createCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from '../services/customers';
import { listProperties } from '../services/properties';
import { CUSTOMER_STATUSES, PREFERRED_CONTACTS } from '../types/models';
import { asyncHandler } from '../utils/async';
import { unauthorized } from '../utils/errors';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const customersRouter = Router();

customersRouter.use(requireAuth, sellersWrite);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
  created_by_user_id: z.string().uuid().optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

const contactFields = {
  email: z.string().trim().email().max(255).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  preferred_contact: z.enum(PREFERRED_CONTACTS).default('email'),
};

const createBodySchema = z
  .object({
    branch_id: z.string().uuid().optional(),
    first_name: z.string().trim().min(1).max(100),
    last_name: z.string().trim().min(1).max(100),
    notes: z.string().trim().max(5000).nullable().optional(),
    status: z.enum(CUSTOMER_STATUSES).default('lead'),
    ...contactFields,
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

const billingFields = {
  billing_address_line1: z.string().trim().max(200).nullable().optional(),
  billing_address_line2: z.string().trim().max(200).nullable().optional(),
  billing_city: z.string().trim().max(100).nullable().optional(),
  billing_province: z.string().trim().max(40).nullable().optional(),
  billing_postal_code: z.string().trim().max(20).nullable().optional(),
};

const updateBodySchema = z.object({
  ...billingFields,
  first_name: z.string().trim().min(1).max(100).optional(),
  last_name: z.string().trim().min(1).max(100).optional(),
  email: z.string().trim().email().max(255).nullable().optional(),
  phone: z.string().trim().max(40).nullable().optional(),
  preferred_contact: z.enum(PREFERRED_CONTACTS).optional(),
  notes: z.string().trim().max(5000).nullable().optional(),
  status: z.enum(CUSTOMER_STATUSES).optional(),
});

customersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    const result = await listCustomers(
      scope,
      {
        status: query.status,
        created_by_user_id: query.created_by_user_id,
        search: query.search,
      },
      { page: query.page, page_size: query.page_size },
    );

    res.json(result);
  }),
);

customersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await getCustomer(id, scope) });
  }),
);

/** Convenience for the property list of one customer. */
customersRouter.get(
  '/:id/properties',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const query = parse(paginationSchema, req.query);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    // 404s if the customer is outside the caller's scope.
    await getCustomer(id, scope);

    res.json(await listProperties(scope, { customer_id: id }, query));
  }),
);

customersRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parse(createBodySchema, req.body);
    const branchId = resolveWriteBranch(req, body.branch_id);
    if (!req.user) throw unauthorized();

    const customer = await createCustomer(branchId, req.user.id, {
      first_name: body.first_name,
      last_name: body.last_name,
      email: body.email ?? null,
      phone: body.phone ?? null,
      preferred_contact: body.preferred_contact,
      notes: body.notes ?? null,
      status: body.status,
    });

    res.status(201).json({ data: customer });
  }),
);

customersRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await updateCustomer(id, scope, body) });
  }),
);

/** The word typed into the confirmation box, checked here too. */
const deleteQuerySchema = z.object({
  confirm: z.literal('DELETE', {
    errorMap: () => ({ message: 'Type DELETE to confirm deleting this customer' }),
  }),
});

customersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    parse(deleteQuerySchema, { confirm: req.query.confirm });
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    await deleteCustomer(id, scope, resolveDeleter(req));
    res.status(204).send();
  }),
);

// ── The Customer Summary page ─────────────────────────────────────────────

customersRouter.get(
  '/:id/summary',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await getCustomerSummary(id, scope) });
  }),
);

const phonesBodySchema = z.object({
  phones: z
    .array(
      z.object({
        number: z.string().trim().max(40),
        phone_type: z.enum(PHONE_TYPES),
        is_primary: z.boolean().default(false),
      }),
    )
    .max(10),
});

customersRouter.put(
  '/:id/phones',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const { phones } = parse(phonesBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await setPhones(id, scope, phones, resolveActor(req)) });
  }),
);

const notesQuerySchema = paginationSchema.extend({
  kind: z.enum(NOTE_KINDS).default('account'),
  search: z.string().trim().min(1).max(200).optional(),
});

customersRouter.get(
  '/:id/notes',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const query = parse(notesQuerySchema, req.query);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json(await listNotes(id, scope, query.kind, query.search, { page: query.page, page_size: query.page_size }));
  }),
);

const noteBodySchema = z.object({
  kind: z.enum(NOTE_KINDS),
  body: z.string().trim().min(1).max(5000),
});

/** Account notes for the office; operator notes (gate codes, where to pile snow) for the crews. */
customersRouter.post(
  '/:id/notes',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(noteBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.status(201).json({ data: await addNote(id, scope, body.kind, body.body, resolveActor(req)) });
  }),
);

customersRouter.get(
  '/:id/sms',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await smsThread(id, scope) });
  }),
);

customersRouter.get(
  '/:id/sms/assignees',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await threadAssignees(id, scope) });
  }),
);

const smsBodySchema = z.object({
  body: z.string().trim().min(1).max(1600),
  /** "Send later". Absent or null sends now. */
  send_at: z
    .string()
    .datetime({ offset: true })
    .transform((v) => new Date(v))
    .nullable()
    .optional(),
});

customersRouter.post(
  '/:id/sms',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(smsBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res
      .status(201)
      .json({ data: await sendCustomerSms(id, scope, { body: body.body, send_at: body.send_at ?? null }, resolveActor(req)) });
  }),
);

const smsSettingsSchema = z
  .object({
    assigned_user_id: z.string().uuid().nullable().optional(),
    opt_out: z.boolean().optional(),
  })
  .refine((v) => v.assigned_user_id !== undefined || v.opt_out !== undefined, { message: 'Nothing to change' });

customersRouter.patch(
  '/:id/sms',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(smsSettingsSchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    if (body.opt_out !== undefined) await setSmsOptOut(id, scope, body.opt_out);
    if (body.assigned_user_id !== undefined) {
      await assignSmsThread(id, scope, body.assigned_user_id, resolveActor(req));
    }
    res.json({ data: await getCustomerSummary(id, scope) });
  }),
);

/** The contract form: a new service agreement for this customer. */
customersRouter.post(
  '/:id/agreements',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(agreementBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.status(201).json({ data: await createAgreement(id, scope, body, resolveActor(req)) });
  }),
);
