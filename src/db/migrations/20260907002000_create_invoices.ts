import type { Knex } from 'knex';

/**
 * One bill for one billing period. A seasonal contract gets a single invoice
 * at signature; a monthly one gets an invoice per period, raised by the
 * billing job as each period starts rather than all at once at signature —
 * so cancelling a contract mid-season simply stops the next one being raised.
 *
 * amount_paid is derived: it is recomputed from the payments table after
 * every payment write rather than incremented, so a refund cannot leave it
 * drifting from what actually happened.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('invoices', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // RESTRICT: a bill outlives the paperwork it came from.
    table
      .uuid('contract_id')
      .notNullable()
      .references('id')
      .inTable('contracts')
      .onDelete('RESTRICT');
    table
      .uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('RESTRICT');
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    table.date('billing_period_start').notNullable();
    table.date('billing_period_end').notNullable();
    table.decimal('amount_due', 10, 2).notNullable();
    table.decimal('amount_paid', 10, 2).notNullable().defaultTo('0');
    table.text('status').notNullable().defaultTo('draft');
    table.date('due_date').notNullable();
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.timestamp('paid_at', { useTz: true }).nullable();
    table.text('pdf_url').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['customer_id'], 'invoices_customer_id_index');
    table.index(['branch_id', 'status'], 'invoices_branch_status_index');
    // The overdue sweep scans on this.
    table.index(['due_date'], 'invoices_due_date_index');
  });

  await knex.raw(`
    alter table invoices add constraint invoices_status_check
      check (status in ('draft', 'sent', 'paid', 'overdue', 'void'))
  `);

  await knex.raw(`
    alter table invoices add constraint invoices_amount_check
      check (amount_due >= 0 and amount_paid >= 0)
  `);

  await knex.raw(`
    alter table invoices add constraint invoices_period_check
      check (billing_period_end > billing_period_start)
  `);

  // Anything the customer has seen carries the time we sent it. A draft has
  // not been sent yet, and a draft cancelled before it went out never was.
  await knex.raw(`
    alter table invoices add constraint invoices_sent_at_check
      check (status in ('draft', 'void') or sent_at is not null)
  `);

  await knex.raw(`
    alter table invoices add constraint invoices_paid_at_check
      check ((status = 'paid') = (paid_at is not null))
  `);

  // One invoice per contract per period. This is what makes the billing job
  // safe to run twice in a night.
  await knex.raw(`
    create unique index invoices_contract_period_unique
      on invoices (contract_id, billing_period_start)
      where status <> 'void'
  `);

  await knex.raw(`
    create trigger invoices_set_updated_at before update on invoices
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('invoices');
}
