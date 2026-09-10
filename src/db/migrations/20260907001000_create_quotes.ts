import type { Knex } from 'knex';

/**
 * Manual pricing entry against one property. A quote is what the rep shows at
 * the door; a contract is what gets signed. Prices are numeric(10,2) and come
 * back from pg as strings, so no float ever touches money.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('quotes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('property_id')
      .notNullable()
      .references('id')
      .inTable('properties')
      .onDelete('CASCADE');
    // The rep who priced it.
    table
      .uuid('created_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.text('billing_type').notNullable();
    // List price before any discount the rep gives at the door.
    table.decimal('initial_price', 10, 2).notNullable();
    // What the customer actually pays: monthly rate, or the upfront total.
    table.decimal('discounted_price', 10, 2).notNullable();
    table.date('season_start').notNullable();
    table.date('season_end').notNullable();
    table.text('status').notNullable().defaultTo('draft');
    table.text('notes').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['property_id'], 'quotes_property_id_index');
    table.index(['status'], 'quotes_status_index');
    table.index(['created_by_user_id'], 'quotes_created_by_index');
  });

  await knex.raw(`
    alter table quotes add constraint quotes_billing_type_check
      check (billing_type in ('monthly', 'seasonal_upfront'))
  `);

  await knex.raw(`
    alter table quotes add constraint quotes_status_check
      check (status in ('draft', 'presented', 'accepted', 'declined', 'expired'))
  `);

  await knex.raw(`
    alter table quotes add constraint quotes_price_check
      check (initial_price >= 0 and discounted_price >= 0)
  `);

  // The column is named discounted_price, so it may not exceed the list price.
  // A rep who wants to charge more raises initial_price instead, which keeps
  // the discount reporting in build step 7 honest.
  await knex.raw(`
    alter table quotes add constraint quotes_discount_check
      check (discounted_price <= initial_price)
  `);

  await knex.raw(`
    alter table quotes add constraint quotes_season_check
      check (season_end > season_start)
  `);

  await knex.raw(`
    create trigger quotes_set_updated_at before update on quotes
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('quotes');
}
