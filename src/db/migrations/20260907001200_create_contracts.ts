import type { Knex } from 'knex';

/**
 * What the customer signed, captured on the door. customer_id and property_id
 * are denormalized off the quote for query speed; the money stays on the quote,
 * which is frozen once it is accepted.
 *
 * No raw card data is ever stored here. payment_method_token is a processor
 * token; last4 and brand are display only, and the check constraint below
 * refuses anything shaped like a card number.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('contracts', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // RESTRICT, not CASCADE: deleting a quote must never take a signed
    // contract with it.
    table
      .uuid('quote_id')
      .notNullable()
      .references('id')
      .inTable('quotes')
      .onDelete('RESTRICT');
    table
      .uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('RESTRICT');
    table
      .uuid('property_id')
      .notNullable()
      .references('id')
      .inTable('properties')
      .onDelete('RESTRICT');
    table.text('signature_image_url').notNullable();
    table.timestamp('signed_at', { useTz: true }).notNullable();
    // Proves the rep was standing there when it was signed.
    table.text('signed_ip').nullable();
    table.decimal('signed_lat', 9, 6).nullable();
    table.decimal('signed_lng', 9, 6).nullable();
    // Which terms and conditions they actually agreed to.
    table.text('terms_version').notNullable();
    table.text('payment_method_token').nullable();
    table.text('payment_method_last4').nullable();
    table.text('payment_method_brand').nullable();
    // Generated and emailed after signature (build step 5).
    table.text('pdf_url').nullable();
    table.text('status').notNullable().defaultTo('active');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['customer_id'], 'contracts_customer_id_index');
    table.index(['property_id'], 'contracts_property_id_index');
    table.index(['status'], 'contracts_status_index');
  });

  // One contract per quote. A second sale needs a second quote.
  await knex.raw(`
    alter table contracts add constraint contracts_quote_id_unique unique (quote_id)
  `);

  await knex.raw(`
    alter table contracts add constraint contracts_status_check
      check (status in ('active', 'cancelled', 'completed'))
  `);

  await knex.raw(`
    alter table contracts add constraint contracts_last4_check
      check (payment_method_last4 is null or payment_method_last4 ~ '^[0-9]{4}$')
  `);

  // Display fields describe a token, so they cannot exist without one.
  await knex.raw(`
    alter table contracts add constraint contracts_payment_display_check
      check (
        payment_method_token is not null
        or (payment_method_last4 is null and payment_method_brand is null)
      )
  `);

  // Last line of defence against a PAN landing in the token column. The
  // service checks this too, with a better message.
  await knex.raw(`
    alter table contracts add constraint contracts_token_not_a_pan_check
      check (payment_method_token is null or payment_method_token !~ '^[0-9]{12,19}$')
  `);

  await knex.raw(`
    alter table contracts add constraint contracts_signed_lat_check
      check (signed_lat is null or signed_lat between -90 and 90)
  `);

  await knex.raw(`
    alter table contracts add constraint contracts_signed_lng_check
      check (signed_lng is null or signed_lng between -180 and 180)
  `);

  // A driveway can only be sold once at a time. Cancelled and completed
  // contracts stay for the audit trail and do not block next season's sale.
  await knex.raw(`
    create unique index contracts_one_active_per_property
      on contracts (property_id)
      where status = 'active'
  `);

  await knex.raw(`
    create trigger contracts_set_updated_at before update on contracts
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('contracts');
}
