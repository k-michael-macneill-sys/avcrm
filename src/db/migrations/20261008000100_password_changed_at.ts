import type { Knex } from 'knex';

/**
 * When each account's password last changed.
 *
 * Sessions are stateless tokens, so without this a password change leaves
 * every token issued before it working until it expires — including one
 * somebody stole, which is usually why the password is being changed. A token
 * issued before this moment is refused (see middleware/auth.ts).
 *
 * Null for every existing account: nothing has been changed yet, so every
 * session already out there stays good.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.timestamp('password_changed_at', { useTz: true }).nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('users', (table) => {
    table.dropColumn('password_changed_at');
  });
}
