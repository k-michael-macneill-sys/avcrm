/**
 * Row shapes as they come back from Postgres. These mirror the migrations;
 * update both together.
 *
 * Enumerated columns are text plus a CHECK constraint rather than Postgres
 * enum types, so adding a value later is a constraint swap instead of an
 * ALTER TYPE. The const tuples below are the single source of truth for both
 * the TypeScript unions and the Zod schemas in the routes.
 */

/**
 * corporate: every branch, all of the office work.
 * sales: knocks doors and signs customers up, in one branch.
 * operator: drives the route and clears driveways, in one branch.
 * branch: a branch's own shared sign-in — selling and dispatch alike, in
 *   that branch only, and none of corporate's screens.
 */
export const USER_ROLES = ['corporate', 'operator', 'sales', 'branch'] as const;
export type UserRole = (typeof USER_ROLES)[number];

/**
 * What the sign-in screen's dropdown offers: each branch's own sign-in, and
 * ADMIN for the corporate accounts. See services/branchSignIn.ts.
 */
export const SIGN_IN_CHOICES = ['Cranbrook', 'Kingston', 'Alberta', 'Regina', 'ADMIN'] as const;
export type SignInChoice = (typeof SIGN_IN_CHOICES)[number];

export const ONBOARDING_STATUSES = [
  'pending',
  'docs_submitted',
  'approved',
  'suspended',
] as const;
export type OnboardingStatus = (typeof ONBOARDING_STATUSES)[number];

export const BRANCH_STATUSES = ['active', 'inactive'] as const;
export type BranchStatus = (typeof BRANCH_STATUSES)[number];

export const DOCUMENT_STATUSES = [
  'submitted',
  'approved',
  'rejected',
  'expired',
] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export const CUSTOMER_STATUSES = ['lead', 'active', 'churned'] as const;
export type CustomerStatus = (typeof CUSTOMER_STATUSES)[number];

export const PREFERRED_CONTACTS = ['email', 'sms', 'both'] as const;
export type PreferredContact = (typeof PREFERRED_CONTACTS)[number];

export const BILLING_TYPES = ['monthly', 'seasonal_upfront'] as const;
export type BillingType = (typeof BILLING_TYPES)[number];

export const QUOTE_STATUSES = [
  'draft',
  'presented',
  'accepted',
  'declined',
  'expired',
] as const;
export type QuoteStatus = (typeof QUOTE_STATUSES)[number];

/**
 * The service agreement currently being signed. Bumped when the wording
 * changes, so every contract records which version its customer agreed to.
 */
export const CURRENT_TERMS_VERSION = '2026-09-01';

export const CONTRACT_STATUSES = ['active', 'cancelled', 'completed'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];

export const SERVICE_TYPES = [
  'snow_clearing',
  'salting',
  'ice_removal',
  'inspection',
] as const;
export type ServiceType = (typeof SERVICE_TYPES)[number];

export const WORK_ORDER_STATUSES = [
  'scheduled',
  'en_route',
  'in_progress',
  'completed',
  'skipped',
] as const;
export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

export const PHOTO_TYPES = ['before', 'after', 'issue'] as const;
export type PhotoType = (typeof PHOTO_TYPES)[number];

export const MESSAGE_CHANNELS = ['email', 'sms'] as const;
export type MessageChannel = (typeof MESSAGE_CHANNELS)[number];

