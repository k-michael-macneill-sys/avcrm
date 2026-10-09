import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { WorkOrderStatus } from '../types/models';
import type {
  DispatchMap,
  MapCrewProps,
  MapPoint,
  MapPropertyProps,
  MapPropertyStatus,
} from '../types/weatherMap';
import { applyBranchScope } from '../utils/scope';

/**
 * The weather map's own layer: every active customer's property, coloured by
 * today's visit to it, and each crew that is out on one.
 *
 * "Today" is each branch's own calendar day, so a Regina visit at 11pm is
 * still today in Regina when it is already tomorrow in Kingston. A visit a
 * crew is on right now counts whatever day it was booked for: a run that goes
 * past midnight is still the run the dispatcher is watching.
 *
 * There is no live GPS in this system, so a crew is drawn at the property of
 * the visit it is on — honest for "on site", and the destination for "en
 * route".
 */

/** Enough for every branch's book with room to grow; past it the map says so. */
export const MAX_MAP_PROPERTIES = 5000;

const STATUS_OF_VISIT: Record<WorkOrderStatus, Exclude<MapPropertyStatus, 'unscheduled'>> = {
  en_route: 'active_route',
  in_progress: 'active_route',
  scheduled: 'pending',
  completed: 'serviced',
  skipped: 'skipped',
};

/** With several visits today, the one a dispatcher most needs to see wins. */
const PRECEDENCE: Record<Exclude<MapPropertyStatus, 'unscheduled'>, number> = {
  active_route: 0,
  pending: 1,
  serviced: 2,
  skipped: 3,
};

const LIVE: WorkOrderStatus[] = ['en_route', 'in_progress'];

interface PropertyRow {
  property_id: string;
  customer_id: string;
  latitude: string;
  longitude: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  driveway_size_cars: number | null;
  priority_flag: boolean;
  first_name: string;
  last_name: string;
  branch_name: string;
}

interface VisitRow {
  id: string;
  property_id: string;
  status: WorkOrderStatus;
  scheduled_for: Date;
  started_at: Date | null;
  updated_at: Date;
  assigned_user_id: string | null;
  crew_first_name: string | null;
  crew_last_name: string | null;
}

const fullName = (first: string | null, last: string | null): string | null => {
  const name = [first, last].filter(Boolean).join(' ').trim();
  return name === '' ? null : name;
};

const addressOf = (row: Pick<PropertyRow, 'address_line1' | 'address_line2'>): string =>
  row.address_line2 ? `${row.address_line1}, ${row.address_line2}` : row.address_line1;

function point<P>(longitude: number, latitude: number, properties: P): MapPoint<P> {
  return { type: 'Feature', geometry: { type: 'Point', coordinates: [longitude, latitude] }, properties };
}

