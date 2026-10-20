import type { Knex } from 'knex';

/**
 * The invoice and past-due emails reworded for the branded layout, and the
 * receipt sent when an invoice is paid in full.
 *
 * The wording is written out here rather than imported: a migration is
 * history, and must not change when the application's copy does. The two
 * invoice emails are only reworded where they still have the wording they
 * were installed with, so a branch's own version is left alone.
 */
const OLD_INVOICE_SENT = {
  subject: 'Your invoice for {{address_line1}}',
  body:
    'Hi {{customer_first_name}},\n\nYour invoice for {{billing_period_start}} ' +
    'to {{billing_period_end}} at {{address_line1}} comes to ${{amount_due}}, ' +
    'due {{due_date}}.\n\n{{pay_prompt}}: {{pay_url}}\n\n— {{branch_name}}',
};

const OLD_INVOICE_OVERDUE = {
  subject: 'Your {{address_line1}} invoice is past due',
  body:
    'Hi {{customer_first_name}},\n\n${{amount_outstanding}} for ' +
    '{{address_line1}} was due on {{due_date}} and is still outstanding. ' +
    'Service continues — please settle up when you can.\n\n' +
    '{{pay_prompt}}: {{pay_url}}\n\n— {{branch_name}}',
};

const INVOICE_SENT_EMAIL = {
  subject: 'Your invoice for {{address_line1}}',
  body: [
    'Hi {{customer_first_name}},',
    '',
    'Here’s your invoice for snow clearing at {{address_line1}}.',
    '',
    'Invoice',
    '',
    '{{invoice_summary}}',
    '',
    '→ {{pay_button}}: {{pay_url}}',
    '',
    '{{payment_note}}',
    '',
    'Questions about your bill? Just reply to this email.',
    '',
    'The {{branch_name}} team',
    'Drift Property Services',
  ].join('\n'),
};

const INVOICE_OVERDUE_EMAIL = {
  subject: 'Your {{address_line1}} invoice is past due',
  body: [
    'Hi {{customer_first_name}},',
    '',
    'A friendly reminder: your invoice for {{address_line1}} was due on {{due_on}} and still has {{outstanding}} owing. Your service continues, so please settle up when you can.',
    '',
    'Invoice',
    '',
    '{{invoice_summary}}',
    '',
    '→ {{pay_button}}: {{pay_url}}',
    '',
    'Already paid? Thank you, and please ignore this note. If something doesn’t look right, just reply to this email.',
    '',
    'The {{branch_name}} team',
    'Drift Property Services',
  ].join('\n'),
};

const PAYMENT_RECEIPT_EMAIL = {
  subject: 'Payment received for {{address_line1}}, thank you',
  body: [
    'Hi {{customer_first_name}},',
    '',
    'Thank you! We’ve received your payment for {{address_line1}}, and your invoice is paid in full. This email is your receipt.',
    '',
    'Receipt',
    '',
    '{{receipt_summary}}',
    '',
    '→ View your invoice: {{pay_url}}',
    '',
    'Please keep this email for your records. If anything doesn’t look right, just reply to this email.',
    '',
    'The {{branch_name}} team',
    'Drift Property Services',
  ].join('\n'),
};

const PAYMENT_RECEIPT_SMS = {
  subject: null,
  body: '{{branch_name}}: thanks, we received {{amount_paid_text}} for {{address_line1}}. Your invoice is paid in full. Receipt: {{pay_url}}',
};

export async function up(knex: Knex): Promise<void> {
  await knex('message_templates')
    .where({ code: 'invoice_sent', channel: 'email', ...OLD_INVOICE_SENT })
    .whereNull('branch_id')
    .update(INVOICE_SENT_EMAIL);
  await knex('message_templates')
    .where({ code: 'invoice_overdue', channel: 'email', ...OLD_INVOICE_OVERDUE })
    .whereNull('branch_id')
    .update(INVOICE_OVERDUE_EMAIL);

  await knex('message_templates')
    .insert([
      { code: 'payment_receipt', channel: 'email', branch_id: null, ...PAYMENT_RECEIPT_EMAIL },
      { code: 'payment_receipt', channel: 'sms', branch_id: null, ...PAYMENT_RECEIPT_SMS },
    ])
    .onConflict(knex.raw('(code, channel) where branch_id is null'))
    .ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex('message_templates').where({ code: 'payment_receipt' }).delete();
  await knex('message_templates')
    .where({ code: 'invoice_sent', channel: 'email', ...INVOICE_SENT_EMAIL })
    .whereNull('branch_id')
    .update(OLD_INVOICE_SENT);
  await knex('message_templates')
    .where({ code: 'invoice_overdue', channel: 'email', ...INVOICE_OVERDUE_EMAIL })
    .whereNull('branch_id')
    .update(OLD_INVOICE_OVERDUE);
}
