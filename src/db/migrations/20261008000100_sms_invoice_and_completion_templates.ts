import type { Knex } from 'knex';

/**
 * Text versions of the visit-complete notice and the two invoice messages,
 * for customers who asked for texts or have no email. Without them those
 * customers heard nothing at all: both were sent by email only.
 *
 * The same rows are in appConfig for a fresh install; this is for one that
 * is already running. Global rows only, and only where none exists yet.
 */
const TEMPLATES = [
  {
    code: 'service_complete',
    channel: 'sms' as const,
    branch_id: null,
    subject: null,
    body: '{{branch_name}}: {{service_type}} at {{address_line1}} is done. Operator: {{operator_name}}.',
  },
  {
    code: 'invoice_sent',
    channel: 'sms' as const,
    branch_id: null,
    subject: null,
    body:
      '{{branch_name}}: your invoice for {{address_line1}} is ${{amount_due}}, ' +
      'due {{due_date}}. {{pay_prompt}}: {{pay_url}}',
  },
  {
    code: 'invoice_overdue',
    channel: 'sms' as const,
    branch_id: null,
    subject: null,
    body:
      '{{branch_name}}: ${{amount_outstanding}} for {{address_line1}} was due ' +
      '{{due_date}} and is still outstanding. {{pay_prompt}}: {{pay_url}}',
  },
];

export async function up(knex: Knex): Promise<void> {
  await knex('message_templates')
    .insert(TEMPLATES)
    .onConflict(knex.raw('(code, channel) where branch_id is null'))
    .ignore();
}

export async function down(knex: Knex): Promise<void> {
  for (const { code, body } of TEMPLATES) {
    await knex('message_templates').where({ code, channel: 'sms', body }).whereNull('branch_id').delete();
  }
}
