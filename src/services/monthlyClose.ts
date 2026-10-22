import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { AuthenticatedUser, BranchScope } from '../types/auth';
import {
  EXPENSE_CATEGORIES,
  type BookkeepingDocument,
  type BookkeepingDocumentKind,
  type BookkeepingMonth,
  type ExpenseCategory,
  type Upload,
} from '../types/models';
import { centsToAmount } from '../types/monthlyClose';
import { badRequest, notFound } from '../utils/errors';
import { recordAudit, type AuditActor } from './audit';

/**
 * The monthly close, kept in the CRM: each branch's month of receipts and
 * statements as files, and the totals worked out from them in an AI chat
 * (the Bookkeeping page gives the prompt). Nothing here reads the files;
 * they are kept so the year-end package has every one, and so the numbers
 * can be checked against them.
 */

export interface MonthView extends BookkeepingMonth {
  branch_name: string | null;
  documents: BookkeepingDocument[];
}

function scoped<T extends Knex.QueryBuilder>(query: T, column: string, scope: BranchScope): T {
  if (scope.kind === 'branch') query.where(column, scope.branchId);
  return query;
}

/** "2026-11" → "2026-11-01". */
export function firstOfMonth(month: string): string {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw badRequest('The month must look like 2026-11');
  return `${month}-01`;
}

export async function listMonths(scope: BranchScope, year: number | null, db: Knex = defaultDb): Promise<MonthView[]> {
  const query = scoped(
    db('bookkeeping_months').leftJoin('branches', 'branches.id', 'bookkeeping_months.branch_id') as Knex.QueryBuilder,
    'bookkeeping_months.branch_id',
    scope,
  ).select('bookkeeping_months.*', 'branches.name as branch_name');
  if (year) query.whereBetween('bookkeeping_months.month', [`${year}-01-01`, `${year}-12-31`]);
  const months = (await query.orderBy([
    { column: 'bookkeeping_months.month', order: 'desc' },
    { column: 'branches.name', order: 'asc' },
  ])) as (BookkeepingMonth & { branch_name: string | null })[];

  const documents = months.length
    ? ((await db('bookkeeping_documents')
        .whereIn('month_id', months.map((m) => m.id))
        .orderBy('created_at')) as BookkeepingDocument[])
    : [];
  return months.map((m) => ({ ...m, documents: documents.filter((d) => d.month_id === m.id) }));
}

/** The month's row, made if it is not there yet. */
async function monthRow(
  branchId: string | null,
  month: string,
  userId: string,
  trx: Knex.Transaction,
): Promise<BookkeepingMonth> {
  const first = firstOfMonth(month);
  const find = () =>
    trx('bookkeeping_months')
      .where({ month: first })
      .modify((q) => (branchId ? q.where('branch_id', branchId) : q.whereNull('branch_id')))
      .forUpdate()
      .first() as Promise<BookkeepingMonth | undefined>;
  const existing = await find();
  if (existing) return existing;
  const [created] = (await trx('bookkeeping_months')
    .insert({ branch_id: branchId, month: first, created_by_user_id: userId, updated_by_user_id: userId })
    .returning('*')) as BookkeepingMonth[];
  return created!;
}

export interface TotalsInput {
  branch_id: string | null;
  /** YYYY-MM. */
  month: string;
  /** Cents per category, from the form. */
  category_amounts: Partial<Record<ExpenseCategory, number>>;
  gst_hst_itc: number;
  capital_purchases: number;
  non_deductible: number;
  no_receipt_total: number;
  no_receipt_count: number;
  notes: string | null;
}

/**
 * Saves the totals for a month, replacing any entered before. The total
 * deductible is worked out here from the categories, so it always adds up.
 */
export async function saveTotals(
  user: AuthenticatedUser,
  actor: AuditActor,
  input: TotalsInput,
  db: Knex = defaultDb,
): Promise<MonthView> {
  const amounts: Partial<Record<ExpenseCategory, string>> = {};
  let total = 0;
  for (const [code, cents] of Object.entries(input.category_amounts) as [ExpenseCategory, number][]) {
    if (!EXPENSE_CATEGORIES.includes(code) || code === 'capital_purchase') {
      throw badRequest(`${code} is not an expense category`);
    }
    if (!Number.isInteger(cents) || cents < 0) throw badRequest(`The amount for ${code} must be in dollars and cents`);
    if (cents > 0) amounts[code] = centsToAmount(cents);
    total += cents;
  }

  const id = await db.transaction(async (trx) => {
    const before = await monthRow(input.branch_id, input.month, user.id, trx);
    const [after] = (await trx('bookkeeping_months')
      .where({ id: before.id })
      .update({
        category_amounts: JSON.stringify(amounts),
        deductible_total: centsToAmount(total),
        gst_hst_itc: centsToAmount(input.gst_hst_itc),
        capital_purchases: centsToAmount(input.capital_purchases),
        non_deductible: centsToAmount(input.non_deductible),
        no_receipt_total: centsToAmount(input.no_receipt_total),
        no_receipt_count: input.no_receipt_count,
        notes: input.notes,
        totals_entered_at: new Date(),
        updated_by_user_id: user.id,
      })
      .returning('*')) as BookkeepingMonth[];
    await recordAudit(actor, { action: 'bookkeeping_month.totals_saved', entity_type: 'bookkeeping_month', entity_id: before.id, before, after }, trx);
    return before.id;
  });
  return getMonth(id, { kind: 'all' }, db);
}

