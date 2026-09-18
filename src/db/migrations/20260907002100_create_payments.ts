import type { Knex } from 'knex';

/**
 * Money actually received, or an attempt that failed. Rows are never deleted:
 * a refund flips the original row to `refunded` rather than removing it, so
 * the history of a disputed charge survives.
 *
 * provider_transaction_id is the processor's id. As with contracts, no card
 * data lands here — the token lives on the contract and is never copied.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('payments', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('invoice_id')
      .notNullable()
      .references('id')
      .inTable('invoices')
      .onDelete('RESTRICT');
    table.decimal('amount', 10, 2).notNullable();
    table.text('method').notNullable();
    table.text('provider_transaction_id').nullable();
    table.text('status').notNullable().defaultTo('pending');
    table.text('failure_reason').nullable();
    table.timestamp('processed_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['invoice_id'], 'payments_invoice_id_index');
    table.index(['status'], 'payments_status_index');
  });

  await knex.raw(`
    alter table payments add constraint payments_method_check
      check (method in ('card_on_file', 'etransfer', 'cheque', 'cash'))
  `);

  await knex.raw(`
    alter table payments add constraint payments_status_check
      check (status in ('pending', 'succeeded', 'failed', 'refunded'))
  `);

  await knex.raw(`
    alter table payments add constraint payments_amount_check
      check (amount > 0)
  `);

  // A failure says why; anything settled says when.
  await knex.raw(`
    alter table payments add constraint payments_failure_reason_check
      check (status <> 'failed' or failure_reason is not null)
  `);

  await knex.raw(`
    alter table payments add constraint payments_processed_at_check
      check (status = 'pending' or processed_at is not null)
  `);

  // The processor's id is unique where it exists, so a webhook replay cannot
  // book the same charge twice.
  await knex.raw(`
    create unique index payments_provider_transaction_unique
      on payments (provider_transaction_id)
      where provider_transaction_id is not null
  `);

  await knex.raw(`
    create trigger payments_set_updated_at before update on payments
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('payments');
}
