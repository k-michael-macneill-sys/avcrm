/**
 * Row shapes as they come back from Postgres. These mirror the migrations;
 * update both together.
 *
 * Enumerated columns are text plus a CHECK constraint rather than Postgres
 * enum types, so adding a value later is a constraint swap instead of an
 * ALTER TYPE. The const tuples below are the single source of truth for both
 * the TypeScript unions and the Zod schemas in the routes.
 */

export const USER_ROLES = ['corporate', 'operator'] as const;
export type UserRole = (typeof USER_ROLES)[number];

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
  // Internal copies. A branch manager reading "Hi Harold, your driveway is
  // clear" is not a notification, so the office wording is its own template
  // rather than the customer's text sent to a second address.
  'service_complete_internal',
  'document_expiring_internal',
  'operator_suspended_internal',
  'low_rating_internal',
] as const;
export type TemplateCode = (typeof TEMPLATE_CODES)[number];

export const REVIEW_ROUTES = ['google_review', 'internal_feedback'] as const;
export type ReviewRoute = (typeof REVIEW_ROUTES)[number];

export interface Branch {
  id: string;
  name: string;
  province: string;
  timezone: string;
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
  season_start: string;
  season_end: string;
  status: QuoteStatus;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
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
  signature_image_url: string;
  signed_at: Date;
  signed_ip: string | null;
  signed_lat: string | null;
  signed_lng: string | null;
  terms_version: string;
  /** A processor token. Raw card data is never stored. */
  payment_method_token: string | null;
  payment_method_last4: string | null;
  payment_method_brand: string | null;
  pdf_url: string | null;
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