export async function getMonth(id: string, scope: BranchScope, db: Knex = defaultDb): Promise<MonthView> {
  const row = (await scoped(
    db('bookkeeping_months').leftJoin('branches', 'branches.id', 'bookkeeping_months.branch_id') as Knex.QueryBuilder,
    'bookkeeping_months.branch_id',
    scope,
  )
    .where('bookkeeping_months.id', id)
    .first('bookkeeping_months.*', 'branches.name as branch_name')) as (BookkeepingMonth & { branch_name: string | null }) | undefined;
  if (!row) throw notFound('No such month');
  const documents = (await db('bookkeeping_documents').where({ month_id: id }).orderBy('created_at')) as BookkeepingDocument[];
  return { ...row, documents };
}

/** Files a receipts PDF, a statement or the chat's CSV against a month, making the month if need be. */
export async function addDocument(
  user: AuthenticatedUser,
  actor: AuditActor,
  input: { branch_id: string | null; month: string; kind: BookkeepingDocumentKind; file_key: string },
  db: Knex = defaultDb,
): Promise<MonthView> {
  const upload = (await db('uploads').where({ key: input.file_key }).first()) as Upload | undefined;
  if (!upload || upload.status !== 'stored') throw badRequest('That file has not finished uploading');
  if (upload.purpose !== 'bookkeeping_document') throw badRequest('That file was not uploaded for bookkeeping');
  if (upload.uploaded_by_user_id !== user.id) throw badRequest('Attach a file you uploaded yourself');
  if (input.kind === 'detail_csv' && upload.content_type !== 'text/csv') throw badRequest('The detail file must be a CSV');
  if (input.kind !== 'detail_csv' && upload.content_type !== 'application/pdf') {
    throw badRequest(input.kind === 'receipts' ? 'The receipts must be a PDF' : 'The statement must be a PDF');
  }

  const id = await db.transaction(async (trx) => {
    const month = await monthRow(input.branch_id, input.month, user.id, trx);
    const [document] = (await trx('bookkeeping_documents')
      .insert({
        month_id: month.id,
        kind: input.kind,
        file_key: input.file_key,
        file_name: upload.file_name,
        uploaded_by_user_id: user.id,
      })
      .returning('*')) as BookkeepingDocument[];
    // The file belongs to the branch the month does, like any other file.
    if (input.branch_id) await trx('uploads').where({ key: input.file_key }).update({ branch_id: input.branch_id });
    await recordAudit(actor, { action: 'bookkeeping_document.added', entity_type: 'bookkeeping_document', entity_id: document!.id, after: document }, trx);
    return month.id;
  });
  return getMonth(id, { kind: 'all' }, db);
}

/** The stored file stays on disk: the audit trail may still point at it. */
export async function deleteDocument(id: string, actor: AuditActor, scope: BranchScope, db: Knex = defaultDb): Promise<void> {
  await db.transaction(async (trx) => {
    const document = (await scoped(
      trx('bookkeeping_documents').join('bookkeeping_months', 'bookkeeping_months.id', 'bookkeeping_documents.month_id') as Knex.QueryBuilder,
      'bookkeeping_months.branch_id',
      scope,
    )
      .where('bookkeeping_documents.id', id)
      .first('bookkeeping_documents.*')) as BookkeepingDocument | undefined;
    if (!document) throw notFound('No such document');
    await trx('bookkeeping_documents').where({ id }).delete();
    await recordAudit(actor, { action: 'bookkeeping_document.deleted', entity_type: 'bookkeeping_document', entity_id: id, before: document }, trx);
  });
}

export async function deleteMonth(id: string, actor: AuditActor, scope: BranchScope, db: Knex = defaultDb): Promise<void> {
  await db.transaction(async (trx) => {
    const month = (await scoped(trx('bookkeeping_months').where({ id }) as Knex.QueryBuilder, 'branch_id', scope).first()) as
      | BookkeepingMonth
      | undefined;
    if (!month) throw notFound('No such month');
    await trx('bookkeeping_months').where({ id }).delete();
    await recordAudit(actor, { action: 'bookkeeping_month.deleted', entity_type: 'bookkeeping_month', entity_id: id, before: month }, trx);
  });
}
