/**
 * The wording of the billing emails: the invoice, the past-due reminder and
 * the receipt. Each lays its numbers out as "Label: value" lines, which the
 * email layout draws as a table, and puts the customer's link to their bill
 * behind a button (see services/emailLayout.ts). Shared by the installed
 * configuration and the migration that brought them in.
 */

export const INVOICE_SENT_EMAIL = {
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

export const INVOICE_OVERDUE_EMAIL = {
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

export const PAYMENT_RECEIPT_EMAIL = {
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

export const PAYMENT_RECEIPT_SMS = {
  subject: null,
  body: '{{branch_name}}: thanks, we received {{amount_paid_text}} for {{address_line1}}. Your invoice is paid in full. Receipt: {{pay_url}}',
};
