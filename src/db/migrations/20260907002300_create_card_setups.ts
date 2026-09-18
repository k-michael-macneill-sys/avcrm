import type { Knex } from 'knex';

/**
 * Card capture, without the card.
 *
 * The customer enters their card on the processor's own hosted page, on their
 * own phone. Nothing here — not this server, not the browser client, not the
 * rep at the door — ever sees a card number, and nobody has to read a CVV out
 * loud on a doorstep. What comes back is a payment method id that can be
 * charged again next month.
 *
 * This table is the office's view of that: a link was sent, and either the
 * customer finished it or they did not.
 */
export async function up(knex: Knex): Promise<void> {
  // Where the processor knows this customer. Nullable: it only exists once
  // they have been asked for a card.
  await knex.schema.alterTable('customers', (table) => {
    table.text('stripe_customer_id').nullable();
  });

  await knex.raw(`
    create unique index customers_stripe_customer_id_unique
      on customers (stripe_customer_id)
      where stripe_customer_id is not null
  `);

  await knex.schema.createTable('card_setups', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('CASCADE');
    // The contract the captured card gets attached to.
    table
      .uuid('contract_id')
      .nullable()
      .references('id')
      .inTable('contracts')
      .onDelete('CASCADE');
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    // The processor's hosted session.
    table.text('provider_session_id').notNullable();
    table.text('url').notNullable();
    table.text('status').notNullable().defaultTo('sent');
    // Display only, once they have finished.
    table.text('payment_method_last4').nullable();
    table.text('payment_method_brand').nullable();
    table
      .uuid('requested_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['customer_id'], 'card_setups_customer_id_index');
    table.index(['contract_id'], 'card_setups_contract_id_index');
    table.index(['branch_id', 'status'], 'card_setups_branch_status_index');
  });

  await knex.raw(`
    alter table card_setups add constraint card_setups_session_unique
      unique (provider_session_id)
  `);

  await knex.raw(`
    alter table card_setups add constraint card_setups_status_check
      check (status in ('sent', 'completed', 'expired', 'cancelled'))
  `);

  await knex.raw(`
    alter table card_setups add constraint card_setups_completed_check
      check ((status = 'completed') = (completed_at is not null))
  `);

  await knex.raw(`
    create trigger card_setups_set_updated_at before update on card_setups
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('card_setups');
  await knex.raw('drop index if exists customers_stripe_customer_id_unique');
  await knex.schema.alterTable('customers', (table) => {
    table.dropColumn('stripe_customer_id');
  });
}
