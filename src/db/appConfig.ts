import type { Knex } from 'knex';
import type {
  ChecklistRequirement,
  DocumentRequirement,
  MessageTemplate,
} from '../types/models';

/**
 * The rows the application treats as configuration rather than data.
 *
 * Document requirements decide what an operator must supply before they can
 * be assigned work. Checklist requirements are the boxes the signature screen
 * renders and the gate `POST /contracts` enforces. Message templates are what
 * every queued email and text is rendered from.
 *
 * None of it is optional: with no templates the queue has nothing to render,
 * and with no checklist requirements a contract is signed against no terms at
 * all. It used to live only in the development seed, which refuses to run with
 * NODE_ENV=production — so a freshly deployed install had none of it, and
 * there was no way to put it there. It lives here now so `npm run bootstrap`
 * and the seed install exactly the same thing.
 *
 * Every insert is idempotent on the natural key, so running it again after an
 * upgrade adds what is new and leaves alone anything a branch has since
 * reworded.
 */

type DocumentRequirementRow = Omit<DocumentRequirement, 'id' | 'created_at' | 'updated_at'>;
type ChecklistRequirementRow = Omit<ChecklistRequirement, 'id' | 'created_at' | 'updated_at'>;
type MessageTemplateRow = Omit<MessageTemplate, 'id' | 'created_at' | 'updated_at'>;

export const DOCUMENT_REQUIREMENTS: DocumentRequirementRow[] = [
    {
      code: 'drivers_license',
      label: "Driver's licence",
      province: null,
      is_required: true,
      expires: true,
      default_validity_days: 1825,
    },
    {
      code: 'drivers_abstract',
      label: "Driver's abstract",
      province: null,
      is_required: true,
      expires: true,
      default_validity_days: 365,
    },
    {
      code: 'insurance_certificate',
      label: 'Insurance certificate',
      province: null,
      is_required: true,
      expires: true,
      default_validity_days: 365,
    },
    {
      code: 'vehicle_registration',
      label: 'Vehicle registration',
      province: null,
      is_required: true,
      expires: true,
      default_validity_days: 365,
    },
    {
      code: 'contractor_agreement',
      label: 'Contractor agreement',
      province: null,
      is_required: true,
      expires: false,
      default_validity_days: null,
    },
    {
      code: 'void_cheque',
      label: 'Void cheque',
      province: null,
      is_required: true,
      expires: false,
      default_validity_days: null,
    },
    {
      code: 'tax_form',
      label: 'Tax form',
      province: null,
      is_required: true,
      expires: false,
      default_validity_days: null,
    },
    {
      // Ontario's workers' compensation board; NS has its own scheme.
      code: 'wsib_clearance',
      label: 'WSIB clearance certificate',
      province: 'ON',
      is_required: true,
      expires: true,
      default_validity_days: 90,
    },
    {
      code: 'criminal_record_check',
      label: 'Criminal record check',
      province: null,
      is_required: false,
      expires: true,
      default_validity_days: 1095,
    },
];

export const CHECKLIST_REQUIREMENTS: ChecklistRequirementRow[] = [];

/**
 * The global set. A row carrying a branch_id overrides the global row for the
 * same code and channel, which is how a branch rewords a message without a
 * deploy — see the README. Those are the branch's to create, not ours.
 */
