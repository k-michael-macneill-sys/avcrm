import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { AuthenticatedUser, BranchScope } from '../types/auth';
import type { Expense, ExpenseCategory, ExpenseSource, ExpenseStatus } from '../types/models';
import { badRequest, notFound } from '../utils/errors';
import { recordAudit, type AuditActor } from './audit';

/**
 * Bookkeeping: the deductions the business claims, each with the receipt
 * that backs it up.
 *
 * Categories follow the CRA's Form T2125 (Statement of Business or
 * Professional Activities), so the year-end totals line up with the lines an
 * accountant fills in. The line numbers are a guide for whoever does the
 * return, not tax advice — a truck bought outright, for one, is capital cost
 * allowance rather than an expense, and meals are only half deductible.
 */

export interface ExpenseCategoryInfo {
  code: ExpenseCategory;
  label: string;
  /** The T2125 line it is usually claimed on. */
  cra_line: string;
  help: string;
}

export const EXPENSE_CATEGORY_INFO: ExpenseCategoryInfo[] = [
  {
    code: 'equipment_maintenance',
    label: 'Equipment maintenance',
    cra_line: '8960',
    help: 'Repairs and servicing for plows, blowers, spreaders and loaders.',
  },
  {
    code: 'fuel',
    label: 'Fuel',
    cra_line: '9224 / 9281',
    help: 'Gas and diesel for equipment (9224) and for work vehicles (9281).',
  },
  {
    code: 'commercial_insurance',
    label: 'Commercial insurance',
    cra_line: '8690',
    help: 'General liability, commercial auto and equipment coverage.',
  },
  {
    code: 'vehicle_upkeep',
    label: 'Vehicle upkeep',
    cra_line: '9281',
    help: 'Truck repairs, tires, oil changes, registration and plates.',
  },
  {
    code: 'subcontractors',
    label: 'Subcontractors',
    cra_line: '8360',
    help: 'Crews and operators paid per job rather than as employees.',
  },
  {
    code: 'protective_gear',
    label: 'Protective gear',
    cra_line: '9270',
    help: 'Safety boots, high-visibility wear, gloves, ice cleats, hearing protection.',
  },
  {
    code: 'salt_and_supplies',
    label: 'Salt, sand and supplies',
    cra_line: '8811',
    help: 'Rock salt, de-icer, sand, driveway markers and consumables.',
  },
  {
    code: 'small_tools',
    label: 'Small tools and equipment',
    cra_line: '9270',
    help: 'Shovels, scrapers and tools under $500. Larger equipment is usually capital cost allowance.',
  },
  {
    code: 'advertising',
    label: 'Advertising and marketing',
    cra_line: '8521',
    help: 'Google and Meta ads, flyers, lawn signs, door hangers.',
  },
  {
    code: 'phone_and_internet',
    label: 'Phone and internet',
    cra_line: '9220',
    help: 'The business share of phone plans and data for the crew.',
  },
  {
    code: 'office_and_software',
    label: 'Office and software',
    cra_line: '8810',
    help: 'Software subscriptions, printing, stationery and postage.',
  },
  {
    code: 'professional_fees',
    label: 'Accounting and legal',
    cra_line: '8860',
    help: 'Bookkeeper, accountant and lawyer fees.',
  },
  {
    code: 'licences_and_permits',
    label: 'Licences, permits and fees',
    cra_line: '8760',
    help: 'Business licences, permits and association memberships.',
  },
  {
    code: 'wages',
    label: 'Wages and benefits',
    cra_line: '9060',
    help: 'Payroll for employees, with the employer share of CPP and EI.',
  },
  {
    code: 'rent_and_storage',
    label: 'Rent and storage',
    cra_line: '8910',
    help: 'Yard, garage or storage space for equipment and salt.',
  },
  {
    code: 'interest_and_bank_charges',
    label: 'Interest and bank charges',
    cra_line: '8710',
    help: 'Loan interest, card processing fees and bank charges.',
  },
  {
    code: 'meals',
    label: 'Meals and entertainment',
    cra_line: '8523',
    help: 'Generally only 50% deductible.',
  },
  {
    code: 'capital_purchase',
    label: 'Capital purchase (CCA)',
    cra_line: 'CCA',
    help: 'Trucks, plows, blowers and other equipment bought outright. Claimed through capital cost allowance, not as an expense: listed for the accountant, not deducted.',
  },
  {
    code: 'other',
    label: 'Other',
    cra_line: '9270',
    help: 'Anything else. Say what it was in the description.',
  },
];

export const EXPENSE_SORTS = ['recent', 'category', 'amount_desc', 'amount_asc'] as const;
export type ExpenseSort = (typeof EXPENSE_SORTS)[number];

export interface ExpenseFilters {
  sort: ExpenseSort;
  status?: ExpenseStatus;
  category?: ExpenseCategory;
  branch_id?: string;
  /** Inclusive YYYY-MM-DD. */
  from?: string;
  /** Inclusive YYYY-MM-DD. */
  to?: string;
}

