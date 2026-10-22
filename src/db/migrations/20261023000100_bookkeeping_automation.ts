import type { Knex } from 'knex';

/**
 * Bookkeeping that files itself: receipts read by Claude, and bank statements
 * read line by line for deductions.
 *
 * expenses gains what a year-end return needs beyond the total: the GST/HST
 * on the receipt (the input tax credit), the business share, and whether the
 * entry is filed or still waiting for a person to check what Claude read.
 * Anything in review is left out of the totals until someone approves it.
 *
 * bank_statements / bank_transactions keep every line of every statement,
 * deductible or not, so the year can be reconciled against the bank and a
 * statement imported twice adds nothing the second time.
 *
 * The category list is written out here rather than imported: a migration is
 * history, and must not change when the application's list does.
 */
const CATEGORIES_BEFORE = [
  'equipment_maintenance',
  'fuel',
  'commercial_insurance',
  'vehicle_upkeep',
  'subcontractors',
  'protective_gear',
  'salt_and_supplies',
  'small_tools',
  'advertising',
  'phone_and_internet',
  'office_and_software',
  'professional_fees',
  'licences_and_permits',
  'wages',
  'rent_and_storage',
  'interest_and_bank_charges',
  'meals',
  'other',
];
const CATEGORIES_AFTER = [...CATEGORIES_BEFORE.slice(0, -1), 'capital_purchase', 'other'];

const list = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export async function up(knex: Knex): Promise<void> {
  await knex.raw('alter table expenses drop constraint expenses_category_check');
  await knex.raw(`alter table expenses add constraint expenses_category_check check (category in (${list(CATEGORIES_AFTER)}))`);

  await knex.schema.alterTable('expenses', (table) => {
    table.decimal('gst_hst', 12, 2).nullable();
    table.smallint('deductible_percent').notNullable().defaultTo(100);
    table.text('status').notNullable().defaultTo('filed');
    table.text('source').notNullable().defaultTo('manual');
    table.text('review_note').nullable();
    table.index(['status'], 'expenses_status_index');
  });
  await knex.raw(`
    alter table expenses
      add constraint expenses_deductible_percent_check check (deductible_percent between 0 and 100),
      add constraint expenses_status_check check (status in ('filed', 'review')),
      add constraint expenses_source_check check (source in ('manual', 'receipt_scan', 'bank_statement')),
      add constraint expenses_gst_hst_check check (gst_hst is null or (gst_hst >= 0 and gst_hst <= amount))
  `);
  // A meal was always only half deductible; say so on the ones already filed.
  await knex('expenses').where({ category: 'meals' }).update({ deductible_percent: 50 });

  await knex.schema.createTable('bank_statements', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('branch_id').nullable().references('id').inTable('branches').onDelete('RESTRICT');
    table.text('file_key').notNullable();
    table.text('file_name').nullable();
    table.text('status').notNullable().defaultTo('processing');
    table.text('error').nullable();
    table.text('account_label').nullable();
    table.date('period_start').nullable();
    table.date('period_end').nullable();
    table.integer('transaction_count').notNullable().defaultTo(0);
    table.uuid('created_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('processed_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
  await knex.raw(`
    alter table bank_statements add constraint bank_statements_status_check
      check (status in ('processing', 'done', 'failed'))
  `);
  await knex.raw(`
    create trigger bank_statements_set_updated_at before update on bank_statements
      for each row execute function set_updated_at()
  `);

  await knex.schema.createTable('bank_transactions', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('statement_id').notNullable().references('id').inTable('bank_statements').onDelete('CASCADE');
    table.uuid('branch_id').nullable().references('id').inTable('branches').onDelete('RESTRICT');
    table.date('posted_on').notNullable();
    table.text('description').notNullable();
    table.decimal('amount', 12, 2).notNullable();
    table.text('direction').notNullable();
    table.text('classification').notNullable();
    table.text('category').nullable();
    table.smallint('deductible_percent').notNullable().defaultTo(100);
    table.text('vendor').nullable();
    table.text('note').nullable();
    table.uuid('expense_id').nullable().references('id').inTable('expenses').onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['posted_on'], 'bank_transactions_posted_on_index');
    table.index(['classification'], 'bank_transactions_classification_index');
  });
  await knex.raw(`
    alter table bank_transactions
      add constraint bank_transactions_amount_check check (amount > 0),
      add constraint bank_transactions_direction_check check (direction in ('debit', 'credit')),
      add constraint bank_transactions_classification_check
        check (classification in ('deductible', 'personal', 'transfer', 'income', 'review')),
      add constraint bank_transactions_category_check check (category is null or category in (${list(CATEGORIES_AFTER)})),
      add constraint bank_transactions_deductible_percent_check check (deductible_percent between 0 and 100)
  `);
  await knex.raw(`
    create trigger bank_transactions_set_updated_at before update on bank_transactions
      for each row execute function set_updated_at()
  `);

  await knex.schema.alterTable('expenses', (table) => {
    table.uuid('bank_transaction_id').nullable().references('id').inTable('bank_transactions').onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('expenses', (table) => {
    table.dropColumn('bank_transaction_id');
  });
  await knex.schema.dropTable('bank_transactions');
  await knex.schema.dropTable('bank_statements');
  await knex('expenses').where({ category: 'capital_purchase' }).update({ category: 'other', description: knex.raw("coalesce(description, 'Capital purchase')") });
  await knex.raw(`
    alter table expenses
      drop constraint expenses_deductible_percent_check,
      drop constraint expenses_status_check,
      drop constraint expenses_source_check,
      drop constraint expenses_gst_hst_check
  `);
  await knex.schema.alterTable('expenses', (table) => {
    table.dropIndex(['status'], 'expenses_status_index');
    table.dropColumn('gst_hst');
    table.dropColumn('deductible_percent');
    table.dropColumn('status');
    table.dropColumn('source');
    table.dropColumn('review_note');
  });
  await knex.raw('alter table expenses drop constraint expenses_category_check');
  await knex.raw(`alter table expenses add constraint expenses_category_check check (category in (${list(CATEGORIES_BEFORE)}))`);
}
