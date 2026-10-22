import type { Knex } from 'knex';

/**
 * Bookkeeping without an AI inside the CRM. Receipts and statements are
 * closed out once a month in an AI chat, using the prompt the Bookkeeping
 * page gives; the CRM keeps the documents and the totals the chat works out.
 *
 * Removes what the in-app reading needed (bank_statements,
 * bank_transactions, and the review and source columns on expenses) and adds:
 *
 * bookkeeping_months: one row per branch (or company-wide) per month, with
 * the amount to claim per T2125 category, the GST/HST that comes back as
 * input tax credits, capital purchases, and the costs that had no receipt.
 *
 * bookkeeping_documents: the files kept with that month, the receipts PDF,
 * each statement, and the chat's line-by-line CSV.
 *
 * Nothing was ever filed by the in-app reading (it needed an API key that
 * was never set), so dropping its tables loses nothing.
 */
const CATEGORIES = [
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
  'capital_purchase',
  'other',
];
const list = (values: string[]) => values.map((v) => `'${v}'`).join(', ');

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('expenses', (table) => {
    table.dropColumn('bank_transaction_id');
  });
  await knex.schema.dropTable('bank_transactions');
  await knex.schema.dropTable('bank_statements');
  await knex.raw(`
    alter table expenses
      drop constraint expenses_status_check,
      drop constraint expenses_source_check
  `);
  await knex.schema.alterTable('expenses', (table) => {
    table.dropIndex(['status'], 'expenses_status_index');
    table.dropColumn('status');
    table.dropColumn('source');
    table.dropColumn('review_note');
  });

  await knex.schema.createTable('bookkeeping_months', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('branch_id').nullable().references('id').inTable('branches').onDelete('RESTRICT');
    table.date('month').notNullable();
    table.jsonb('category_amounts').notNullable().defaultTo('{}');
    table.decimal('deductible_total', 12, 2).notNullable().defaultTo(0);
    table.decimal('gst_hst_itc', 12, 2).notNullable().defaultTo(0);
    table.decimal('capital_purchases', 12, 2).notNullable().defaultTo(0);
    table.decimal('non_deductible', 12, 2).notNullable().defaultTo(0);
    table.decimal('no_receipt_total', 12, 2).notNullable().defaultTo(0);
    table.integer('no_receipt_count').notNullable().defaultTo(0);
    table.text('notes').nullable();
    table.timestamp('totals_entered_at', { useTz: true }).nullable();
    table.uuid('created_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.uuid('updated_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['month'], 'bookkeeping_months_month_index');
  });
  await knex.raw(`
    alter table bookkeeping_months
      add constraint bookkeeping_months_first_of_month_check check (extract(day from month) = 1),
      add constraint bookkeeping_months_amounts_check check (
        deductible_total >= 0 and gst_hst_itc >= 0 and capital_purchases >= 0
        and non_deductible >= 0 and no_receipt_total >= 0 and no_receipt_count >= 0
      )
  `);
  // One row per branch per month; company-wide is a "branch" of its own.
  await knex.raw(`
    create unique index bookkeeping_months_branch_month_unique
      on bookkeeping_months (coalesce(branch_id, '00000000-0000-0000-0000-000000000000'::uuid), month)
  `);
  await knex.raw(`
    create trigger bookkeeping_months_set_updated_at before update on bookkeeping_months
      for each row execute function set_updated_at()
  `);

  await knex.schema.createTable('bookkeeping_documents', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('month_id').notNullable().references('id').inTable('bookkeeping_months').onDelete('CASCADE');
    table.text('kind').notNullable();
    table.text('file_key').notNullable();
    table.text('file_name').nullable();
    table.uuid('uploaded_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['month_id'], 'bookkeeping_documents_month_id_index');
  });
  await knex.raw(`
    alter table bookkeeping_documents add constraint bookkeeping_documents_kind_check
      check (kind in ('receipts', 'bank_statement', 'detail_csv'))
  `);
}

/** Puts back what 20261023000100_bookkeeping_automation made, empty. */
export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('bookkeeping_documents');
  await knex.schema.dropTable('bookkeeping_months');

  await knex.schema.alterTable('expenses', (table) => {
    table.text('status').notNullable().defaultTo('filed');
    table.text('source').notNullable().defaultTo('manual');
    table.text('review_note').nullable();
    table.index(['status'], 'expenses_status_index');
  });
  await knex.raw(`
    alter table expenses
      add constraint expenses_status_check check (status in ('filed', 'review')),
      add constraint expenses_source_check check (source in ('manual', 'receipt_scan', 'bank_statement'))
  `);

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
      add constraint bank_transactions_category_check check (category is null or category in (${list(CATEGORIES)})),
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
