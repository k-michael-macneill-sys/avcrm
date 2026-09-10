import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { AuditLogEntry } from '../types/models';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';

/**
 * The append-only trail the spec asks for: contracts, pricing and user roles.
 * Writes go in the same transaction as the change they describe, so the log
 * can never drift from what actually happened.
 *
 * Nothing here is ever updated or deleted — a trigger on the table enforces
 * that, so there is no update function to write.
 */

/** Who did it and from where. Routes build this once and pass it down. */
export interface AuditActor {
  user_id: string | null;
  ip_address: string | null;
}

export interface AuditEntry {
  /** Dotted verb, e.g. contract.created. */
  action: string;
  entity_type: string;
  entity_id: string;
  before?: unknown;
  after?: unknown;
}

export async function recordAudit(
  actor: AuditActor,
  entry: AuditEntry,
  db: Knex = defaultDb,
): Promise<void> {
  await db('audit_log').insert({
    user_id: actor.user_id,
    action: entry.action,
    entity_type: entry.entity_type,
    entity_id: entry.entity_id,
    before_json: asJson(entry.before),
    after_json: asJson(entry.after),
    ip_address: actor.ip_address,
  });
}

export interface AuditFilters {
  entity_type?: string;
  entity_id?: string;
  user_id?: string;
  action?: string;
}

/** Corporate-only read. Newest first, because that is how disputes start. */
export async function listAuditLog(
  filters: AuditFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<AuditLogEntry>> {
  const base = db('audit_log');

  if (filters.entity_type) base.where({ entity_type: filters.entity_type });
  if (filters.entity_id) base.where({ entity_id: filters.entity_id });
  if (filters.user_id) base.where({ user_id: filters.user_id });
  if (filters.action) base.where({ action: filters.action });

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([{ column: 'created_at', order: 'desc' }, { column: 'id', order: 'desc' }])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('*'),
    base.clone().count<{ count: string }[]>({ count: '*' }).first(),
  ]);

  return paginated(rows, Number(countRow?.count ?? 0), pagination);
}

/**
 * jsonb columns need the value as JSON text: node-postgres would otherwise
 * stringify an object with toString() and store "[object Object]".
 */
function asJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}
