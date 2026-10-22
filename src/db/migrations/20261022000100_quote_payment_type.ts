import type { Knex } from 'knex';

/**
 * How the customer pays, chosen on the contract form. Null on every
 * agreement written before the form asked, which keep taking a card the way
 * they always did. The list is written out here rather than imported: a
 * migration is history, and must not change when the application's does.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('quotes', (table) => {
    table.text('payment_type').nullable();
  });
  await knex.raw(`
    alter table quotes add constraint quotes_payment_type_check
      check (payment_type in ('credit_card', 'visa_debit', 'cheque', 'e_transfer', 'cash', 'yia'))
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('alter table quotes drop constraint quotes_payment_type_check');
  await knex.schema.alterTable('quotes', (table) => {
    table.dropColumn('payment_type');
  });
}
