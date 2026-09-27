import type { Knex } from 'knex';

/**
 * An address may now be on the books more than once — a new owner, a second
 * unit, a customer signed up again. The unique index that refused it goes;
 * a plain index on the same expressions stays, so "who else is at this
 * address" is still a fast lookup.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw('drop index if exists properties_normalized_address_unique');
  await knex.raw(`
    create index properties_normalized_address_index on properties (
      upper(regexp_replace(postal_code, '\\s+', '', 'g')),
      lower(regexp_replace(btrim(address_line1), '\\s+', ' ', 'g'))
    )
  `);
}

/** Fails if duplicates have been added since, which is the honest outcome. */
export async function down(knex: Knex): Promise<void> {
  await knex.raw('drop index if exists properties_normalized_address_index');
  await knex.raw(`
    create unique index properties_normalized_address_unique on properties (
      upper(regexp_replace(postal_code, '\\s+', '', 'g')),
      lower(regexp_replace(btrim(address_line1), '\\s+', ' ', 'g'))
    )
  `);
}
