/**
 * The fillable fields of the signed agreement
 * (assets/contracts/snow-removal-agreement.pdf), by the names the PDF gives
 * them. Shared by the server, which fills and signs the PDF, and the client,
 * which draws an input over each one. The order is the order the sign-up
 * screen steps through them.
 *
 * Replacing the PDF with one whose fields have the same names needs no code
 * change; a new or renamed field needs a line here. The few marked offPdf
 * are the agreement's own, with no box on the PDF.
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
  | 'date'
  | 'day';

export interface AgreementFieldSpec {
  name: string;
  label: string;
  kind: AgreementFieldKind;
  /** For a choice: the values it offers. */
  options?: readonly string[];
  /**
   * Kept with the agreement but not a field of the PDF: the term, which the
   * page and the signed copy show by rewriting the printed lines that say
   * November to March (see agreementRewrites).
   */
  offPdf?: true;
}

/**
 * How long the contract runs: the full season, November 1st to March 31st,
 * or exact dates for someone who only wants a month or two.
 */
export const TERM_TYPES = ['Seasonal', 'Exact dates'] as const;
export type TermType = (typeof TERM_TYPES)[number];

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
  { name: 'term_type', label: 'Term of service', kind: 'choice', options: TERM_TYPES, offPdf: true },
  { name: 'term_start', label: 'Service starts on', kind: 'day', offPdf: true },
  { name: 'term_end', label: 'Service ends on', kind: 'day', offPdf: true },
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

/** Exact dates, or the season. An agreement from before the choice existed is seasonal. */
export function termTypeOf(values: AgreementValues): TermType {
  return values.term_type === 'Exact dates' ? 'Exact dates' : 'Seasonal';
}

/** A real calendar day as YYYY-MM-DD, not just something shaped like one. */
export function isIsoDay(value: unknown): value is string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Whole months added to a YYYY-MM-DD day, clamped to the end of the month. */
function plusMonths(day: string, months: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

function plusDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The longest an exact-dates term can run, so a mistyped year is caught. */
export const MAX_TERM_MONTHS = 12;

/** Whether an exact-dates term ends within MAX_TERM_MONTHS of starting. */
export function termWithinLimit(start: string, end: string): boolean {
  return end <= plusMonths(start, MAX_TERM_MONTHS);
}

const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve'];

/**
 * "two (2) months" when the term is whole months (1 Dec to 31 Jan, or
 * 15 Dec to 15 Feb), otherwise the days it covers, both ends counted.
 */
export function termLength(start: string, end: string): string {
  for (let n = 1; n <= MAX_TERM_MONTHS; n += 1) {
    const next = plusMonths(start, n);
    if (end === next || end === plusDays(next, -1)) {
      return `${NUMBER_WORDS[n]} (${n}) month${n === 1 ? '' : 's'}`;
    }
  }
  const days = Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86_400_000) + 1;
  return `${days} days`;
}

/** "December 1st, 2026", the way the agreement writes its dates. */
export function termDate(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const month = new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-CA', { month: 'long', timeZone: 'UTC' });
  const suffix = d % 10 === 1 && d !== 11 ? 'st' : d % 10 === 2 && d !== 12 ? 'nd' : d % 10 === 3 && d !== 13 ? 'rd' : 'th';
  return `${month} ${d}${suffix}, ${y}`;
}

/**
 * A line of the printed agreement replaced with other words: blanked out and
 * written over, on screen and on the signed copy alike. Positions are PDF
 * points measured off the template, top-left origin; `baseline` is where the
 * text sits. A new template whose wording moves needs these re-measured.
 */
export interface AgreementRewrite {
  page: number;
  left: number;
  top: number;
  right: number;
  bottom: number;
  baseline: number;
  size: number;
  text: string;
  /** The line that names the dates, which tapping on screen edits. */
  term?: true;
}

/** Where page 1's "begins on November 1st … ends on March 31st" sentence sits. */
export const TERM_LINE = { page: 0, left: 46, top: 240.5, right: 556, bottom: 253, baseline: 249.28, size: 9 } as const;

/**
 * The printed lines that say November to March, reworded for an exact-dates
 * term. A seasonal agreement prints as it is, so this is empty for one.
 */
export function agreementRewrites(values: AgreementValues): AgreementRewrite[] {
  if (termTypeOf(values) !== 'Exact dates') return [];
  const start = isIsoDay(values.term_start) ? values.term_start : null;
  const end = isIsoDay(values.term_end) ? values.term_end : null;
  const length = start && end && end > start ? termLength(start, end) : '____';
  return [
    {
      ...TERM_LINE,
      term: true,
      text:
        `This Agreement begins on ${start ? termDate(start) : '____________'} and ends on ` +
        `${end ? termDate(end) : '____________'}, a service period of ${length}.`,
    },
    {
      page: 1,
      left: 46,
      top: 203,
      right: 560,
      bottom: 212.5,
      baseline: 210.04,
      size: 8.5,
      text: 'This Agreement begins and ends on the dates stated on page 1, unless terminated earlier by either party in',
    },
    {
      page: 1,
      left: 46,
      top: 326,
      right: 560,
      bottom: 335.5,
      baseline: 333.24,
      size: 8.5,
      text: 'The Customer may cancel before the service term begins with no termination fee. If the Customer chooses to',
    },
  ];
}