export interface ExpenseView extends Expense {
  category_label: string;
  branch_name: string | null;
  created_by_name: string | null;
}

const LABELS = new Map(EXPENSE_CATEGORY_INFO.map((c) => [c.code, c.label]));

type ExpenseRow = Expense & { branch_name: string | null; created_by_name: string | null };

/** A money column comes back from pg as a string; keep it one, to the cent. */
function view(row: ExpenseRow): ExpenseView {
  return { ...row, category_label: LABELS.get(row.category) ?? row.category };
}

/** Every expense read: the row, its branch and who filed it. */
function expenseQuery(db: Knex): Knex.QueryBuilder {
  return db('expenses')
    .leftJoin('branches', 'branches.id', 'expenses.branch_id')
    .leftJoin('users', 'users.id', 'expenses.created_by_user_id')
    .select(
      'expenses.*',
      'branches.name as branch_name',
      db.raw(`nullif(trim(concat_ws(' ', users.first_name, users.last_name)), '') as created_by_name`),
    );
}

export async function listExpenses(
  filters: ExpenseFilters,
  db: Knex = defaultDb,
): Promise<ExpenseView[]> {
  const query = expenseQuery(db);

  if (filters.status) query.where('expenses.status', filters.status);
  if (filters.category) query.where('expenses.category', filters.category);
  if (filters.branch_id) query.where('expenses.branch_id', filters.branch_id);
  if (filters.from) query.where('expenses.spent_on', '>=', filters.from);
  if (filters.to) query.where('expenses.spent_on', '<=', filters.to);

  // Every sort ends on the newest first and then the id, so rows with equal
  // keys keep one order between reloads rather than shuffling.
  switch (filters.sort) {
    case 'category':
      // By the label people read, not the code.
      query.orderByRaw(
        `array_position(array[${EXPENSE_CATEGORY_INFO.map(() => '?').join(', ')}]::text[], expenses.category) asc`,
        [...EXPENSE_CATEGORY_INFO].sort((a, b) => a.label.localeCompare(b.label)).map((c) => c.code),
      );
      break;
    case 'amount_desc':
      query.orderBy('expenses.amount', 'desc');
      break;
    case 'amount_asc':
      query.orderBy('expenses.amount', 'asc');
      break;
    case 'recent':
      break;
  }
  query.orderBy([
    { column: 'expenses.spent_on', order: 'desc' },
    { column: 'expenses.created_at', order: 'desc' },
    { column: 'expenses.id', order: 'desc' },
  ]);

  const rows = (await query) as ExpenseRow[];
  return rows.map(view);
}

export interface CreateExpenseInput {
  branch_id: string | null;
  category: ExpenseCategory;
  description: string | null;
  vendor: string | null;
  amount: number;
  spent_on: string | null;
  receipt_key: string | null;
  /** The GST/HST on the receipt, if it shows it. */
  gst_hst?: number | null;
  /** Defaults to 50 for meals and 100 for everything else. */
  deductible_percent?: number | null;
  status?: ExpenseStatus;
  source?: ExpenseSource;
  review_note?: string | null;
  bank_transaction_id?: string | null;
}

/** Half of a meal, all of anything else, unless someone says otherwise. */
export function defaultDeductiblePercent(category: ExpenseCategory): number {
  return category === 'meals' ? 50 : 100;
}

function assertTax(amount: number, gstHst: number | null | undefined): void {
  if (gstHst !== null && gstHst !== undefined && (gstHst < 0 || gstHst > amount)) {
    throw badRequest('The GST/HST cannot be more than the total', [
      { path: 'gst_hst', message: 'More than the total' },
    ]);
  }
}

/**
 * A receipt key has to be a file this person actually uploaded as a
 * receipt — otherwise any key they had seen (a signature, a crew member's
 * licence) could be filed against an expense and read back through it.
 */
export async function receiptFor(
  key: string,
  user: AuthenticatedUser,
  db: Knex,
): Promise<{ file_name: string | null }> {
  const upload = await db('uploads').where({ key }).first();
  if (!upload || upload.status !== 'stored') {
    throw badRequest('That receipt has not finished uploading');
  }
  if (upload.purpose !== 'receipt') {
    throw badRequest('That file was not uploaded as a receipt');
  }
  if (upload.uploaded_by_user_id !== user.id) {
    throw badRequest('Attach a receipt you uploaded yourself');
  }
  return { file_name: upload.file_name };
}

