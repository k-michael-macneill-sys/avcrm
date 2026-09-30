import { Router } from 'express';
import { deleteCustomer } from '../services/deletion';
import { z } from 'zod';
import {
  requireAuth,
  resolveBranchScope,
  resolveWriteBranch,
  sellersWrite,
  resolveDeleter,
} from '../middleware/auth';
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

const updateBodySchema = z.object({
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

customersRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    await deleteCustomer(id, scope, resolveDeleter(req));
    res.status(204).send();
  }),
);
