import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type {
  PhotoType,
  ServicePhoto,
  ServiceType,
  WorkOrder,
  WorkOrderStatus,
} from '../types/models';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { isPgError, PG_UNIQUE_VIOLATION } from '../utils/pg';
import { applyBranchScope } from '../utils/scope';
import { logger } from '../utils/logger';
import { enqueueMessage } from './messages';
import { assertOperatorAssignable } from './operators';

/**
 * Where a visit may go from where it is. `scheduled` straight to
 * `in_progress` is allowed on purpose: an operator who starts clearing before
 * remembering to tap "en route" should not be blocked by the app.
 *
 * A skip is available right up until the job is finished, because the reason
 * to skip one — a car parked across the drive — is usually discovered on site.
 */
const TRANSITIONS: Record<WorkOrderStatus, WorkOrderStatus[]> = {
  scheduled: ['en_route', 'in_progress', 'skipped'],
  en_route: ['in_progress', 'skipped'],
  in_progress: ['completed', 'skipped'],
  completed: [],
  skipped: [],
};

/** Photos can only be added while the visit is still open. */
const OPEN_STATUSES: WorkOrderStatus[] = ['scheduled', 'en_route', 'in_progress'];

/**
 * How far a photo's geotag may sit from the property before we refuse it.
 *
 * Generous on purpose. Phone GPS drifts badly between buildings and in heavy
 * snow, and a rejected upload strands an operator who did the work. Half a
 * kilometre still catches the case this exists for: a photo taken somewhere
 * other than the address being billed.
 */
const GEOTAG_RADIUS_M = 500;

/** The caller as these rules see them: who, and whether they dispatch. */
export interface CrewActor {
  user_id: string;
  is_corporate: boolean;
}

export interface WorkOrderFilters {
  contract_id?: string;
  property_id?: string;
  assigned_user_id?: string;
  status?: WorkOrderStatus;
  service_type?: ServiceType;
  /** Inclusive window over scheduled_for, for the day's dispatch board. */
  scheduled_from?: Date;
  scheduled_to?: Date;
}

export interface WorkOrderInput {
  assigned_user_id: string | null;
  scheduled_for: Date;
  service_type: ServiceType;
  operator_notes: string | null;
}

export interface WorkOrderWithPhotos extends WorkOrder {
  photos: ServicePhoto[];
}

/** branch_id is denormalized onto the row, so scoping needs no join. */
function scoped(db: Knex, scope: BranchScope) {
  return applyBranchScope(db('work_orders'), 'work_orders.branch_id', scope);
}