export const MESSAGE_STATUSES = ['queued', 'sent', 'failed', 'bounced'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

/**
 * Template codes the application sends under. Rows in message_templates are
 * config and can be reworded per branch, but the code a caller asks for is
 * part of the code base, so it belongs here.
 */
export const TEMPLATE_CODES = [
  'service_complete',
  'en_route',
  'payment_failed',
  'review_request',
  'renewal_reminder',
  'document_expiring',
  'operator_suspended',
  'invoice_sent',
  'invoice_overdue',
  'card_setup_request',
  'signing_request',
  // Internal copies. A branch manager reading "Hi Harold, your driveway is
  // clear" is not a notification, so the office wording is its own template
  // rather than the customer's text sent to a second address.
  'service_complete_internal',
  'document_expiring_internal',
  'operator_suspended_internal',
  'low_rating_internal',
  'payment_failed_internal',
  // The cold email sequence: the confirmation sent the moment somebody opts
  // in, then the follow-ups the drip job sends on schedule. See
  // services/coldEmail.ts for the timing.
  'drip_welcome',
  'drip_followup_1',
  'drip_followup_2',
  'drip_followup_3',
  // The night-before notice the weather bot sends when snow is coming.
  'snowfall_notice',
  // The signed service agreement, emailed to the customer with the PDF attached.
  'agreement_signed',
] as const;
export type TemplateCode = (typeof TEMPLATE_CODES)[number];

export const REVIEW_ROUTES = ['google_review', 'internal_feedback'] as const;
export type ReviewRoute = (typeof REVIEW_ROUTES)[number];

export const INVOICE_STATUSES = ['draft', 'sent', 'paid', 'overdue', 'void'] as const;
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number];

