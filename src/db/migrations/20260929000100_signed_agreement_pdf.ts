import type { Knex } from 'knex';

/**
 * The sign-up is now the company's own PDF agreement, filled in on screen.
 *
 * - `quotes.agreement_fields` keeps every field exactly as it was filled in,
 *   so the signed PDF can be produced from it and shows what was agreed.
 * - `quotes.package` and `quotes.addons` are the parts of it the rest of the
 *   system reads (the map, the contract screen), as plain columns.
 * - `contracts.provider_signature_url` is the rep's signature on the
 *   "Service provider" line, beside the customer's in signature_image_url.
 *   The filled, signed PDF itself goes in the existing contracts.pdf_url.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('quotes', (table) => {
    table.jsonb('agreement_fields').nullable();
    table.text('package').nullable();
    table.specificType('addons', 'text[]').notNullable().defaultTo('{}');
  });
  await knex.raw(`
    alter table quotes add constraint quotes_package_check
      check (package is null or package in ('basic', 'premium'))
  `);
  await knex.schema.alterTable('contracts', (table) => {
    table.text('provider_signature_url').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('contracts', (table) => {
    table.dropColumn('provider_signature_url');
  });
  await knex.raw('alter table quotes drop constraint quotes_package_check');
  await knex.schema.alterTable('quotes', (table) => {
    table.dropColumn('agreement_fields');
    table.dropColumn('package');
    table.dropColumn('addons');
  });
}
