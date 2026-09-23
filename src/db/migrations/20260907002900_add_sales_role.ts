import type { Knex } from 'knex';

/**
 * Sales reps as their own role.
 *
 * Until now "operator" meant everybody in the field, selling and clearing
 * alike. They are different jobs done by different people: a rep knocks
 * doors and signs customers up, an operator drives the route and clears
 * driveways. A rep belongs to a branch exactly as an operator does, so the
 * branch rule widens to cover both — only corporate works across branches.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('alter table users drop constraint users_role_check');
  await knex.raw(`
    alter table users add constraint users_role_check
      check (role in ('corporate', 'operator', 'sales'))
  `);

  await knex.raw('alter table users drop constraint users_operator_needs_branch_check');
  await knex.raw(`
    alter table users add constraint users_field_staff_need_branch_check
      check (role = 'corporate' or branch_id is not null)
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('alter table users drop constraint users_field_staff_need_branch_check');
  await knex.raw(`
    alter table users add constraint users_operator_needs_branch_check
      check (role <> 'operator' or branch_id is not null)
  `);
  await knex.raw('alter table users drop constraint users_role_check');
  await knex.raw(`
    alter table users add constraint users_role_check
      check (role in ('corporate', 'operator'))
  `);
}
