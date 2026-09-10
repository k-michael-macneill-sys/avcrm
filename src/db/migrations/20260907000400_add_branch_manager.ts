import type { Knex } from 'knex';

/**
 * Closes the branches <-> users cycle. Separate migration so both tables can
 * be created cleanly first, and so the rollback drops the constraint before
 * either table goes away.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('branches', (table) => {
    // The manager who receives service photo emails and expiry warnings.
    table
      .uuid('manager_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('branches', (table) => {
    table.dropColumn('manager_user_id');
  });
}
