import type { Knex } from 'knex';

/**
 * Signing in by branch.
 *
 * A `branch` role for each branch's own shared sign-in, a default city per
 * branch for the agreements that sign-in writes, and the four branches the
 * sign-in screen offers — added if they are not there yet, and given their
 * city if they are.
 *
 * The branch list is written out here rather than imported: a migration is
 * history, and must not change when the application's list does.
 */
const BRANCHES = [
  { name: 'Cranbrook', province: 'BC', timezone: 'America/Edmonton', default_city: 'Cranbrook' },
  { name: 'Kingston', province: 'ON', timezone: 'America/Toronto', default_city: 'Kingston' },
  // Several towns across Southern Alberta: the city is typed per customer.
  { name: 'Alberta', province: 'AB', timezone: 'America/Edmonton', default_city: null },
  { name: 'Regina', province: 'SK', timezone: 'America/Regina', default_city: 'Regina' },
];

export async function up(knex: Knex): Promise<void> {
  await knex.raw('alter table users drop constraint users_role_check');
  await knex.raw(`
    alter table users add constraint users_role_check
      check (role in ('corporate', 'operator', 'sales', 'branch'))
  `);

  await knex.schema.alterTable('branches', (table) => {
    table.text('default_city').nullable();
  });

  for (const branch of BRANCHES) {
    const existing = await knex('branches').whereRaw('lower(name) = lower(?)', [branch.name]).first('id');
    if (existing) {
      // An existing branch keeps its own settings; only the new column is filled.
      await knex('branches')
        .where({ id: existing.id })
        .whereNull('default_city')
        .update({ default_city: branch.default_city });
    } else {
      await knex('branches').insert(branch);
    }
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex('users').where({ role: 'branch' }).delete();
  await knex.schema.alterTable('branches', (table) => {
    table.dropColumn('default_city');
  });
  await knex.raw('alter table users drop constraint users_role_check');
  await knex.raw(`
    alter table users add constraint users_role_check
      check (role in ('corporate', 'operator', 'sales'))
  `);
}
