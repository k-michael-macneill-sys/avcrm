import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { LeadPin, PinStatus } from '../types/models';
import { ApiError, forbidden, notFound } from '../utils/errors';
import { applyBranchScope } from '../utils/scope';
import { createCustomer } from './customers';
import { createProperty } from './properties';

/**
 * The door-knocking map.
 *
 * Reps drop a pin on every house they try, marked with how it went. Signed
 * customers are not pins: they are drawn from their property, where their
 * address lives once they are real, along with what they pay for — which is
 * what a crew arriving at the house needs to know.
 */

/** What is on screen. The map asks for one box at a time. */
export interface Bounds {
  north: number;
  south: number;
  east: number;
  west: number;
}

/** Enough to stop a map zoomed out over a whole province returning everything. */
const MAX_PINS = 2000;

export interface PinView extends LeadPin {
  created_by_name: string | null;
}

export interface CustomerPin {
  property_id: string;
  customer_id: string;
  customer_name: string;
  latitude: string;
  longitude: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  /** The permanent job notes the rep left: gate codes, where the snow goes. */
  access_notes: string | null;
  priority_flag: boolean;
  billing_type: string | null;
  addon_salt: boolean;
  addon_vehicle: boolean;
  addon_stairs: boolean;
}

function inBounds(qb: Knex.QueryBuilder, table: string, b: Bounds): Knex.QueryBuilder {
  qb.whereBetween(`${table}.latitude`, [b.south, b.north]);
  // A box across the antimeridian wraps around. Not a thing in Canada's snow
  // belt, but cheap to get right.
  if (b.west <= b.east) {
    qb.whereBetween(`${table}.longitude`, [b.west, b.east]);
  } else {
    qb.where((q) => q.where(`${table}.longitude`, '>=', b.west).orWhere(`${table}.longitude`, '<=', b.east));
  }
  return qb;
}

export async function listPins(
  scope: BranchScope,
  bounds: Bounds,
  db: Knex = defaultDb,
): Promise<PinView[]> {
  const qb = applyBranchScope(
    db('lead_pins')
      .leftJoin('customers', 'customers.id', 'lead_pins.customer_id')
      .leftJoin('users', 'users.id', 'lead_pins.created_by_user_id'),
    'lead_pins.branch_id',
    scope,
  );
  inBounds(qb, 'lead_pins', bounds)
    // Once they have signed, their property is the pin.
    .where((q) => q.whereNull('customers.id').orWhereNot('customers.status', 'active'))
    .orderBy('lead_pins.last_knocked_at', 'desc')
    .limit(MAX_PINS);

  return (await qb.select(
    'lead_pins.*',
    db.raw(`nullif(trim(users.first_name || ' ' || users.last_name), '') as created_by_name`),
  )) as PinView[];
}

export async function listCustomerPins(
  scope: BranchScope,
  bounds: Bounds,
  db: Knex = defaultDb,
): Promise<CustomerPin[]> {
  const qb = applyBranchScope(
    db('properties').join('customers', 'customers.id', 'properties.customer_id'),
    'customers.branch_id',
    scope,
  );
  inBounds(qb, 'properties', bounds)
    .where('customers.status', 'active')
    .whereNotNull('properties.latitude')
    .limit(MAX_PINS);

  const rows = (await qb.select(
    'properties.id as property_id',
    'customers.id as customer_id',
    db.raw(`customers.first_name || ' ' || customers.last_name as customer_name`),
    'properties.latitude',
    'properties.longitude',
    'properties.address_line1',
    'properties.address_line2',
    'properties.city',
    'properties.access_notes',
    'properties.priority_flag',
  )) as Omit<CustomerPin, 'billing_type' | 'addon_salt' | 'addon_vehicle' | 'addon_stairs'>[];

  // What each house is paying for, from its active contract.
  const services: {
    property_id: string;
    billing_type: string;
    addon_salt: boolean;
    addon_vehicle: boolean;
    addon_stairs: boolean;
  }[] = await db('contracts')
    .join('quotes', 'quotes.id', 'contracts.quote_id')
    .whereIn(
      'contracts.property_id',
      rows.map((r) => r.property_id),
    )
    .where('contracts.status', 'active')
    .select(
      'contracts.property_id',
      'quotes.billing_type',
      'quotes.addon_salt',
      'quotes.addon_vehicle',
      'quotes.addon_stairs',
    );
  const byProperty = new Map(services.map((s) => [s.property_id, s]));

  return rows.map((row) => {
    const service = byProperty.get(row.property_id);
    return {
      ...row,
      billing_type: service?.billing_type ?? null,
      addon_salt: service?.addon_salt ?? false,
      addon_vehicle: service?.addon_vehicle ?? false,
      addon_stairs: service?.addon_stairs ?? false,
    };
  });
}

export interface PinAddress {
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
}

/** Their name and a way to reach them, when a door turns into a lead. */
export interface LeadContact {
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
}

export interface NewPinInput extends PinAddress {
  latitude: number;
  longitude: number;
  status: PinStatus;
  notes: string | null;
  lead: LeadContact | null;
}