export async function dispatchMap(
  scope: BranchScope,
  now: Date = new Date(),
  db: Knex = defaultDb,
): Promise<DispatchMap> {
  const propertyRows = (await applyBranchScope(
    db('properties')
      .join('customers', 'customers.id', 'properties.customer_id')
      .join('branches', 'branches.id', 'customers.branch_id')
      .where('customers.status', 'active')
      .whereNotNull('properties.latitude')
      .whereNotNull('properties.longitude'),
    'customers.branch_id',
    scope,
  )
    .orderBy('properties.id')
    .limit(MAX_MAP_PROPERTIES + 1)
    .select(
      'properties.id as property_id',
      'customers.id as customer_id',
      'properties.latitude',
      'properties.longitude',
      'properties.address_line1',
      'properties.address_line2',
      'properties.city',
      'properties.driveway_size_cars',
      'properties.priority_flag',
      'customers.first_name',
      'customers.last_name',
      'branches.name as branch_name',
    )) as PropertyRow[];

  const truncated = propertyRows.length > MAX_MAP_PROPERTIES;
  if (truncated) propertyRows.length = MAX_MAP_PROPERTIES;

  const visitsBase: Knex.QueryBuilder = db('work_orders');
  const visits = (await applyBranchScope(
    visitsBase
      .join('branches', 'branches.id', 'work_orders.branch_id')
      .leftJoin('users', 'users.id', 'work_orders.assigned_user_id')
      .where((qb) =>
        qb
          .whereRaw(
            '(work_orders.scheduled_for at time zone branches.timezone)::date = (?::timestamptz at time zone branches.timezone)::date',
            [now.toISOString()],
          )
          .orWhereIn('work_orders.status', LIVE),
      ),
    'work_orders.branch_id',
    scope,
  ).select(
    'work_orders.id',
    'work_orders.property_id',
    'work_orders.status',
    'work_orders.scheduled_for',
    'work_orders.started_at',
    'work_orders.updated_at',
    'work_orders.assigned_user_id',
    'users.first_name as crew_first_name',
    'users.last_name as crew_last_name',
  )) as VisitRow[];

  // The visit that decides each property's colour.
  const deciding = new Map<string, VisitRow>();
  for (const visit of visits) {
    const held = deciding.get(visit.property_id);
    if (!held) {
      deciding.set(visit.property_id, visit);
      continue;
    }
    const mine = PRECEDENCE[STATUS_OF_VISIT[visit.status]];
    const theirs = PRECEDENCE[STATUS_OF_VISIT[held.status]];
    // Same standing: the earlier booking is the one still ahead or most recent.
    if (mine < theirs || (mine === theirs && visit.scheduled_for < held.scheduled_for)) {
      deciding.set(visit.property_id, visit);
    }
  }

  const trigger = config.weather.thresholdCm;
  const byProperty = new Map(propertyRows.map((row) => [row.property_id, row]));

  const properties = propertyRows.map((row) => {
    const visit = deciding.get(row.property_id) ?? null;
    const props: MapPropertyProps = {
      property_id: row.property_id,
      customer_id: row.customer_id,
      customer_name: fullName(row.first_name, row.last_name) ?? 'Customer',
      address: addressOf(row),
      city: row.city,
      branch_name: row.branch_name,
      driveway_size_cars: row.driveway_size_cars,
      priority: row.priority_flag,
      status: visit ? STATUS_OF_VISIT[visit.status] : 'unscheduled',
      work_order_id: visit?.id ?? null,
      visit_status: visit?.status ?? null,
      scheduled_for: visit ? new Date(visit.scheduled_for).toISOString() : null,
      crew_name: visit ? fullName(visit.crew_first_name, visit.crew_last_name) : null,
      trigger_cm: trigger,
    };
    return point(Number(row.longitude), Number(row.latitude), props);
  });

  // Each crew's day, and the visit they are on now (the latest touched, should
  // two ever be open at once).
  const tally = new Map<string, { done: number; total: number }>();
  const onNow = new Map<string, VisitRow>();
  for (const visit of visits) {
    if (!visit.assigned_user_id) continue;
    const count = tally.get(visit.assigned_user_id) ?? { done: 0, total: 0 };
    count.total += 1;
    if (visit.status === 'completed') count.done += 1;
    tally.set(visit.assigned_user_id, count);

    if (!LIVE.includes(visit.status)) continue;
    const held = onNow.get(visit.assigned_user_id);
    if (!held || visit.updated_at > held.updated_at) onNow.set(visit.assigned_user_id, visit);
  }

  const crews: MapPoint<MapCrewProps>[] = [];
  for (const [userId, visit] of onNow) {
    const where = byProperty.get(visit.property_id);
    if (!where) continue;
    const count = tally.get(userId) ?? { done: 0, total: 0 };
    crews.push(
      point(Number(where.longitude), Number(where.latitude), {
        user_id: userId,
        crew_name: fullName(visit.crew_first_name, visit.crew_last_name) ?? 'Crew',
        visit_status: visit.status as MapCrewProps['visit_status'],
        work_order_id: visit.id,
        address: addressOf(where),
        customer_name: fullName(where.first_name, where.last_name) ?? 'Customer',
        since: visit.started_at ? new Date(visit.started_at).toISOString() : new Date(visit.updated_at).toISOString(),
        visits_done: count.done,
        visits_today: count.total,
      }),
    );
  }

  return {
    generated_at: now.toISOString(),
    trigger_cm: trigger,
    properties: { type: 'FeatureCollection', features: properties },
    crews: { type: 'FeatureCollection', features: crews },
    truncated,
  };
}
