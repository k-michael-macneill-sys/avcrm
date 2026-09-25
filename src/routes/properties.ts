import { Router } from 'express';
import { deleteProperty } from '../services/deletion';
import { z } from 'zod';
import {
  requireAuth,
  resolveBranchScope,
  sellersWrite,
  resolveDeleter,
} from '../middleware/auth';
import {
  createProperty,
  findDuplicateAddress,
  getProperty,
  listProperties,
  updateProperty,
} from '../services/properties';
import { asyncHandler } from '../utils/async';
import { paginationSchema } from '../utils/pagination';
import { parse } from '../utils/validate';

export const propertiesRouter = Router();

propertiesRouter.use(requireAuth, sellersWrite);

const idParamSchema = z.object({ id: z.string().uuid('id must be a UUID') });

const booleanish = z
  .union([z.boolean(), z.enum(['true', 'false'])])
  .transform((v) => v === true || v === 'true');

const listQuerySchema = paginationSchema.extend({
  branch_id: z.string().uuid().optional(),
  customer_id: z.string().uuid().optional(),
  priority_flag: booleanish.optional(),
  search: z.string().trim().min(1).max(200).optional(),
});

const addressFields = {
  address_line1: z.string().trim().min(1).max(200),
  address_line2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(120),
  province: z.string().trim().min(2).max(60),
  postal_code: z.string().trim().min(3).max(12),
};

const createBodySchema = z.object({
  customer_id: z.string().uuid(),
  ...addressFields,
  latitude: z.number().min(-90).max(90).nullable().default(null),
  longitude: z.number().min(-180).max(180).nullable().default(null),
  // Dropdown 1-6, where 6 means "6+".
  driveway_size_cars: z.number().int().min(1).max(6).nullable().default(null),
  access_notes: z.string().trim().max(2000).nullable().default(null),
  priority_flag: z.boolean().default(false),
});

const updateBodySchema = z.object({
  address_line1: z.string().trim().min(1).max(200).optional(),
  address_line2: z.string().trim().max(200).nullable().optional(),
  city: z.string().trim().min(1).max(120).optional(),
  province: z.string().trim().min(2).max(60).optional(),
  postal_code: z.string().trim().min(3).max(12).optional(),
  latitude: z.number().min(-90).max(90).nullable().optional(),
  longitude: z.number().min(-180).max(180).nullable().optional(),
  driveway_size_cars: z.number().int().min(1).max(6).nullable().optional(),
  access_notes: z.string().trim().max(2000).nullable().optional(),
  priority_flag: z.boolean().optional(),
});

const duplicateQuerySchema = z.object({
  postal_code: z.string().trim().min(3).max(12),
  address_line1: z.string().trim().min(1).max(200),
});

propertiesRouter.get(
  '/',
  asyncHandler(async (req, res) => {
    const query = parse(listQuerySchema, req.query);
    const scope = resolveBranchScope(req, query.branch_id);

    res.json(
      await listProperties(
        scope,
        {
          customer_id: query.customer_id,
          priority_flag: query.priority_flag,
          search: query.search,
        },
        { page: query.page, page_size: query.page_size },
      ),
    );
  }),
);

/**
 * Duplicate pre-check, so a rep sees the warning at the door rather than
 * discovering it when the contract fails to save. Returns 200 either way;
 * `duplicate` is null when the address is clear.
 */
propertiesRouter.get(
  '/check-duplicate',
  asyncHandler(async (req, res) => {
    const query = parse(duplicateQuerySchema, req.query);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);

    const duplicate = await findDuplicateAddress(
      query.postal_code,
      query.address_line1,
      scope,
    );

    res.json({ data: { duplicate } });
  }),
);

propertiesRouter.get(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await getProperty(id, scope) });
  }),
);

propertiesRouter.post(
  '/',
  asyncHandler(async (req, res) => {
    const body = parse(createBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    const { customer_id, ...input } = body;

    const property = await createProperty(customer_id, scope, {
      ...input,
      address_line2: input.address_line2 ?? null,
    });

    res.status(201).json({ data: property });
  }),
);

propertiesRouter.patch(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const body = parse(updateBodySchema, req.body);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    res.json({ data: await updateProperty(id, scope, body) });
  }),
);

propertiesRouter.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const { id } = parse(idParamSchema, req.params);
    const scope = resolveBranchScope(req, req.query.branch_id as string | undefined);
    await deleteProperty(id, scope, resolveDeleter(req));
    res.status(204).send();
  }),
);
