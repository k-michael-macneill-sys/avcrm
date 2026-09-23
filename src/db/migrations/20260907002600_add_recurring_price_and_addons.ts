import type { Knex } from 'knex';

/**
 * What the rep actually sells at the door, in the three numbers they quote.
 *
 * initial_price is the list price, the anchor the discount is shown against.
 * discounted_price is what the customer pays for the first visit. Neither is
 * new. recurring_price is: what they pay every month after that first visit.
 * Without it a monthly contract was billed the same amount every period,
 * which made the first visit and every visit after it indistinguishable.
 *
 * Nullable, and only ever set on a monthly contract: seasonal is one payment
 * for the whole season, so a recurring amount on one would be a contradiction
 * the billing run has no way to act on. The constraint says so rather than
 * leaving it to whoever writes the next form.
 *
 * The add-ons are what the visit includes beyond clearing the drive. They
 * carry no price of their own — the rep prices the job as a whole and ticks
 * what is in it, so the crew arriving knows to bring salt or do the stairs.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('quotes', (table) => {
    table.decimal('recurring_price', 10, 2).nullable();
    table.boolean('addon_salt').notNullable().defaultTo(false);
    table.boolean('addon_vehicle').notNullable().defaultTo(false);
    table.boolean('addon_stairs').notNullable().defaultTo(false);
  });

  await knex.raw(`
    alter table quotes add constraint quotes_recurring_price_check
      check (recurring_price is null or recurring_price >= 0)
  `);

  await knex.raw(`
    alter table quotes add constraint quotes_recurring_billing_type_check
      check (recurring_price is null or billing_type = 'monthly')
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw('alter table quotes drop constraint if exists quotes_recurring_billing_type_check');
  await knex.raw('alter table quotes drop constraint if exists quotes_recurring_price_check');
  await knex.schema.alterTable('quotes', (table) => {
    table.dropColumn('recurring_price');
    table.dropColumn('addon_salt');
    table.dropColumn('addon_vehicle');
    table.dropColumn('addon_stairs');
  });
}
