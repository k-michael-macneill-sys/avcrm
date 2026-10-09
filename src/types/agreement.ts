/**
 * The fillable fields of the signed agreement
 * (assets/contracts/snow-removal-agreement.pdf), by the names the PDF gives
 * them. Shared by the server, which fills and signs the PDF, and the client,
 * which draws an input over each one. The order is the order the sign-up
 * screen steps through them.
 *
 * Replacing the PDF with one whose fields have the same names needs no code
 * change; a new or renamed field needs a line here.
 */

export type AgreementFieldKind =
  | 'text'
  | 'email'
  | 'tel'
  | 'year'
  | 'money'
  | 'notes'
  | 'check'
  | 'choice'
  | 'signature'
  | 'date';

export interface AgreementFieldSpec {
  name: string;
  label: string;
  kind: AgreementFieldKind;
  /** For the one radio group: the export values it offers. */
  options?: readonly string[];
}

export const AGREEMENT_FIELDS: readonly AgreementFieldSpec[] = [
  { name: 'customer_name', label: 'Full name', kind: 'text' },
  { name: 'customer_street', label: 'Street address', kind: 'text' },
  { name: 'customer_city', label: 'City / town', kind: 'text' },
  { name: 'customer_province', label: 'Province', kind: 'text' },
  { name: 'customer_postal', label: 'Postal code', kind: 'text' },
  { name: 'customer_phone', label: 'Phone', kind: 'tel' },
  { name: 'phone_type_cell', label: 'Phone is a cell', kind: 'check' },
  { name: 'phone_type_home', label: 'Phone is a home line', kind: 'check' },
  { name: 'customer_email', label: 'Email', kind: 'email' },
  { name: 'start_year', label: 'Starts November 1st, 20__', kind: 'year' },
  { name: 'end_year', label: 'Ends March 31st, 20__', kind: 'year' },
  { name: 'package', label: 'Package', kind: 'choice', options: ['Basic', 'Premium'] },
  { name: 'price_basic', label: 'Basic package price, per month', kind: 'money' },
  { name: 'price_premium', label: 'Premium package price, per month', kind: 'money' },
  { name: 'addon_de_ice', label: 'Add-on: De-ice', kind: 'check' },
  { name: 'addon_additional_areas', label: 'Add-on: Additional areas', kind: 'check' },
  { name: 'addon_premium_time', label: 'Add-on: Premium time', kind: 'check' },
  { name: 'addon_deck', label: 'Add-on: Deck', kind: 'check' },
  { name: 'addon_vehicle_clearing', label: 'Add-on: Vehicle clearing', kind: 'check' },
  { name: 'addon_other_request', label: 'Add-on: Other request', kind: 'check' },
  { name: 'customer_notes', label: 'Customer instructions / notes', kind: 'notes' },
  { name: 'customer_signature', label: 'Customer signature', kind: 'signature' },
  { name: 'customer_sign_date', label: 'Customer signature date', kind: 'date' },
  { name: 'provider_signature', label: 'Service provider signature', kind: 'signature' },
  { name: 'provider_sign_date', label: 'Service provider signature date', kind: 'date' },
] as const;

/**
 * How long the contract runs, chosen with two buttons above the agreement:
 * the full season (November 1st to March 31st, the years on the PDF) or a
 * single month (`term_month`, YYYY-MM). Not fields of the PDF itself; a
 * one-month term is printed into the notes box of the signed copy.
 */
export const AGREEMENT_TERMS = ['Full season', 'One month'] as const;
export type AgreementTerm = (typeof AGREEMENT_TERMS)[number];
export const ONE_MONTH: AgreementTerm = 'One month';

/** "December 2026" for "2026-12". */
export function termMonthLabel(month: string): string {
  const [y, m] = month.split('-').map(Number);
  if (!y || !m) return month;
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-CA', { month: 'long', year: 'numeric', timeZone: 'UTC' });
}

/** Every fillable value: text as a string, a checkbox as a boolean. */
export type AgreementValues = Record<string, string | boolean>;

export const AGREEMENT_ADDONS = AGREEMENT_FIELDS.filter((f) => f.name.startsWith('addon_')).map((f) => ({
  code: f.name.slice('addon_'.length),
  label: f.label.replace(/^Add-on: /, ''),
}));

/** The fields someone types into, as opposed to signs or that fill themselves. */
export const EDITABLE_AGREEMENT_FIELDS = AGREEMENT_FIELDS.filter(
  (f) => f.kind !== 'signature' && f.kind !== 'date',
);

/** "29/Sep/2026", the DD/MMM/YYYY the agreement's date lines ask for. */
export function agreementDate(when: Date): string {
  const month = when.toLocaleString('en-CA', { month: 'short', timeZone: 'America/Toronto' });
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    day: '2-digit',
    year: 'numeric',
  }).formatToParts(when);
  const day = parts.find((p) => p.type === 'day')?.value ?? '';
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  return `${day}/${month.replace('.', '')}/${year}`;
}

/**
 * The season a sign-up today is for, as the agreement's two-digit years:
 * from April on it is the coming winter, before that the one under way.
 */
export function defaultAgreementYears(today: Date = new Date()): { start_year: string; end_year: string } {
  const start = today.getMonth() >= 3 ? today.getFullYear() : today.getFullYear() - 1;
  return { start_year: String(start % 100).padStart(2, '0'), end_year: String((start + 1) % 100).padStart(2, '0') };
}
