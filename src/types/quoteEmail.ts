/**
 * The wording of the quote email: the price, laid out as a table, and a
 * button to the page where the customer reads the terms, signs and adds
 * their card. Shared by the installed configuration and the migration that
 * brought it in. See services/emailLayout.ts for how the plain text becomes
 * the branded HTML.
 */
export const QUOTE_EMAIL = {
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