export async function listWorkOrders(
  scope: BranchScope,
  filters: WorkOrderFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<WorkOrder>> {
  const base = scoped(db, scope);

  if (filters.contract_id) base.andWhere('contract_id', filters.contract_id);
  if (filters.property_id) base.andWhere('property_id', filters.property_id);
  if (filters.assigned_user_id) base.andWhere('assigned_user_id', filters.assigned_user_id);
  if (filters.status) base.andWhere('status', filters.status);
  if (filters.service_type) base.andWhere('service_type', filters.service_type);
  if (filters.scheduled_from) base.andWhere('scheduled_for', '>=', filters.scheduled_from);
  if (filters.scheduled_to) base.andWhere('scheduled_for', '<=', filters.scheduled_to);

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      // The run sheet reads in the order the crew drives it.
      .orderBy([
        { column: 'scheduled_for', order: 'asc' },
        { column: 'id', order: 'asc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('*'),
    base.clone().count<{ count: string }[]>({ count: '*' }).first(),
  ]);

  return paginated(rows as WorkOrder[], Number(countRow?.count ?? 0), pagination);
}

export async function getWorkOrder(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<WorkOrderWithPhotos> {
  const workOrder = await scoped(db, scope).andWhere('work_orders.id', id).first('*');
  if (!workOrder) {
    throw notFound('Work order not found');
  }
  return { ...(workOrder as WorkOrder), photos: await listPhotos(id, db) };
}

export async function listPhotos(
  workOrderId: string,
  db: Knex = defaultDb,
): Promise<ServicePhoto[]> {
  return db('service_photos')
    .where({ work_order_id: workOrderId })
    .orderBy([
      { column: 'taken_at', order: 'asc' },
      { column: 'id', order: 'asc' },
    ])
    .select('*');
}

/**
 * Dispatch. The property and branch come off the contract rather than the
 * request, so a work order cannot be filed against an address its contract
 * does not cover.
 */
export async function createWorkOrder(
  contractId: string,
  scope: BranchScope,
  input: WorkOrderInput,
  db: Knex = defaultDb,
): Promise<WorkOrderWithPhotos> {
  const contract = (await applyBranchScope(
    db('contracts').join('customers', 'customers.id', 'contracts.customer_id'),
    'customers.branch_id',
    scope,
  )
    .andWhere('contracts.id', contractId)
    .first([
      'contracts.id',
      'contracts.property_id',
      'contracts.status',
      'customers.branch_id as branch_id',
    ])) as
    | { id: string; property_id: string; status: string; branch_id: string }
    | undefined;

  if (!contract) {
    throw badRequest('contract_id does not match a contract you can access');
  }
  if (contract.status !== 'active') {
    throw conflict(`This contract is ${contract.status}, so no more visits can be booked`);
  }

  if (input.assigned_user_id) {
    await assertAssignable(input.assigned_user_id, contract.branch_id, db);
  }

  const [workOrder] = await db('work_orders')
    .insert({
      contract_id: contract.id,
      property_id: contract.property_id,
      branch_id: contract.branch_id,
      assigned_user_id: input.assigned_user_id,
      scheduled_for: input.scheduled_for,
      service_type: input.service_type,
      status: 'scheduled',
      operator_notes: input.operator_notes,
    })
    .returning('*');
  if (!workOrder) {
    throw new Error('Insert returned no work order row');
  }

  return { ...workOrder, photos: [] };
}

export interface WorkOrderUpdate {
  assigned_user_id?: string | null;
  scheduled_for?: Date;
  service_type?: ServiceType;
  operator_notes?: string | null;
}

/** Rescheduling and reassignment: dispatch work, so corporate only. */
export async function updateWorkOrder(
  id: string,
  scope: BranchScope,
  input: WorkOrderUpdate,
  db: Knex = defaultDb,
): Promise<WorkOrderWithPhotos> {
  const patch: Record<string, unknown> = {};
  for (const key of [
    'assigned_user_id',
    'scheduled_for',
    'service_type',
    'operator_notes',
  ] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (Object.keys(patch).length === 0) {
    throw badRequest('No updatable fields were provided');
  }

  return db.transaction(async (trx) => {
    const before = await lock(id, scope, trx);
    if (!OPEN_STATUSES.includes(before.status)) {
      throw conflict(`This visit is ${before.status}, so it can no longer be changed`);
    }
    if (input.assigned_user_id) {
      await assertAssignable(input.assigned_user_id, before.branch_id, trx);
    }

    const [workOrder] = await trx('work_orders').where({ id }).update(patch).returning('*');
    if (!workOrder) {
      throw notFound('Work order not found');
    }
    return { ...workOrder, photos: await listPhotos(id, trx) };
  });
}

export interface StatusChange {
  status: WorkOrderStatus;
  skip_reason?: string | null;
  operator_notes?: string | null;
}

/**
 * The operator's own screen: en route, started, done, or skipped.
 *
 * Completing is the gated one — a visit cannot be marked done without at
 * least one before and one after photo. On completion the customer and the
 * branch manager are emailed the photo set, off the response path.
 */
export async function changeWorkOrderStatus(
  id: string,
  scope: BranchScope,
  actor: CrewActor,
  change: StatusChange,
  db: Knex = defaultDb,
): Promise<WorkOrderWithPhotos> {
  const result = await db.transaction(async (trx) => {
    const before = await lock(id, scope, trx);
    assertMayWork(before, actor);
    assertTransition(before.status, change.status);

    if (change.status === 'skipped' && !change.skip_reason) {
      throw badRequest('skip_reason is required when skipping a visit');
    }
    if (change.status === 'completed') {
      await assertPhotographed(id, trx);
    }

    const now = new Date();
    const patch: Record<string, unknown> = { status: change.status };
    if (change.operator_notes !== undefined) patch.operator_notes = change.operator_notes;
    if (change.status === 'skipped') patch.skip_reason = change.skip_reason;
    if (change.status === 'in_progress' && !before.started_at) patch.started_at = now;
    if (change.status === 'completed') {
      patch.completed_at = now;
      if (!before.started_at) patch.started_at = now;
    }

    const [workOrder] = await trx('work_orders').where({ id }).update(patch).returning('*');
    if (!workOrder) {
      throw notFound('Work order not found');
    }
    return { ...workOrder, photos: await listPhotos(id, trx) };
  });

  if (result.status === 'completed') {
    // Deliberately not awaited: the operator's phone should not wait on SMTP,
    // and a failed send must not undo a finished job. Build step 5 swaps the
    // body of this for a real queue.
    notifyServiceComplete(result.id).catch((err: unknown) => {
      logger.error({ err, work_order_id: result.id }, 'Service complete email failed');
    });
  }

  return result;
}

export interface PhotoInput {
  photo_type: PhotoType;
  file_url: string;
  /** From the image EXIF, not the upload time. */
  taken_at: Date;
  latitude: number | null;
  longitude: number | null;
}

export async function addServicePhoto(
  workOrderId: string,
  scope: BranchScope,
  actor: CrewActor,
  input: PhotoInput,
  db: Knex = defaultDb,
): Promise<ServicePhoto> {
  return db.transaction(async (trx) => {
    const workOrder = await lock(workOrderId, scope, trx);
    assertMayWork(workOrder, actor);
    if (!OPEN_STATUSES.includes(workOrder.status)) {
      throw conflict(`This visit is ${workOrder.status}, so its photos are frozen`);
    }

    await assertNearProperty(workOrder.property_id, input, trx);

    try {
      const [photo] = await trx('service_photos')
        .insert({
          work_order_id: workOrderId,
          photo_type: input.photo_type,
          file_url: input.file_url,
          taken_at: input.taken_at,
          latitude: input.latitude?.toFixed(6) ?? null,
          longitude: input.longitude?.toFixed(6) ?? null,
          uploaded_by_user_id: actor.user_id,
        })
        .returning('*');
      if (!photo) {
        throw new Error('Insert returned no photo row');
      }
      return photo;
    } catch (err) {
      if (isPgError(err, PG_UNIQUE_VIOLATION)) {
        throw conflict('That file has already been attached to this visit');
      }
      throw err;
    }
  });
}

/**
 * The completion gate from the spec: before and after, or the job is not
 * done. The 400 names which one is missing, so the app can say "take an after
 * photo" rather than "something went wrong".
 */
async function assertPhotographed(workOrderId: string, db: Knex): Promise<void> {
  const rows = (await db('service_photos')
    .where({ work_order_id: workOrderId })
    .whereIn('photo_type', ['before', 'after'])
    .groupBy('photo_type')
    .select('photo_type')
    .count<{ photo_type: PhotoType; count: string }[]>({ count: '*' })) as {
    photo_type: PhotoType;
    count: string;
  }[];

  const missing = (['before', 'after'] as const).filter(
    (type) => !rows.some((row) => row.photo_type === type && Number(row.count) > 0),
  );

  if (missing.length > 0) {
    throw badRequest(
      'A visit cannot be completed without a before and an after photo',
      missing.map((type) => ({ path: `photos.${type}`, message: 'none uploaded' })),
    );
  }
}

/**
 * Geotag check. Only applies when both the property and the photo carry
 * coordinates: plenty of seeded addresses have none, and refusing a photo for
 * that would punish the operator for a gap in the office's data.
 */
async function assertNearProperty(
  propertyId: string,
  input: PhotoInput,
  db: Knex,
): Promise<void> {
  if (input.latitude === null || input.longitude === null) return;

  const property = await db('properties')
    .where({ id: propertyId })
    .first('latitude', 'longitude');
  if (!property?.latitude || !property?.longitude) return;

  const metres = distanceInMetres(
    Number(property.latitude),
    Number(property.longitude),
    input.latitude,
    input.longitude,
  );

  if (metres > GEOTAG_RADIUS_M) {
    throw badRequest(
      `That photo was taken ${Math.round(metres)}m from the property, which is too far to be this driveway`,
    );
  }
}

/** Haversine, in metres. Good to well under a metre at these distances. */
export function distanceInMetres(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number,
): number {
  const EARTH_RADIUS_M = 6_371_000;
  const toRad = (deg: number) => (deg * Math.PI) / 180;

  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;

  return 2 * EARTH_RADIUS_M * Math.asin(Math.sqrt(a));
}

/**
 * The onboarding gate, plus the branch rule: an operator only works their own
 * branch, whatever the dispatcher types.
 */
async function assertAssignable(
  userId: string,
  branchId: string,
  db: Knex,
): Promise<void> {
  await assertOperatorAssignable(userId, db);

  const user = await db('users').where({ id: userId }).first('branch_id');
  if (user?.branch_id !== branchId) {
    throw badRequest('That operator belongs to a different branch');
  }
}

/**
 * Branch scope says which visits you can see. This says whose you may touch:
 * the operator the job is assigned to, or corporate. Without it, any operator
 * in the branch could complete a colleague's job.
 */
function assertMayWork(workOrder: WorkOrder, actor: CrewActor): void {
  if (actor.is_corporate) return;
  if (workOrder.assigned_user_id !== actor.user_id) {
    throw forbidden('This visit is assigned to another operator');
  }
}

export function assertTransition(from: WorkOrderStatus, to: WorkOrderStatus): void {
  if (from === to) {
    throw conflict(`This visit is already ${to}`);
  }
  const allowed = TRANSITIONS[from];
  if (!allowed.includes(to)) {
    throw conflict(
      allowed.length === 0
        ? `This visit is ${from}, which is final and cannot be changed`
        : `This visit is ${from}, so it can only move to ${allowed.join(' or ')}`,
    );
  }
}

async function lock(
  id: string,
  scope: BranchScope,
  trx: Knex.Transaction,
): Promise<WorkOrder> {
  const workOrder = await scoped(trx, scope)
    .andWhere('work_orders.id', id)
    .forUpdate()
    .first('*');
  if (!workOrder) {
    throw notFound('Work order not found');
  }
  return workOrder as WorkOrder;
}

interface CompletionRow {
  branch_id: string;
  customer_id: string;
  service_type: ServiceType;
  completed_at: Date | null;
  address_line1: string;
  city: string;
  customer_first_name: string;
  customer_email: string | null;
  branch_name: string;
  manager_email: string | null;
  operator_first_name: string | null;
  operator_last_name: string | null;
}

/**
 * Tells the customer and the branch manager the driveway is done, with the
 * photo set, the time it was finished and who did it.
 *
 * Both messages are queued, not sent: the operator's phone must not wait on
 * SMTP, and a provider being down cannot undo a finished job. The worker
 * (npm run job:message-queue) delivers them.
 */
export async function notifyServiceComplete(
  workOrderId: string,
  db: Knex = defaultDb,
): Promise<void> {
  const row = (await db('work_orders')
    .join('properties', 'properties.id', 'work_orders.property_id')
    .join('contracts', 'contracts.id', 'work_orders.contract_id')
    .join('customers', 'customers.id', 'contracts.customer_id')
    .join('branches', 'branches.id', 'work_orders.branch_id')
    .leftJoin('users as operator', 'operator.id', 'work_orders.assigned_user_id')
    .leftJoin('users as manager', 'manager.id', 'branches.manager_user_id')
    .where('work_orders.id', workOrderId)
    .first([
      'work_orders.branch_id',
      'work_orders.service_type',
      'work_orders.completed_at',
      'customers.id as customer_id',
      'properties.address_line1',
      'properties.city',
      'customers.first_name as customer_first_name',
      'customers.email as customer_email',
      'branches.name as branch_name',
      'manager.email as manager_email',
      'operator.first_name as operator_first_name',
      'operator.last_name as operator_last_name',
    ])) as CompletionRow | undefined;

  if (!row) {
    logger.warn({ work_order_id: workOrderId }, 'Completed work order vanished before notify');
    return;
  }

  const photos = await listPhotos(workOrderId, db);

  const context = {
    customer_first_name: row.customer_first_name,
    address_line1: row.address_line1,
    city: row.city,
    branch_name: row.branch_name,
    service_type: row.service_type.replace(/_/g, ' '),
    completed_at: (row.completed_at ?? new Date()).toISOString(),
    operator_name:
      [row.operator_first_name, row.operator_last_name].filter(Boolean).join(' ') ||
      'the crew',
    photo_list: photos
      .map((p) => `  ${p.photo_type}: ${p.file_url} (taken ${p.taken_at.toISOString()})`)
      .join('\n'),
  };

  const addressed = {
    branch_id: row.branch_id,
    customer_id: row.customer_id,
    work_order_id: workOrderId,
    context,
  };

  if (row.customer_email) {
    await enqueueMessage(
      {
        ...addressed,
        template_code: 'service_complete',
        channel: 'email',
        recipient: row.customer_email,
      },
      db,
    );
  } else {
    logger.info(
      { work_order_id: workOrderId },
      'No customer email on file; completion notice not queued for the customer',
    );
  }

  if (row.manager_email) {
    await enqueueMessage(
      {
        ...addressed,
        template_code: 'service_complete_internal',
        channel: 'email',
        recipient: row.manager_email,
      },
      db,
    );
  }
}
