import { Router } from 'express';
import { z } from 'zod';
import { requireAuth, requireRole, resolveBranchScope } from '../middleware/auth';
import {
  createCustomer,
  deleteCustomer,
  getCustomer,
  listCustomers,
  updateCustomer,
} from '../services/customers';
import { CONTRACT_STATUSES } from '../types/models';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const customersRouter = Router();

// Everything below requires a valid bearer token.
customersRouter.use(requireAuth);

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  contract_status: z.enum(CONTRACT_STATUSES).optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional();

const createBodySchema = z.object({
  branch_id: z.string().uuid().optional(),
  name: z.string().trim().min(1).max(200),
  phone: optionalText(40),
  address: optionalText(500),
  email: z.string().trim().email().max(255).nullable().optional(),
  contract_status: z.enum(CONTRACT_STATUSES).default('none'),
});

const updateBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  phone: optionalText(40),
  address: optionalText(500),
  email: z.string().trim().email().max(255).nullable().optional(),
  contract_status: z.enum(CONTRACT_STATUSES).optional(),
});

customersRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const branchId = resolveBranchScope(req, query.branch_id);

    const result = await listCustomers(
      branchId,
      { contract_status: query.contract_status, search: query.search },
      { page: query.page, page_size: query.page_size },
    );

    res.json(result);
  }),
);

customersRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const branchId = resolveBranchScope(req, req.query.branch_id as string | undefined);
    const customer = await getCustomer(id, branchId);
    res.json({ data: customer });
  }),
);

customersRouter.post(
  '/',
  requireRole('admin', 'manager', 'dispatcher'),
  asyncHandler(async (req, res) => {
    const body = parse(createBodySchema, req.body);
    const branchId = resolveBranchScope(req, body.branch_id);

    const customer = await createCustomer(branchId, {
      name: body.name,
      phone: body.phone ?? null,
      address: body.address ?? null,
      email: body.email ?? null,
      contract_status: body.contract_status,
    });

    res.status(201).json({ data: customer });
  }),
);

customersRouter.patch(
  '/:id',
  requireRole('admin', 'manager', 'dispatcher'),
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateBodySchema, req.body);
    const branchId = resolveBranchScope(req, req.query.branch_id as string | undefined);

    const customer = await updateCustomer(id, branchId, body);
    res.json({ data: customer });
  }),
);

customersRouter.delete(
  '/:id',
  requireRole('admin', 'manager'),
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const branchId = resolveBranchScope(req, req.query.branch_id as string | undefined);
    await deleteCustomer(id, branchId);
    res.status(204).send();
  }),
);
