import type { Knex } from 'knex';

/**
 * A fourth way a door can go: "monitor", somebody worth keeping an eye on
 * who is not a lead yet. Taken down with the same contact details as a lead.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('alter table lead_pins drop constraint lead_pins_status_check');
  await knex.raw(`
    alter table lead_pins add constraint lead_pins_status_check
      check (status in ('not_home', 'not_interested', 'lead', 'monitor'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex('lead_pins').where({ status: 'monitor' }).update({ status: 'lead' });
  await knex.raw('alter table lead_pins drop constraint lead_pins_status_check');
  await knex.raw(`
    alter table lead_pins add constraint lead_pins_status_check
      check (status in ('not_home', 'not_interested', 'lead'))
  `);
}
