import type { Knex } from 'knex';

/**
 * Each branch's own snowfall trigger: the depth a new agreement starts at,
 * which the rep can still change per customer. Regina clears from 2 cm;
 * every other branch starts at 5 cm.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('branches', (table) => {
    table.decimal('default_trigger_cm', 4, 1).notNullable().defaultTo(5);
  });
  await knex.raw(`
    alter table branches add constraint branches_default_trigger_cm_check
      check (default_trigger_cm >= 0 and default_trigger_cm <= 100)
  `);
  await knex('branches').whereRaw('lower(name) = ?', ['regina']).update({ default_trigger_cm: '2.0' });
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('alter table branches drop constraint branches_default_trigger_cm_check');
  await knex.schema.alterTable('branches', (table) => {
    table.dropColumn('default_trigger_cm');
  });
}
