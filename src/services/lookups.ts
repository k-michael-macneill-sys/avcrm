import type { Knex } from 'knex';
import { z } from 'zod';
import { db as defaultDb } from '../db/client';
import type {
  AddonService,
  BillingPlan,
  ContractTag,
  ContractType,
  LookupRow,
  ServiceRoute,
  TaxCode,
} from '../types/models';
import { PLAN_KINDS, TAG_KINDS } from '../types/serviceAgreement';
import { badRequest, conflict, notFound } from '../utils/errors';
import { isPgError, pgConstraint, PG_UNIQUE_VIOLATION } from '../utils/pg';
import { recordAudit, type AuditActor } from './audit';

/**
 * The lists the contract form is built from, as data the office edits.
 *
 * Rows are never deleted — a contract signed against "Garage apron" must
 * still say so after the office stops offering it — so retiring one is
 * switching it off. Codes are fixed once made; labels, order and the
 * per-table settings below are free to change.
 */

const money = z
  .string()
  .trim()
  .regex(/^\d+(\.\d{1,2})?$/, 'must be an amount like 75 or 75.00');

const common = {
  label: z.string().trim().min(1).max(200),
  active: z.boolean(),
  sort_order: z.number().int().min(0).max(100000),
};

/** Each table's own columns, beyond code, label, active and sort order. */
export const LOOKUP_SCHEMAS = {
  contract_types: z.object({
    ...common,
    seasons: z.number().int().min(1).max(5),
    agreement_medium: z.enum(['electronic', 'paper']),
    is_switch_over: z.boolean(),
  }),
  billing_plans: z.object({
    ...common,
    kind: z.enum(PLAN_KINDS),
    installments_per_season: z.number().int().min(1).max(12),
    early_termination_fee: money,
  }),
  scope_items: z.object({ ...common }),
  addon_services: z.object({ ...common, default_price: money.nullable() }),
  contract_tags: z.object({ ...common, kind: z.enum(TAG_KINDS).nullable() }),
  tax_codes: z.object({
    ...common,
    rate: z
      .string()
      .trim()
      .regex(/^0(\.\d{1,5})?$/, 'must be a fraction like 0.13'),
    province: z
      .string()
      .trim()
      .regex(/^[A-Z]{2}$/, 'must be a two-letter province code')
      .nullable(),
    is_default: z.boolean(),
  }),
  service_routes: z.object({ ...common, branch_id: z.string().uuid().nullable() }),
} as const;

export type LookupTable = keyof typeof LOOKUP_SCHEMAS;
export const LOOKUP_TABLES = Object.keys(LOOKUP_SCHEMAS) as LookupTable[];

export interface Lookups {
  contract_types: ContractType[];
  billing_plans: BillingPlan[];
  scope_items: LookupRow[];
  addon_services: AddonService[];
  contract_tags: ContractTag[];
  tax_codes: TaxCode[];
  service_routes: ServiceRoute[];
}

const ORDER = [
  { column: 'sort_order', order: 'asc' as const },
  { column: 'label', order: 'asc' as const },
];

export async function listLookup(
  table: LookupTable,
  options: { includeInactive?: boolean; branchId?: string | null } = {},
  db: Knex = defaultDb,
): Promise<LookupRow[]> {
  const query = db(table).orderBy(ORDER);
  if (!options.includeInactive) query.where({ active: true });
  // A route belongs to one branch, or to every branch when it has none.
  if (table === 'service_routes' && options.branchId) {
    query.where((q) => q.whereNull('branch_id').orWhere('branch_id', options.branchId!));
  }
  return query.select('*');
}

export async function listLookups(
  options: { includeInactive?: boolean; branchId?: string | null } = {},
  db: Knex = defaultDb,
): Promise<Lookups> {
  const entries = await Promise.all(
    LOOKUP_TABLES.map(async (table) => [table, await listLookup(table, options, db)] as const),
  );
  return Object.fromEntries(entries) as unknown as Lookups;
}

const codeSchema = z
  .string()
  .trim()
  .regex(/^[a-z0-9_]{1,60}$/i, 'use letters, digits and underscores');

export async function createLookup(
  table: LookupTable,
  input: unknown,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<LookupRow> {
  const schema = LOOKUP_SCHEMAS[table].partial().required({ label: true }).extend({ code: codeSchema });
  const parsed = schema.safeParse(input);
  if (!parsed.success) throw validation(parsed.error);

  return db.transaction(async (trx) => {
    const values = parsed.data as Record<string, unknown>;
    if (values.sort_order === undefined) {
      const last = (await trx(table).max<{ max: number | null }[]>({ max: 'sort_order' }).first()) as
        | { max: number | null }
        | undefined;
      values.sort_order = (last?.max ?? 0) + 10;
    }
    await clearOtherDefault(table, values, null, trx);
    let row: LookupRow | undefined;
    try {
      [row] = await trx(table).insert(values).returning('*');
    } catch (err) {
      throw translate(err);
    }
    if (!row) throw new Error('Insert returned no row');
    await recordAudit(actor, { action: `${table}.created`, entity_type: table, entity_id: row.id, after: row }, trx);
    return row;
  });
}

export async function updateLookup(
  table: LookupTable,
  id: string,
  input: unknown,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<LookupRow> {
  const parsed = LOOKUP_SCHEMAS[table].partial().safeParse(input);
  if (!parsed.success) throw validation(parsed.error);
  const patch = parsed.data as Record<string, unknown>;
  if (Object.keys(patch).length === 0) throw badRequest('Nothing to change');

  return db.transaction(async (trx) => {
    const before = (await trx(table).where({ id }).forUpdate().first()) as LookupRow | undefined;
    if (!before) throw notFound('That entry does not exist');
    await clearOtherDefault(table, { ...before, ...patch }, id, trx);
    let row: LookupRow | undefined;
    try {
      [row] = await trx(table).where({ id }).update(patch).returning('*');
    } catch (err) {
      throw translate(err);
    }
    await recordAudit(
      actor,
      { action: `${table}.updated`, entity_type: table, entity_id: id, before, after: row },
      trx,
    );
    return row!;
  });
}

/** A province has one default tax code; making a new one the default retires the old. */
async function clearOtherDefault(
  table: LookupTable,
  values: Record<string, unknown>,
  id: string | null,
  trx: Knex.Transaction,
): Promise<void> {
  if (table !== 'tax_codes' || values.is_default !== true || !values.province) return;
  const query = trx('tax_codes').where({ province: values.province, is_default: true });
  if (id) query.whereNot({ id });
  await query.update({ is_default: false });
}

/** The tax code a new contract in this province starts on. */
export async function defaultTaxCode(province: string, db: Knex = defaultDb): Promise<TaxCode | undefined> {
  return (await db('tax_codes')
    .where({ active: true })
    .andWhere((q) => q.where({ province: province.toUpperCase(), is_default: true }))
    .first()) as TaxCode | undefined;
}

function validation(error: z.ZodError): Error {
  return badRequest(
    'Request validation failed',
    error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
  );
}

function translate(err: unknown): unknown {
  if (isPgError(err, PG_UNIQUE_VIOLATION)) {
    const constraint = pgConstraint(err) ?? '';
    if (constraint.endsWith('_code_unique')) return conflict('An entry with that code already exists');
    if (constraint === 'contract_tags_kind_unique') return conflict('Another tag already has that behaviour');
  }
  return err;
}
