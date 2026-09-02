import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('customers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    table.text('name').notNullable();
    table.text('phone').nullable();
    table.text('address').nullable();
    table.text('email').nullable();
    table.text('contract_status').notNullable().defaultTo('none');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['branch_id'], 'customers_branch_id_index');
    table.index(['branch_id', 'contract_status'], 'customers_branch_status_index');
  });

  await knex.raw(`
    alter table customers add constraint customers_contract_status_check
      check (contract_status in ('none', 'pending', 'active', 'expired', 'cancelled'))
  `);

  // Case-insensitive email uniqueness within a branch, ignoring NULLs.
  await knex.raw(`
    create unique index customers_branch_email_unique
      on customers (branch_id, lower(email)) where email is not null
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('customers');
}
