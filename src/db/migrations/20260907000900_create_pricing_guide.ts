import type { Knex } from 'knex';

/**
 * Config table, not user data. Pre-fills a quote's list price from the
 * property's driveway size so pricing stays consistent between branches. The
 * rep can always override it — this guides the close, it does not gate it.
 *
 * Managed by seeds and corporate admin, the same way document_requirements is.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('pricing_guide', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('CASCADE');
    // Matches properties.driveway_size_cars: 1-6, where 6 means "6+".
    table.integer('driveway_size_cars').notNullable();
    table.text('billing_type').notNullable();
    // Monthly rate for `monthly`, season total for `seasonal_upfront`.
    table.decimal('initial_price', 10, 2).notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  await knex.raw(`
    alter table pricing_guide add constraint pricing_guide_billing_type_check
      check (billing_type in ('monthly', 'seasonal_upfront'))
  `);

  await knex.raw(`
    alter table pricing_guide add constraint pricing_guide_driveway_size_check
      check (driveway_size_cars between 1 and 6)
  `);

  await knex.raw(`
    alter table pricing_guide add constraint pricing_guide_price_check
      check (initial_price >= 0)
  `);

  // One suggested price per branch, driveway size and billing type. This is
  // also the lookup key the suggestion endpoint uses.
  await knex.raw(`
    alter table pricing_guide add constraint pricing_guide_key_unique
      unique (branch_id, driveway_size_cars, billing_type)
  `);

  await knex.raw(`
    create trigger pricing_guide_set_updated_at before update on pricing_guide
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('pricing_guide');
}
