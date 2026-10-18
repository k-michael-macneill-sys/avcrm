import type { Knex } from 'knex';

/**
 * The signed-copy email reworded, and the welcome email that follows it a
 * day later.
 *
 * The wording is written out here rather than imported: a migration is
 * history, and must not change when the application's copy does. The signed
 * copy is only reworded where it still has the wording it was installed
 * with, so a branch's own version is left alone.
 */
const OLD_AGREEMENT_SIGNED_BODY =
  'Hi {{customer_first_name}},\n\nThank you for choosing Drift Property Services. ' +
  'Your signed service agreement for {{address_line1}} is attached for your records.\n\n' +
  'Agreement: {{agreement_name}}\nFirst payment: {{first_payment}}\n\n' +
  'You may cancel within ten days of signing at no charge. Reply to this email with any questions.\n\n' +
  '— {{branch_name}}';
const OLD_AGREEMENT_SIGNED_SUBJECT = 'Your Drift Property Services agreement for {{address_line1}}';

const AGREEMENT_SIGNED_EMAIL = {
  subject: 'Your Drift Property Services agreement is signed, welcome aboard',
  body: [
    'Hi {{customer_first_name}},',
    '',
    'Thanks for signing with Drift Property Services. We’re glad to have you, and a copy of your signed agreement is attached for your records.',
    '',
    'Your agreement at a glance',
    '',
    '- Service: {{service_type}}',
    '- Property address: {{property_address}}',
    '- Service period: {{start_date}} to {{end_date}}',
    '- Price / billing: {{billing_terms}}',
    '',
    'What happens next',
    '',
    '1. We’ll do a quick walkthrough of the property to note obstacles, where snow can be piled, and any priority areas.',
    '2. Service starts {{start_date}}. We come out whenever snowfall reaches {{snowfall_threshold}} or more, once a day until it stops.',
    '3. Your first payment of {{first_payment}} is due {{first_payment_date}}.',
    '',
    'A few things that help us serve you well',
    '',
    '- Please let us know about anything on the property we should be aware of (hidden hazards, irrigation heads, pet areas, vehicles that are regularly parked on site).',
    '- If your contact details or access instructions change, just reply to this email.',
    '',
    'You may cancel within ten days of signing at no charge.',
    '',
    'If you have any questions, you can reach us directly {{contact_sentence}}.',
    '',
    'Thanks again for trusting us with your property.',
    '',
    '{{sender_name}}',
    'Drift Property Services',
    '{{contact_line}}',
  ].join('\n'),
};

const CUSTOMER_WELCOME_EMAIL = {
  subject: 'Welcome to Drift Property Services, {{customer_first_name}}',
  body: [
    'Hi {{customer_first_name}},',
    '',
    'Welcome to Drift! We’re excited to be taking care of {{property_address}}, and we appreciate you choosing us.',
    '',
    'Who we are',
    '',
    'Drift Property Services is a local, owner-operated company. We keep things simple: show up when we say we will, do the job properly, and make it easy to reach us when you need us.',
    '',
    'What to expect',
    '',
    '- Your services: {{service_type}}',
    '- Your first visit: the first snowfall of {{snowfall_threshold}} or more from {{start_date}}',
    '- How we’ll communicate: We’ll send a heads-up the evening before a snowfall service and a confirmation once the work is done.',
    '- Billing: {{billing_terms}}',
    '',
    'How to get the most out of your service',
    '',
    '- Let us know about anything we should watch for on the property, like hidden hazards, irrigation heads, pet areas or gate codes.',
    '- If you’d like to add or change a service, just reply to this email.',
    '- For anything urgent, {{urgent_contact}}.',
    '',
    'Your point of contact',
    '',
    '{{sender_name}}',
    '{{contact_line}}',
    '',
    '{{referral_line}}We’re looking forward to working with you. If there’s ever anything we can do better, tell us directly. We want to hear it.',
    '',
    'Thanks again, and welcome to Drift.',
    '',
    '{{sender_name}}',
    'Drift Property Services',
  ].join('\n'),
};

export async function up(knex: Knex): Promise<void> {
  await knex('message_templates')
    .where({ code: 'agreement_signed', channel: 'email', subject: OLD_AGREEMENT_SIGNED_SUBJECT, body: OLD_AGREEMENT_SIGNED_BODY })
    .whereNull('branch_id')
    .update(AGREEMENT_SIGNED_EMAIL);

  await knex('message_templates')
    .insert({ code: 'customer_welcome', channel: 'email', branch_id: null, ...CUSTOMER_WELCOME_EMAIL })
    .onConflict(knex.raw('(code, channel) where branch_id is null'))
    .ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex('message_templates').where({ code: 'customer_welcome' }).delete();
  await knex('message_templates')
    .where({ code: 'agreement_signed', channel: 'email', ...AGREEMENT_SIGNED_EMAIL })
    .whereNull('branch_id')
    .update({ subject: OLD_AGREEMENT_SIGNED_SUBJECT, body: OLD_AGREEMENT_SIGNED_BODY });
}
