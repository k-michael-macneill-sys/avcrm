import type { Knex } from 'knex';

const ROLES = ['admin', 'manager', 'dispatcher', 'operator'];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('email').notNullable().unique();
    table.text('password_hash').notNullable();
    table.text('name').notNullable();
    table.text('role').notNullable().defaultTo('operator');
    table
      .uuid('branch_id')
      .nullable()
      .references('id')
      .inTable('branches')
      .onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.check('?? in (' + ROLES.map(() => '?').join(', ') + ')', ['role', ...ROLES], 'users_role_check');
    table.index(['branch_id'], 'users_branch_id_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
}
