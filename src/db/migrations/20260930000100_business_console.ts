import type { Knex } from 'knex';

/*
 * Written out rather than imported from types/models: a migration is history,
 * and must not change when a category is added later — that is a new
 * migration swapping the constraint.
 */
const EXPENSE_CATEGORIES = [
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
const OPT_IN_SOURCES = ['google_ads', 'door_to_door'];
const EMAIL_LEAD_STATUSES = ['active', 'completed', 'unsubscribed', 'converted'];

/**
 * The tables behind the Business Console and the weather bot.
 *
 * expenses: the bookkeeping side. Every deduction the business claims, with
 * the receipt that backs it. Costs finally have somewhere to live, which is
 * what the financial dashboard nets revenue against.
 *
 * email_leads: people who opted in to hear from us by email — from a Google
 * Ads landing page or at the door — and where each one is in the follow-up
 * sequence. The consent wording is stored with them, because CASL puts the
 * burden of proving consent on the sender.
 *
 * weather_alert_runs: one row per branch, postal region and morning that the
 * weather bot has looked at. The unique key is what makes the bot safe to run
 * every hour: a region already decided for a morning is never decided, or
 * texted about, twice.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('expenses', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('branch_id')
      .nullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    table.text('category').notNullable();
    table.text('description').nullable();
    table.text('vendor').nullable();
    table.decimal('amount', 12, 2).notNullable();
    table.date('spent_on').notNullable().defaultTo(knex.raw('current_date'));
    table.text('receipt_key').nullable();
    table.text('receipt_file_name').nullable();
    table
      .uuid('created_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['spent_on'], 'expenses_spent_on_index');
    table.index(['branch_id'], 'expenses_branch_id_index');
  });

  await knex.raw(`
    alter table expenses add constraint expenses_category_check
      check (category in (${EXPENSE_CATEGORIES.map((c) => `'${c}'`).join(', ')}))
  `);
  await knex.raw(`
    alter table expenses add constraint expenses_amount_check check (amount > 0)
  `);
  // "Other" on its own tells an accountant nothing.
  await knex.raw(`
    alter table expenses add constraint expenses_other_described_check
      check (category <> 'other' or coalesce(trim(description), '') <> '')
  `);
  await knex.raw(`
    create trigger expenses_set_updated_at before update on expenses
      for each row execute function set_updated_at()
  `);

  await knex.schema.createTable('email_leads', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    table.text('first_name').notNullable();
    table.text('last_name').nullable();
    table.text('email').notNullable();
    table.text('phone').nullable();
    table.text('source').notNullable();
    table.text('status').notNullable().defaultTo('active');
    table.integer('steps_sent').notNullable().defaultTo(0);
    table.timestamp('next_send_at', { useTz: true }).nullable();
    table.timestamp('opted_in_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('consent_text').notNullable();
    table.text('unsubscribe_token').notNullable().unique();
    table.timestamp('unsubscribed_at', { useTz: true }).nullable();
    // Which ad brought them, when it was an ad.
    table.text('campaign').nullable();
    table.text('gclid').nullable();
    table
      .uuid('lead_pin_id')
      .nullable()
      .references('id')
      .inTable('lead_pins')
      .onDelete('SET NULL');
    table
      .uuid('customer_id')
      .nullable()
      .references('id')
      .inTable('customers')
      .onDelete('SET NULL');
    table
      .uuid('created_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['branch_id', 'status'], 'email_leads_branch_status_index');
  });

  await knex.raw(`
    alter table email_leads add constraint email_leads_source_check
      check (source in (${OPT_IN_SOURCES.map((s) => `'${s}'`).join(', ')}))
  `);
  await knex.raw(`
    alter table email_leads add constraint email_leads_status_check
      check (status in (${EMAIL_LEAD_STATUSES.map((s) => `'${s}'`).join(', ')}))
  `);
  await knex.raw(`
    alter table email_leads add constraint email_leads_unsubscribed_check
      check ((status = 'unsubscribed') = (unsubscribed_at is not null))
  `);
  // Only a lead still in the sequence has a next email coming.
  await knex.raw(`
    alter table email_leads add constraint email_leads_next_send_check
      check (status = 'active' or next_send_at is null)
  `);
  // One enrolment per address per branch: opting in twice is the same person.
  await knex.raw(`
    create unique index email_leads_branch_email_unique
      on email_leads (branch_id, lower(email))
  `);
  // The drip job's claim query: who is due next.
  await knex.raw(`
    create index email_leads_due_index
      on email_leads (next_send_at)
      where status = 'active'
  `);
  await knex.raw(`
    create trigger email_leads_set_updated_at before update on email_leads
      for each row execute function set_updated_at()
  `);

  // So a lead's page can show every email the sequence sent them.
  await knex.schema.alterTable('message_log', (table) => {
    table
      .uuid('email_lead_id')
      .nullable()
      .references('id')
      .inTable('email_leads')
      .onDelete('SET NULL');
    table.index(['email_lead_id'], 'message_log_email_lead_id_index');
  });

  await knex.schema.createTable('weather_alert_runs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('CASCADE');
    table.date('service_date').notNullable();
    table.text('region').notNullable();
    table.decimal('latitude', 9, 6).notNullable();
    table.decimal('longitude', 9, 6).notNullable();
    table.decimal('snowfall_cm', 6, 2).notNullable();
    table.decimal('threshold_cm', 6, 2).notNullable();
    table.boolean('triggered').notNullable();
    table.integer('notified').notNullable().defaultTo(0);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['branch_id', 'service_date', 'region'], {
      indexName: 'weather_alert_runs_branch_date_region_unique',
    });
  });

  await knex.raw(`
    create trigger weather_alert_runs_set_updated_at before update on weather_alert_runs
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('weather_alert_runs');
  await knex.schema.alterTable('message_log', (table) => {
    table.dropColumn('email_lead_id');
  });
  await knex.schema.dropTableIfExists('email_leads');
  await knex.schema.dropTableIfExists('expenses');
}
