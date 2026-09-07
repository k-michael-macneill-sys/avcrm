import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('payments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('RESTRICT');
    table.decimal('amount', 12, 2).notNullable();
    table.timestamp('date', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('status').notNullable().defaultTo('pending');
    table.text('method').notNullable();
    // Processor reference (mocked for now, e.g. a Stripe charge id).
    table.text('reference').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['customer_id'], 'payments_customer_id_index');
    table.index(['status'], 'payments_status_index');
    table.index(['date'], 'payments_date_index');
  });

  await knex.raw(`
    alter table payments add constraint payments_status_check
      check (status in ('pending', 'succeeded', 'failed', 'refunded'))
  `);
  await knex.raw(`
    alter table payments add constraint payments_method_check
      check (method in ('card', 'ach', 'check', 'cash'))
  `);
  await knex.raw(
    'alter table payments add constraint payments_amount_check check (amount > 0)',
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payments');
}