export async function createPin(
  branchId: string,
  userId: string,
  scope: BranchScope,
  input: NewPinInput,
  db: Knex = defaultDb,
): Promise<LeadPin> {
  return db.transaction(async (trx) => {
    const customerId =
      input.status === 'lead' && input.lead
        ? await leadCustomer(branchId, userId, scope, input, input.lead, input.notes, trx)
        : null;

    const [pin] = await trx('lead_pins')
      .insert({
        branch_id: branchId,
        latitude: input.latitude.toFixed(6),
        longitude: input.longitude.toFixed(6),
        address_line1: input.address_line1,
        city: input.city,
        province: input.province,
        postal_code: input.postal_code,
        status: input.status,
        notes: input.notes,
        customer_id: customerId,
        created_by_user_id: userId,
        updated_by_user_id: userId,
      })
      .returning('*');
    if (!pin) throw new Error('Insert returned no lead_pin row');
    return pin as LeadPin;
  });
}

export interface PinUpdate {
  status?: PinStatus;
  notes?: string | null;
  lead?: LeadContact | null;
}

/**
 * Another visit to the same house. Changing how it went counts as a knock;
 * fixing a typo in the notes does not.
 */
export async function updatePin(
  id: string,
  userId: string,
  scope: BranchScope,
  input: PinUpdate,
  db: Knex = defaultDb,
): Promise<LeadPin> {
  return db.transaction(async (trx) => {
    const pin = await lockPin(id, scope, trx);

    const patch: Record<string, unknown> = { updated_by_user_id: userId };
    if (input.notes !== undefined) patch.notes = input.notes;
    if (input.status !== undefined) {
      patch.status = input.status;
      patch.knock_count = pin.knock_count + 1;
      patch.last_knocked_at = new Date();
    }

    const status = input.status ?? pin.status;
    if (status === 'lead' && input.lead && !pin.customer_id) {
      patch.customer_id = await leadCustomer(
        pin.branch_id,
        userId,
        scope,
        {
          address_line1: pin.address_line1,
          city: pin.city,
          province: pin.province,
          postal_code: pin.postal_code,
          latitude: Number(pin.latitude),
          longitude: Number(pin.longitude),
        },
        input.lead,
        input.notes ?? pin.notes,
        trx,
      );
    }

    const [updated] = await trx('lead_pins').where({ id }).update(patch).returning('*');
    return updated as LeadPin;
  });
}

/** A pin dropped on the wrong house. Its creator or the office may take it back. */
export async function deletePin(
  id: string,
  user: { id: string; role: string },
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<void> {
  const pin = await lockPin(id, scope, db);
  if (user.role !== 'corporate' && pin.created_by_user_id !== user.id) {
    throw forbidden('Only the rep who dropped this pin, or the office, can remove it');
  }
  await db('lead_pins').where({ id }).del();
}

/**
 * The sign-up flow started from a pin: the pin now belongs to that customer,
 * and drops off the map once they sign and their property takes its place.
 */
export async function linkPinToCustomer(
  pinId: string,
  customerId: string,
  scope: BranchScope,
  db: Knex,
): Promise<void> {
  await lockPin(pinId, scope, db);
  await db('lead_pins').where({ id: pinId }).update({ customer_id: customerId, status: 'lead' });
}

async function lockPin(id: string, scope: BranchScope, db: Knex): Promise<LeadPin> {
  const pin = (await applyBranchScope(db('lead_pins'), 'branch_id', scope)
    .andWhere({ id })
    .forUpdate()
    .first('*')) as LeadPin | undefined;
  if (!pin) throw notFound('Pin not found');
  return pin;
}

/**
 * A lead on the books, with their house attached when the map could make
 * out a whole address. When it could not, they are still a lead — the rep
 * fills the address in when they come back to sign them up.
 */
async function leadCustomer(
  branchId: string,
  userId: string,
  scope: BranchScope,
  where: PinAddress & { latitude: number; longitude: number },
  contact: LeadContact,
  notes: string | null,
  db: Knex,
): Promise<string> {
  const customer = await createCustomer(
    branchId,
    userId,
    {
      first_name: contact.first_name,
      last_name: contact.last_name,
      email: contact.email,
      phone: contact.phone,
      preferred_contact: contact.email ? 'email' : 'sms',
      notes,
      status: 'lead',
    },
    db,
  );

  const { address_line1, city, province, postal_code } = where;
  if (address_line1 && city && province && postal_code) {
    const house = {
      address_line1,
      address_line2: null,
      city,
      province,
      postal_code,
      latitude: where.latitude,
      longitude: where.longitude,
      driveway_size_cars: null,
      access_notes: null,
      priority_flag: false,
    };
    try {
      // A savepoint, so a clash with an address already on file rolls back
      // just this step and the lead is still written.
      await db.transaction((savepoint) => createProperty(customer.id, scope, house, savepoint));
    } catch (err) {
      // The house is already somebody's on the books. The lead still counts;
      // the office can sort out whose address it is.
      if (!(err instanceof ApiError && err.status === 409)) throw err;
    }
  }

  return customer.id;
}
