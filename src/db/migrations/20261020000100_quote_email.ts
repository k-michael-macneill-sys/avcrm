import type { Knex } from 'knex';

/**
 * The quote email, for an install that is already running; a fresh one gets
 * it from appConfig. The wording is written out here rather than imported: a
 * migration is history, and must not change when the application's copy does.
 */
const QUOTE_EMAIL = {
  subject: 'Your snow clearing quote for {{address_line1}}',
  body: [
    'Hi {{customer_first_name}},',
    '',
    'Thanks for considering Drift Property Services for {{address_line1}}. Here’s your quote for the season.',
    '',
    'Your quote',
    '',
    '{{quote_summary}}',
    '',
    '→ Review and accept your quote: {{quote_url}}',
    '',
    'The page shows the full agreement and what you’ll be charged. When you’re ready, you can sign and add your card there in one go.',
    '',
    'This link is good until {{expires_on}} and is yours alone, so please don’t forward it.',
    '',
    'Questions? You can reach us {{contact_sentence}}. We’re happy to help.',
    '',
    '{{sender_name}}',
    'Drift Property Services',
  ].join('\n'),
};

export async function up(knex: Knex): Promise<void> {
  await knex('message_templates')
    .insert({ code: 'quote_sent', channel: 'email', branch_id: null, ...QUOTE_EMAIL })
    .onConflict(knex.raw('(code, channel) where branch_id is null'))
    .ignore();
}

export async function down(knex: Knex): Promise<void> {
  await knex('message_templates').where({ code: 'quote_sent' }).delete();
}
