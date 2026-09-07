import type { Knex } from 'knex';

/**
 * Extensions and the shared updated_at trigger. citext is a trusted extension
 * in PG13+, so the database owner can create it without superuser rights.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('create extension if not exists citext');

  await knex.raw(`
    create or replace function set_updated_at() returns trigger as $$
    begin
      new.updated_at = now();
      return new;
    end;
    $$ language plpgsql
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop function if exists set_updated_at()');
  // citext is left in place: other schemas in the same database may rely on it.
}