export const PAYMENT_METHODS = [
  'card_on_file',
  /** Paid by the customer themselves, from the link on their invoice. */
  'online',
  'etransfer',
  'cheque',
  'cash',
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/**
 * What a file is for. The purpose decides its key prefix, which content
 * types are allowed and how big it may be — see services/storage.ts.
 */
export const UPLOAD_PURPOSES = [
  'signature',
  'service_photo',
  'operator_document',
  'contract_pdf',
  'invoice_pdf',
  'service_report_pdf',
  /** A photo or scan of a receipt, filed against a bookkeeping entry. */
  'receipt',
] as const;
export type UploadPurpose = (typeof UPLOAD_PURPOSES)[number];

export const CARD_SETUP_STATUSES = [
  'sent',
  'completed',
  'expired',
  'cancelled',
] as const;
export type CardSetupStatus = (typeof CARD_SETUP_STATUSES)[number];

export const SIGNING_REQUEST_STATUSES = [
  'sent',
  'completed',
  'expired',
  'cancelled',
] as const;
export type SigningRequestStatus = (typeof SIGNING_REQUEST_STATUSES)[number];

/** How a door went. A signed customer is drawn from their property instead. */
export const PIN_STATUSES = ['not_home', 'not_interested', 'lead'] as const;
export type PinStatus = (typeof PIN_STATUSES)[number];

/** Where a direct message came from. */
export const META_PLATFORMS = ['facebook', 'instagram'] as const;
export type MetaPlatform = (typeof META_PLATFORMS)[number];

export const META_DIRECTIONS = ['inbound', 'outbound'] as const;
export type MetaDirection = (typeof META_DIRECTIONS)[number];

/** Inbound is only ever `received`; outbound moves through the queue. */
export const META_MESSAGE_STATUSES = ['received', 'queued', 'sent', 'failed'] as const;
export type MetaMessageStatus = (typeof META_MESSAGE_STATUSES)[number];

/**
 * What a business expense was for. The labels, and which line of the CRA's
 * T2125 each one is claimed on, live in services/expenses.ts and are served
 * from GET /expenses/categories, so the form is built from the server's list.
 */
export const EXPENSE_CATEGORIES = [
  'equipment_maintenance',
  'fuel',
  'commercial_insurance',
  'vehicle_upkeep',
  'subcontractors',
  'protective_gear',
  'salt_and_supplies',
  'small_tools',
  'advertising',
  'phone_and_internet',
  'office_and_software',
  'professional_fees',
  'licences_and_permits',
  'wages',
  'rent_and_storage',
  'interest_and_bank_charges',
  'meals',
  'other',
] as const;
export type ExpenseCategory = (typeof EXPENSE_CATEGORIES)[number];

/** Where somebody said yes to hearing from us by email. */
export const OPT_IN_SOURCES = ['google_ads', 'door_to_door'] as const;
export type OptInSource = (typeof OPT_IN_SOURCES)[number];

/**
 * active: still in the sequence. completed: every step sent. unsubscribed:
 * asked to stop, and nothing more is ever sent. converted: became a customer,
 * so the selling emails stop.
 */
export const EMAIL_LEAD_STATUSES = ['active', 'completed', 'unsubscribed', 'converted'] as const;
export type EmailLeadStatus = (typeof EMAIL_LEAD_STATUSES)[number];

export const UPLOAD_STATUSES = ['pending', 'stored'] as const;
export type UploadStatus = (typeof UPLOAD_STATUSES)[number];

export const PAYMENT_STATUSES = [
  'pending',
  'succeeded',
  'failed',
  'refunded',
] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

export interface Branch {
  id: string;
  name: string;
  province: string;
  timezone: string;
  /**
   * The city a branch's customers are in, filled onto every agreement its
   * own sign-in writes. Null for a branch that covers several towns.
   */
  default_city: string | null;
  manager_user_id: string | null;
  status: BranchStatus;
  created_at: Date;
  updated_at: Date;
}

export interface User {
  id: string;
  branch_id: string | null;
  email: string;
  password_hash: string;
  first_name: string;
  last_name: string;
  phone: string | null;
  role: UserRole;
  onboarding_status: OnboardingStatus;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** A user as it is safe to return over the API. */
export type PublicUser = Omit<User, 'password_hash'>;

export interface DocumentRequirement {
  id: string;
  code: string;
  label: string;
  /** NULL means the requirement applies in every province. */
  province: string | null;
  is_required: boolean;
  expires: boolean;
  default_validity_days: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface OperatorDocument {
  id: string;
  user_id: string;
  requirement_code: string;
  file_url: string;
  file_name: string;
  mime_type: string;
  file_size: number;
  /** date columns come back as YYYY-MM-DD strings. */
  issued_on: string | null;
  expires_on: string | null;
  status: DocumentStatus;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  rejection_reason: string | null;
  last_reminder_days: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface Customer {
  id: string;
  branch_id: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  preferred_contact: PreferredContact;
  notes: string | null;
  status: CustomerStatus;
  created_by_user_id: string | null;
  /** Where the processor knows this customer, once they have been asked. */
  stripe_customer_id: string | null;
  square_customer_id: string | null;
  /** Null when bills go to the service address. */
  billing_address_line1: string | null;
  billing_address_line2: string | null;
  billing_city: string | null;
  billing_province: string | null;
  billing_postal_code: string | null;
  /** The member of staff looking after this customer's text thread. */
  sms_assigned_user_id: string | null;
  /** Asked not to be texted: nothing is sent by hand. */
  sms_opt_out: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface Property {
  id: string;
  customer_id: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  province: string;
  postal_code: string;
  /** numeric columns come back from pg as strings. */
  latitude: string | null;
  longitude: string | null;
  driveway_size_cars: number | null;
  access_notes: string | null;
  priority_flag: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PricingGuideEntry {
  id: string;
  branch_id: string;
  driveway_size_cars: number;
  billing_type: BillingType;
  /** numeric — money is a string all the way through. */
  initial_price: string;
  created_at: Date;
  updated_at: Date;
}

export interface Quote {
  id: string;
  property_id: string;
  created_by_user_id: string | null;
  billing_type: BillingType;
  initial_price: string;
  discounted_price: string;
  /**
   * What they pay every month after the first visit. Monthly contracts only —
   * seasonal is a single payment, so this is null on those.
   */
  recurring_price: string | null;
  season_start: string;
  season_end: string;
  status: QuoteStatus;
  notes: string | null;
  addon_salt: boolean;
  addon_vehicle: boolean;
  addon_stairs: boolean;
  /** Set when the quote was written on the PDF agreement; null before that. */
  agreement_fields: Record<string, string | boolean> | null;
  package: 'basic' | 'premium' | null;
  addons: string[];
  /** The service agreement form. All null on a quote from the older PDF sign-up. */
  contract_type_id: string | null;
  billing_plan_id: string | null;
  tax_code_id: string | null;
  /** Frozen when the form is saved. */
  tax_rate: string | null;
  assigned_operator_id: string | null;
  service_route_id: string | null;
  route_code: string | null;
  discount: string;
  trigger_cm: string | null;
  referral_credit: string | null;
  referred_by_customer_id: string | null;
  auto_renew: boolean;
  driveway_car_lengths: number | null;
  driveway_width: 'single' | 'double' | 'triple' | null;
  property_notes: string | null;
  early_termination_fee: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A row in one of the lookup tables the contract form is built from. */
export interface LookupRow {
  id: string;
  code: string;
  label: string;
  active: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface ContractType extends LookupRow {
  seasons: number;
  agreement_medium: 'electronic' | 'paper';
  is_switch_over: boolean;
}

export interface BillingPlan extends LookupRow {
  kind: 'seasonal_installments' | 'seasonal_yia' | 'monthly_recurring' | 'monthly_one_time';
  installments_per_season: number;
  early_termination_fee: string;
}

export interface AddonService extends LookupRow {
  default_price: string | null;
}

export interface ContractTag extends LookupRow {
  kind: 'yia' | 'route_code' | 'referral' | null;
}

export interface TaxCode extends LookupRow {
  rate: string;
  province: string | null;
  is_default: boolean;
}

export interface ServiceRoute extends LookupRow {
  branch_id: string | null;
}

export interface CustomerPhone {
  id: string;
  customer_id: string;
  number: string;
  phone_type: 'mobile' | 'home' | 'work' | 'other';
  is_primary: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface CustomerNote {
  id: string;
  customer_id: string;
  kind: 'account' | 'operator';
  body: string;
  author_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** Positive is credit earned; negative is credit spent on an invoice. */
export interface CustomerCredit {
  id: string;
  customer_id: string;
  kind: 'referral' | 'applied' | 'adjustment';
  amount: string;
  description: string | null;
  source_invoice_id: string | null;
  invoice_id: string | null;
  created_by_user_id: string | null;
  created_at: Date;
}

/** A text a customer sent us. */
export interface SmsInbound {
  id: string;
  customer_id: string | null;
  from_number: string;
  body: string;
  provider_message_id: string | null;
  received_at: Date;
  created_at: Date;
}

export interface ChecklistRequirement {
  id: string;
  code: string;
  label: string;
  is_required: boolean;
  sort_order: number;
  created_at: Date;
  updated_at: Date;
}

export interface Contract {
  id: string;
  quote_id: string;
  customer_id: string;
  property_id: string;
  /** Null only on a paper agreement, which arrives as a scan. */
  signature_image_url: string | null;
  signed_at: Date;
  signed_ip: string | null;
  signed_lat: string | null;
  signed_lng: string | null;
  terms_version: string;
  /** A processor token. Raw card data is never stored. */
  payment_method_token: string | null;
  /** Which processor the token belongs to; a card saved at one cannot be charged at another. */
  payment_method_provider: string | null;
  /** The customer's signed consent to automatic charges, good for one year. */
  autopay_signature_url: string | null;
  autopay_signer_name: string | null;
  autopay_terms: string | null;
  autopay_signed_at: Date | null;
  autopay_signed_ip: string | null;
  autopay_expires_on: string | null;
  payment_method_last4: string | null;
  payment_method_brand: string | null;
  pdf_url: string | null;
  provider_signature_url: string | null;
  agreement_medium: 'electronic' | 'paper';
  signer_name: string | null;
  /** Which signature boxes were signed, and when. */
  signature_boxes: Record<string, string> | null;
  status: ContractStatus;
  created_at: Date;
  updated_at: Date;
}

/**
 * A contract as it is safe to return over the API. The processor token can be
 * used to charge the customer, so it stays server-side; last4 and brand are
 * what a screen needs. Same idea as PublicUser and password_hash.
 */
export type PublicContract = Omit<Contract, 'payment_method_token'>;

export interface ContractChecklistItem {
  id: string;
  contract_id: string;
  item_code: string;
  checked: boolean;
  checked_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Append-only: there is no updated_at, and a trigger blocks writes to it. */
export interface AuditLogEntry {
  id: string;
  user_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  before_json: unknown | null;
  after_json: unknown | null;
  ip_address: string | null;
  created_at: Date;
}

export interface WorkOrder {
  id: string;
  contract_id: string;
  property_id: string;
  branch_id: string;
  assigned_user_id: string | null;
  scheduled_for: Date;
  service_type: ServiceType;
  status: WorkOrderStatus;
  skip_reason: string | null;
  started_at: Date | null;
  completed_at: Date | null;
  operator_notes: string | null;
  /** Rendered on first request, not on completion. */
  report_pdf_url: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ServicePhoto {
  id: string;
  work_order_id: string;
  photo_type: PhotoType;
  file_url: string;
  /** From the image EXIF, not the upload time. */
  taken_at: Date;
  /** numeric columns come back from pg as strings. */
  latitude: string | null;
  longitude: string | null;
  uploaded_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface MessageTemplate {
  id: string;
  /** NULL is the global default; a branch row overrides it. */
  branch_id: string | null;
  code: string;
  channel: MessageChannel;
  subject: string | null;
  body: string;
  created_at: Date;
  updated_at: Date;
}

export interface MessageLogEntry {
  id: string;
  branch_id: string | null;
  customer_id: string | null;
  work_order_id: string | null;
  email_lead_id: string | null;
  template_code: string;
  channel: MessageChannel;
  recipient: string;
  /** Rendered at enqueue time, so a later template edit cannot rewrite it. */
  subject: string | null;
  body: string;
  status: MessageStatus;
  provider_message_id: string | null;
  sent_at: Date | null;
  error: string | null;
  attempts: number;
  last_attempt_at: Date | null;
  /** Not sent before this time. */
  send_after: Date | null;
  /** Who typed it, for a message written by hand. */
  sent_by_user_id: string | null;
  attachment_key: string | null;
  attachment_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface ReviewRequest {
  id: string;
  customer_id: string;
  work_order_id: string;
  branch_id: string;
  sent_at: Date;
  channel: MessageChannel;
  rating_response: number | null;
  routed_to: ReviewRoute | null;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Invoice {
  id: string;
  contract_id: string;
  customer_id: string;
  branch_id: string;
  /** date columns come back as YYYY-MM-DD strings. */
  billing_period_start: string;
  billing_period_end: string;
  /** numeric — money is a string all the way through. */
  amount_due: string;
  /** Derived from the payments on this invoice, never incremented in place. */
  amount_paid: string;
  status: InvoiceStatus;
  due_date: string;
  sent_at: Date | null;
  paid_at: Date | null;
  pdf_url: string | null;
  /** The capability in the customer's pay link. Null until one is sent. */
  portal_token: string | null;
  /** Before tax and credit. Null on invoices raised before tax was charged. */
  subtotal: string | null;
  tax_amount: string | null;
  credit_applied: string;
  service_months: number | null;
  created_at: Date;
  updated_at: Date;
}

export interface Payment {
  id: string;
  invoice_id: string;
  amount: string;
  method: PaymentMethod;
  provider_transaction_id: string | null;
  /** The processor that moved the money, when one did. */
  provider: string | null;
  status: PaymentStatus;
  failure_reason: string | null;
  processed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Upload {
  id: string;
  key: string;
  purpose: UploadPurpose;
  content_type: string;
  file_name: string | null;
  byte_size: number | null;
  status: UploadStatus;
  uploaded_by_user_id: string | null;
  branch_id: string | null;
  stored_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CardSetup {
  id: string;
  customer_id: string;
  contract_id: string | null;
  branch_id: string;
  provider_session_id: string;
  url: string;
  status: CardSetupStatus;
  payment_method_last4: string | null;
  payment_method_brand: string | null;
  requested_by_user_id: string | null;
  expires_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * An invitation to sign a quote from somewhere other than the rep's phone.
 * The link carries a signed token with its own expiry; this row is what
 * makes it single-use, and the record of what came of it.
 */
export interface SigningRequest {
  id: string;
  quote_id: string;
  customer_id: string;
  branch_id: string;
  contract_id: string | null;
  sent_to: string;
  status: SigningRequestStatus;
  requested_by_user_id: string | null;
  expires_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * An integration an administrator configures at runtime — which SMS provider
 * this company uses, and the credentials for it. Secrets are encrypted into
 * `secret_ciphertext` and never appear in an API response.
 */
export interface IntegrationSetting {
  id: string;
  key: string;
  provider: string;
  is_enabled: boolean;
  settings: Record<string, string>;
  secret_ciphertext: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** A house a rep has knocked on, and how it went. */
export interface LeadPin {
  id: string;
  branch_id: string;
  latitude: string;
  longitude: string;
  address_line1: string | null;
  city: string | null;
  province: string | null;
  postal_code: string | null;
  status: PinStatus;
  notes: string | null;
  customer_id: string | null;
  knock_count: number;
  last_knocked_at: Date;
  created_by_user_id: string | null;
  updated_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/** One person talking to the Page, on one platform. */
export interface MetaConversation {
  id: string;
  branch_id: string | null;
  customer_id: string | null;
  platform: MetaPlatform;
  external_user_id: string;
  last_inbound_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** A direct message, either way. Outbound rows double as the send queue. */
export interface MetaMessage {
  id: string;
  conversation_id: string;
  direction: MetaDirection;
  message_text: string;
  external_message_id: string | null;
  status: MetaMessageStatus;
  sent_by_user_id: string | null;
  sent_at: Date | null;
  error: string | null;
  attempts: number;
  last_attempt_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface Expense {
  id: string;
  /** Null for a company-wide cost that belongs to no one branch. */
  branch_id: string | null;
  category: ExpenseCategory;
  /** What it was, when the category is `other`, or any note worth keeping. */
  description: string | null;
  vendor: string | null;
  /** numeric — money is a string all the way through. */
  amount: string;
  /** The day on the receipt. */
  spent_on: string;
  receipt_key: string | null;
  receipt_file_name: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface EmailLead {
  id: string;
  branch_id: string;
  first_name: string;
  last_name: string | null;
  email: string;
  phone: string | null;
  source: OptInSource;
  status: EmailLeadStatus;
  /** How many steps of the sequence have been queued. */
  steps_sent: number;
  next_send_at: Date | null;
  opted_in_at: Date;
  /** The words they agreed to, kept as the record of consent CASL asks for. */
  consent_text: string;
  unsubscribe_token: string;
  unsubscribed_at: Date | null;
  campaign: string | null;
  gclid: string | null;
  lead_pin_id: string | null;
  customer_id: string | null;
  created_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface WeatherAlertRun {
  id: string;
  branch_id: string;
  /** The morning the crews go out, in the branch's own timezone. */
  service_date: string;
  /** A postal region: the first three characters of a postal code, or a ZIP. */
  region: string;
  latitude: string;
  longitude: string;
  snowfall_cm: string;
  threshold_cm: string;
  triggered: boolean;
  /** Customers queued a notice because of this region. */
  notified: number;
  created_at: Date;
  updated_at: Date;
}
