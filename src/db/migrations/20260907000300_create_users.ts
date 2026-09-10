import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('users', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Nullable for corporate staff, who are not tied to one branch.
    table
      .uuid('branch_id')
      .nullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    table.specificType('email', 'citext').notNullable().unique();
    table.text('password_hash').notNullable();
    table.text('first_name').notNullable();
    table.text('last_name').notNullable();
    table.text('phone').nullable();
    table.text('role').notNullable().defaultTo('operator');
    table.text('onboarding_status').notNullable().defaultTo('pending');
    table.boolean('is_active').notNullable().defaultTo(true);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['branch_id'], 'users_branch_id_index');
    table.index(['role'], 'users_role_index');
  });

  await knex.raw(`
    alter table users add constraint users_role_check
      check (role in ('corporate', 'operator'))
  `);

  await knex.raw(`
    alter table users add constraint users_onboarding_status_check
      check (onboarding_status in ('pending', 'docs_submitted', 'approved', 'suspended'))
  `);

  // An operator is scoped to exactly one branch; corporate spans all of them.
  await knex.raw(`
    alter table users add constraint users_operator_needs_branch_check
      check (role <> 'operator' or branch_id is not null)
  `);

  await knex.raw(`
    create trigger users_set_updated_at before update on users
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('users');
}