export const MESSAGE_TEMPLATES: MessageTemplateRow[] = [
    {
      code: 'service_complete',
      channel: 'email',
      branch_id: null,
      subject: '{{address_line1}} — {{service_type}} complete',
      body:
        'Hi {{customer_first_name}},\n\n' +
        '{{service_type}} at {{address_line1}}, {{city}} was completed at ' +
        '{{completed_at}}.\nOperator: {{operator_name}}\n\nPhotos:\n{{photo_list}}',
    },
    {
      // The office copy. A branch manager reading "Hi Harold, your driveway is
      // clear" is not a notification.
      code: 'service_complete_internal',
      channel: 'email',
      branch_id: null,
      subject: '[{{branch_name}}] {{address_line1}} — {{service_type}} complete',
      body:
        '{{service_type}} at {{address_line1}}, {{city}} was completed at ' +
        '{{completed_at}} by {{operator_name}}.\n\nPhotos:\n{{photo_list}}',
    },
    {
      code: 'en_route',
      channel: 'email',
      branch_id: null,
      subject: 'On the way to {{address_line1}}',
      body:
        'Hi {{customer_first_name}}, {{operator_name}} is on the way to ' +
        '{{address_line1}} now.',
    },
    {
      code: 'en_route',
      channel: 'sms',
      branch_id: null,
      subject: null,
      body: '{{operator_name}} is on the way to {{address_line1}} now.',
    },
    {
      code: 'review_request',
      channel: 'email',
      branch_id: null,
      subject: 'How did we do at {{address_line1}}?',
      body:
        'Hi {{customer_first_name}},\n\nHow did we do? One tap, no form:\n\n' +
        '1 star  {{rating_url_1}}\n2 stars {{rating_url_2}}\n' +
        '3 stars {{rating_url_3}}\n4 stars {{rating_url_4}}\n' +
        '5 stars {{rating_url_5}}\n\n— {{branch_name}}',
    },
    {
      code: 'review_request',
      channel: 'sms',
      branch_id: null,
      subject: null,
      body:
        'How did we do at {{address_line1}}? Tap to rate: ' +
        '1 {{rating_url_1}} 3 {{rating_url_3}} 5 {{rating_url_5}}',
    },
    {
      // The alert that makes the gate worth having: a poor rating reaches a
      // person instead of a public star.
      code: 'low_rating_internal',
      channel: 'email',
      branch_id: null,
      subject: '[{{branch_name}}] {{rating}}-star rating from {{customer_name}}',
      body:
        '{{customer_name}} rated a recent visit {{rating}} out of 5.\n\n' +
        'Email: {{customer_email}}\nPhone: {{customer_phone}}\n\n' +
        'Call them before they tell everyone else.',
    },
    {
      code: 'payment_failed',
      channel: 'email',
      branch_id: null,
      subject: 'We could not process your payment',
      body:
        'Hi {{customer_first_name}}, the card on file for {{address_line1}} was ' +
        'declined for {{amount}}. Service continues — please update your card ' +
        'when you get a moment.',
    },
    {
      code: 'renewal_reminder',
      channel: 'email',
      branch_id: null,
      subject: 'Your {{address_line1}} snow contract is up for renewal',
      body:
        'Hi {{customer_first_name}}, your season at {{address_line1}} ends on ' +
        '{{season_end}}. Reply and we will get next winter booked in.',
    },
    {
      code: 'document_expiring',
      channel: 'email',
      branch_id: null,
      subject: '{{label}} expires in {{days_left}} {{day_word}}',
      body:
        'Hi {{first_name}}, your {{label}} expires on {{expires_on}}.' +
        '{{required_note}} Please upload a current copy before then.',
    },
    {
      code: 'document_expiring_internal',
      channel: 'email',
      branch_id: null,
      subject: '[{{branch_name}}] {{operator_name}}: {{label}} expires in {{days_left}} {{day_word}}',
      body:
        '{{operator_name}} at {{branch_name}} has a {{label}} expiring on ' +
        '{{expires_on}}.',
    },
    {
      code: 'operator_suspended',
      channel: 'email',
      branch_id: null,
      subject: 'Your account has been suspended',
      body:
        'Hi {{first_name}}, a required document has expired, so you cannot be ' +
        'assigned work until it is replaced and approved. Please upload a ' +
        'current copy as soon as you can.',
    },
    {
      code: 'operator_suspended_internal',
      channel: 'email',
      branch_id: null,
      subject: '[{{branch_name}}] Operator suspended: {{operator_name}}',
      body:
        '{{operator_name}} has been suspended automatically because a required ' +
        'document expired. They are out of the assignable pool until it is ' +
        'replaced.',
    },
    {
      code: 'invoice_sent',
      channel: 'email',
      branch_id: null,
      subject: 'Your invoice for {{address_line1}}',
      body:
        'Hi {{customer_first_name}},\n\nYour invoice for {{billing_period_start}} ' +
        'to {{billing_period_end}} at {{address_line1}} comes to ${{amount_due}}, ' +
        'due {{due_date}}.\n\n{{pay_prompt}}: {{pay_url}}\n\n— {{branch_name}}',
    },
    {
      code: 'invoice_overdue',
      channel: 'email',
      branch_id: null,
      subject: 'Your {{address_line1}} invoice is past due',
      body:
        'Hi {{customer_first_name}},\n\n${{amount_outstanding}} for ' +
        '{{address_line1}} was due on {{due_date}} and is still outstanding. ' +
        'Service continues — please settle up when you can.\n\n' +
        '{{pay_prompt}}: {{pay_url}}\n\n— {{branch_name}}',
    },
    {
      // The link the customer taps to put a card on file. Nobody reads a card
      // number or a CVV out loud on a doorstep.
      code: 'card_setup_request',
      channel: 'email',
      branch_id: null,
      subject: 'Add a card for {{address_line1}}',
      body:
        'Hi {{customer_first_name}},\n\nTo set up billing for ' +
        '{{address_line1}}, add your card here:\n\n{{card_url}}\n\n' +
        'The card form belongs to our payment provider — your card details ' +
        'never reach us.\n\n— {{branch_name}}',
    },
    {
      code: 'card_setup_request',
      channel: 'sms',
      branch_id: null,
      subject: null,
      body:
        '{{branch_name}}: add your card for {{address_line1}} here — {{card_url}}',
    },
    {
      // The online equivalent of handing someone the phone at their door.
      code: 'signing_request',
      channel: 'email',
      branch_id: null,
      subject: 'Your snow clearing agreement for {{address_line1}}',
      body:
        'Hi {{customer_first_name}},\n\nYour agreement for {{address_line1}} is ' +
        'ready to sign:\n\n{{signing_url}}\n\nThe page shows the full terms and ' +
        'what you will be charged, and takes your signature and card in one go. ' +
        'The link is yours alone — please do not forward it.\n\n— {{branch_name}}',
    },
    {
      code: 'payment_failed_internal',
      channel: 'email',
      branch_id: null,
      subject: '[{{branch_name}}] Payment failed for {{customer_name}}',
      body:
        '{{method}} payment of ${{amount}} for {{address_line1}} failed: ' +
        '{{failure_reason}}.\n\nCustomer: {{customer_name}}\n' +
        'Email: {{customer_email}}\nPhone: {{customer_phone}}',
    },
];

export interface ConfigInstalled {
  document_requirements: number;
  checklist_requirements: number;
  message_templates: number;
}

/**
 * Installs the configuration, leaving anything already there untouched.
 *
 * `ignore` rather than `merge` on purpose: an upgrade should add the rows a
 * new feature needs, not quietly undo the wording a branch manager chose.
 */
export async function installAppConfig(knex: Knex): Promise<ConfigInstalled> {
  const docs = await knex('document_requirements')
    .insert(DOCUMENT_REQUIREMENTS)
    .onConflict('code')
    .ignore()
    .returning('code');

  const checklist = await knex('checklist_requirements')
    .insert(CHECKLIST_REQUIREMENTS)
    .onConflict('code')
    .ignore()
    .returning('code');

  // Keyed on the partial unique index over the global rows: one template per
  // code and channel where no branch has overridden it.
  const templates = await knex('message_templates')
    .insert(MESSAGE_TEMPLATES)
    .onConflict(knex.raw('(code, channel) where branch_id is null'))
    .ignore()
    .returning('code');

  return {
    document_requirements: docs.length,
    checklist_requirements: checklist.length,
    message_templates: templates.length,
  };
}
