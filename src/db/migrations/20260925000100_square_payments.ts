import type { Knex } from 'knex';

/**
 * Square as a second processor, and a page where a customer pays a bill.
 *
 * - `customers.square_customer_id` sits beside the Stripe one rather than
 *   replacing it: a customer created at one processor does not exist at the
 *   other, and switching back must not lose the first.
 * - `contracts.payment_method_provider` and `payments.provider` say which
 *   processor a saved card or a charge belongs to. A Stripe card cannot be
 *   charged through Square, and a Square payment can only be refunded there.
 * - `invoices.portal_token` is the capability in the link a customer is sent.
 *   Created when it is first needed, so it is nullable and has no backfill.
 * - The `autopay_*` columns on contracts are the customer's signed consent to
 *   be charged automatically, for one year. The wording they signed is kept
 *   verbatim, because "what exactly did I agree to" is the first question in
 *   a dispute.
 */

const OLD_INVOICE_SENT =
  'Hi {{customer_first_name}},\n\nYour invoice for {{billing_period_start}} ' +
  'to {{billing_period_end}} at {{address_line1}} comes to ${{amount_due}}, ' +
  'due {{due_date}}.\n\n— {{branch_name}}';

const NEW_INVOICE_SENT =
  'Hi {{customer_first_name}},\n\nYour invoice for {{billing_period_start}} ' +
  'to {{billing_period_end}} at {{address_line1}} comes to ${{amount_due}}, ' +
  'due {{due_date}}.\n\n{{pay_prompt}}: {{pay_url}}\n\n— {{branch_name}}';

const OLD_INVOICE_OVERDUE =
  'Hi {{customer_first_name}},\n\n${{amount_outstanding}} for ' +
  '{{address_line1}} was due on {{due_date}} and is still outstanding. ' +
  'Service continues — please settle up when you can.\n\n— {{branch_name}}';

const NEW_INVOICE_OVERDUE =
  'Hi {{customer_first_name}},\n\n${{amount_outstanding}} for ' +
  '{{address_line1}} was due on {{due_date}} and is still outstanding. ' +
  'Service continues — please settle up when you can.\n\n' +
  '{{pay_prompt}}: {{pay_url}}\n\n— {{branch_name}}';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('customers', (table) => {
    table.text('square_customer_id').nullable();
  });
  await knex.raw(`
    create unique index customers_square_customer_id_unique
      on customers (square_customer_id)
      where square_customer_id is not null
  `);

  await knex.schema.alterTable('contracts', (table) => {
    table.text('payment_method_provider').nullable();
    table.text('autopay_signature_url').nullable();
    table.text('autopay_signer_name').nullable();
    table.text('autopay_terms').nullable();
    table.timestamp('autopay_signed_at', { useTz: true }).nullable();
    table.text('autopay_signed_ip').nullable();
    table.date('autopay_expires_on').nullable();
  });
  // A signed authorization is all of these or none of them.
  await knex.raw(`
    alter table contracts add constraint contracts_autopay_complete_check
      check (
        (autopay_signed_at is null) = (autopay_signature_url is null)
        and (autopay_signed_at is null) = (autopay_terms is null)
        and (autopay_signed_at is null) = (autopay_expires_on is null)
        and (autopay_signed_at is null) = (autopay_signer_name is null)
      )
  `);
  // Every token saved so far came through the only processor there was.
  await knex('contracts')
    .whereNotNull('payment_method_token')
    .whereRaw("payment_method_token like 'pm\\_%'")
    .update({ payment_method_provider: 'stripe' });

  await knex.schema.alterTable('payments', (table) => {
    table.text('provider').nullable();
  });

  await knex.raw('alter table payments drop constraint payments_method_check');
  await knex.raw(`
    alter table payments add constraint payments_method_check
      check (method in ('card_on_file', 'online', 'etransfer', 'cheque', 'cash'))
  `);

  await knex.schema.alterTable('invoices', (table) => {
    table.text('portal_token').nullable().unique();
  });

  // Only where nobody has reworded them: an upgrade adds the link, it does
  // not overwrite a branch manager's wording.
  await knex('message_templates')
    .where({ code: 'invoice_sent', channel: 'email', body: OLD_INVOICE_SENT })
    .whereNull('branch_id')
    .update({ body: NEW_INVOICE_SENT });
  await knex('message_templates')
    .where({ code: 'invoice_overdue', channel: 'email', body: OLD_INVOICE_OVERDUE })
    .whereNull('branch_id')
    .update({ body: NEW_INVOICE_OVERDUE });
}

export async function down(knex: Knex): Promise<void> {
  await knex('message_templates')
    .where({ code: 'invoice_sent', channel: 'email', body: NEW_INVOICE_SENT })
    .whereNull('branch_id')
    .update({ body: OLD_INVOICE_SENT });
  await knex('message_templates')
    .where({ code: 'invoice_overdue', channel: 'email', body: NEW_INVOICE_OVERDUE })
    .whereNull('branch_id')
    .update({ body: OLD_INVOICE_OVERDUE });

  await knex.schema.alterTable('invoices', (table) => {
    table.dropColumn('portal_token');
  });

  await knex.raw('alter table payments drop constraint payments_method_check');
  await knex.raw(`
    alter table payments add constraint payments_method_check
      check (method in ('card_on_file', 'etransfer', 'cheque', 'cash'))
  `);
  await knex.schema.alterTable('payments', (table) => {
    table.dropColumn('provider');
  });

  await knex.raw('alter table contracts drop constraint contracts_autopay_complete_check');
  await knex.schema.alterTable('contracts', (table) => {
    table.dropColumn('payment_method_provider');
    table.dropColumn('autopay_signature_url');
    table.dropColumn('autopay_signer_name');
    table.dropColumn('autopay_terms');
    table.dropColumn('autopay_signed_at');
    table.dropColumn('autopay_signed_ip');
    table.dropColumn('autopay_expires_on');
  });

  await knex.raw('drop index if exists customers_square_customer_id_unique');
  await knex.schema.alterTable('customers', (table) => {
    table.dropColumn('square_customer_id');
  });
}
