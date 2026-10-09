import type { Knex } from 'knex';

/**
 * A branch's own sign-in password, set from the sign-in screen's "Reset
 * password". A branch with no row here still signs in with the shared
 * BRANCH_SIGN_IN_PASSWORD. Its own table rather than a column on branches,
 * so no endpoint that returns a branch row can ever hand the hash out.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('branch_sign_in_passwords', (table) => {
    table.uuid('branch_id').primary().references('id').inTable('branches').onDelete('CASCADE');
    table.text('password_hash').notNullable();
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTable('branch_sign_in_passwords');
}
