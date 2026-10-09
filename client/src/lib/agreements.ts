import type {
  AddonService,
  BillingPlan,
  ContractTag,
  ContractType,
  Customer,
  CustomerPhone,
  LookupRow,
  Property,
  ServiceRoute,
  TaxCode,
} from '../../../src/types/models';
import type { NoteKind, PhoneType } from '../../../src/types/serviceAgreement';

/** Shapes the service agreement and customer summary endpoints return. */

export interface Lookups {
  contract_types: ContractType[];
  billing_plans: BillingPlan[];
  scope_items: LookupRow[];
  addon_services: AddonService[];
  contract_tags: ContractTag[];
  tax_codes: TaxCode[];
  service_routes: ServiceRoute[];
}

export interface ContractRow {
  contract_id: string | null;
  quote_id: string;
  agreement: string;
  status: string;
  signup_date: string;
  property_id: string;
  address_line1: string;
  pdf_url: string | null;
  agreement_medium: 'electronic' | 'paper' | null;
}

export interface CustomerSummary {
  customer: Customer;
  phones: CustomerPhone[];
  properties: Property[];
  service_property_id: string | null;
  contracts: ContractRow[];
  active_contract: ContractRow | null;
  balance: string;
  credit: string;
  payment_method: { brand: string | null; last4: string; provider: string | null } | null;
  sms_assigned_to: { id: string; name: string } | null;
  branch: { id: string; name: string; province: string };
}

export interface AgreementFormValues {
  property_id: string;
  contract_type_id: string;
  billing_plan_id: string;
  package: 'basic' | 'premium';
  trigger_cm: number;
  season_start: string;
  season_end: string;
  assigned_operator_id: string | null;
  service_route_id: string | null;
  scope_item_ids: string[];
  addons: { addon_service_id: string; price: string }[];
  tag_ids: string[];
  normal_price: string;
  discount: string;
  referral_credit: string | null;
  referred_by_customer_id: string | null;
  tax_code_id: string;
  route_code: string | null;
  driveway_car_lengths: number | null;
  driveway_width: 'single' | 'double' | 'triple' | null;
  property_notes: string | null;
  auto_renew: boolean;
}

export interface AgreementForm extends AgreementFormValues {
  quote_id: string;
  customer_id: string;
  status: string;
  contract_id: string | null;
  created_at: string;
}

export interface NoteRow {
  id: string;
  kind: NoteKind;
  body: string;
  author_name: string | null;
  created_at: string;
}

export interface SmsThreadEntry {
  id: string;
  direction: 'inbound' | 'outbound';
  body: string;
  at: string;
  status: string;
  author: string | null;
  scheduled_for: string | null;
}

export const PHONE_TYPE_LABELS: Record<PhoneType, string> = {
  mobile: 'Mobile',
  home: 'Home',
  work: 'Work',
  other: 'Other',
};

/** "Mobile – Primary", "Mobile – Alternate", "Home". */
export function phoneBadge(phone: Pick<CustomerPhone, 'phone_type' | 'is_primary'>): string {
  const type = PHONE_TYPE_LABELS[phone.phone_type];
  if (phone.is_primary) return `${type} – Primary`;
  return phone.phone_type === 'mobile' ? `${type} – Alternate` : type;
}

export function addressOf(p: Pick<Property, 'address_line1' | 'address_line2' | 'city' | 'province' | 'postal_code'>): string {
  return [p.address_line1, p.address_line2, `${p.city}, ${p.province} ${p.postal_code}`].filter(Boolean).join(', ');
}

export function mapsUrl(address: string): string {
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
}

export function streetViewUrl(p: Pick<Property, 'latitude' | 'longitude'>, address: string): string {
  if (p.latitude && p.longitude) {
    return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${p.latitude},${p.longitude}`;
  }
  return mapsUrl(address);
}
