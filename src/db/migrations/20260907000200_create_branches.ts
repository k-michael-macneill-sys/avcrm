import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('branches', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('name').notNullable().unique();
    table.text('province').notNullable();
    // IANA zone, e.g. America/Toronto. Drives scheduling and automation
    // send times, so it is required rather than defaulted per-request.
    table.text('timezone').notNullable().defaultTo('America/Toronto');
    table.text('status').notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // manager_user_id is added after users exists — the two tables reference
  // each other, so the FK cannot be declared here.

  await knex.raw(`
    alter table branches add constraint branches_status_check
      check (status in ('active', 'inactive'))
  `);

  await knex.raw(`
    create trigger branches_set_updated_at before update on branches
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('branches');
}
