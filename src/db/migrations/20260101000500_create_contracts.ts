import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('contracts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('CASCADE');
    table.decimal('price', 12, 2).notNullable();
    table.date('start_date').notNullable();
    table.date('end_date').notNullable();
    table.boolean('auto_renew').notNullable().defaultTo(false);
    table.text('terms').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['customer_id'], 'contracts_customer_id_index');
    table.index(['start_date', 'end_date'], 'contracts_date_range_index');
  });

  await knex.raw(
    'alter table contracts add constraint contracts_price_check check (price >= 0)',
  );
  await knex.raw(`
    alter table contracts add constraint contracts_date_order_check
      check (end_date >= start_date)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('contracts');
}