export async function createExpense(
  user: AuthenticatedUser,
  actor: AuditActor,
  input: CreateExpenseInput,
  db: Knex = defaultDb,
): Promise<ExpenseView> {
  if (input.category === 'other' && !input.description) {
    throw badRequest('Say what the expense was when the category is Other', [
      { path: 'description', message: 'Required for Other' },
    ]);
  }

  assertTax(input.amount, input.gst_hst);

  return db.transaction(async (trx) => {
    const receipt = input.receipt_key ? await receiptFor(input.receipt_key, user, trx) : null;

    const [row] = await trx('expenses')
      .insert({
        branch_id: input.branch_id,
        category: input.category,
        description: input.description,
        vendor: input.vendor,
        // Two decimals exactly: 12.345 must not become a third of a cent.
        amount: input.amount.toFixed(2),
        ...(input.spent_on ? { spent_on: input.spent_on } : {}),
        receipt_key: input.receipt_key,
        receipt_file_name: receipt?.file_name ?? null,
        gst_hst: input.gst_hst === null || input.gst_hst === undefined ? null : input.gst_hst.toFixed(2),
        deductible_percent: input.deductible_percent ?? defaultDeductiblePercent(input.category),
        status: input.status ?? 'filed',
        source: input.source ?? 'manual',
        review_note: input.review_note ?? null,
        bank_transaction_id: input.bank_transaction_id ?? null,
        created_by_user_id: user.id,
      })
      .returning('*');
    if (!row) throw new Error('Insert returned no expense row');

    // The receipt belongs to the branch the expense does, like any other file.
    if (input.receipt_key && input.branch_id) {
      await trx('uploads').where({ key: input.receipt_key }).update({ branch_id: input.branch_id });
    }

    await recordAudit(actor, {
      action: 'expense.created',
      entity_type: 'expense',
      entity_id: row.id,
      after: row,
    }, trx);

    const created = (await expenseQuery(trx).where('expenses.id', row.id).first()) as ExpenseRow;
    return view(created);
  });
}

export interface UpdateExpenseInput {
  branch_id?: string | null;
  category?: ExpenseCategory;
  description?: string | null;
  vendor?: string | null;
  amount?: number;
  spent_on?: string;
  gst_hst?: number | null;
  deductible_percent?: number;
  /** `filed` approves an entry waiting for review. */
  status?: ExpenseStatus;
}

/**
 * Corrects an entry, or approves one Claude filed for review. Approving
 * clears the review note: once a person has looked, it is their entry.
 */
export async function updateExpense(
  id: string,
  actor: AuditActor,
  input: UpdateExpenseInput,
  scope: BranchScope = { kind: 'all' },
  db: Knex = defaultDb,
): Promise<ExpenseView> {
  return db.transaction(async (trx) => {
    const before = (await trx('expenses').where({ id }).forUpdate().first()) as Expense | undefined;
    if (!before || (scope.kind === 'branch' && before.branch_id !== scope.branchId)) {
      throw notFound('No such expense');
    }
    const category = input.category ?? before.category;
    const description = input.description !== undefined ? input.description : before.description;
    if (category === 'other' && !description) {
      throw badRequest('Say what the expense was when the category is Other', [
        { path: 'description', message: 'Required for Other' },
      ]);
    }
    const amount = input.amount ?? Number(before.amount);
    const gstHst = input.gst_hst !== undefined ? input.gst_hst : before.gst_hst === null ? null : Number(before.gst_hst);
    assertTax(amount, gstHst);

    const patch: Record<string, unknown> = {
      category,
      description,
      amount: amount.toFixed(2),
      gst_hst: gstHst === null ? null : gstHst.toFixed(2),
    };
    if (input.vendor !== undefined) patch.vendor = input.vendor;
    if (input.spent_on !== undefined) patch.spent_on = input.spent_on;
    if (input.branch_id !== undefined && scope.kind === 'all') patch.branch_id = input.branch_id;
    if (input.deductible_percent !== undefined) patch.deductible_percent = input.deductible_percent;
    else if (input.category && input.category !== before.category) patch.deductible_percent = defaultDeductiblePercent(category);
    if (input.status !== undefined) {
      patch.status = input.status;
      if (input.status === 'filed') patch.review_note = null;
    }

    const [after] = await trx('expenses').where({ id }).update(patch).returning('*');
    await recordAudit(actor, {
      action: before.status === 'review' && input.status === 'filed' ? 'expense.approved' : 'expense.updated',
      entity_type: 'expense',
      entity_id: id,
      before,
      after,
    }, trx);
    return view((await expenseQuery(trx).where('expenses.id', id).first()) as ExpenseRow);
  });
}

/** The receipt file stays on disk: the audit trail may still point at it. */
export async function deleteExpense(
  id: string,
  actor: AuditActor,
  scope: BranchScope = { kind: 'all' },
  db: Knex = defaultDb,
): Promise<void> {
  await db.transaction(async (trx) => {
    const row = await trx('expenses').where({ id }).first();
    // Another branch's expense is as good as missing.
    if (!row || (scope.kind === 'branch' && row.branch_id !== scope.branchId)) {
      throw notFound('No such expense');
    }

    await trx('expenses').where({ id }).delete();
    await recordAudit(actor, {
      action: 'expense.deleted',
      entity_type: 'expense',
      entity_id: id,
      before: row,
    }, trx);
  });
}
