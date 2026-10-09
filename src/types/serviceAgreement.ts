/**
 * The service agreement's arithmetic and wording, shared by the server (which
 * bills from it and prints the signed PDF) and the client (which shows the
 * totals live on the contract form and draws the agreement for signing). One
 * module, so the number on the screen, the number on the agreement and the
 * number on the invoice cannot disagree.
 *
 * Money is whole cents throughout. Nothing here touches a float that ends up
 * as money: tax is computed in integer arithmetic from a rate in hundredths of
 * a basis point, and rounded half-up once per payment.
 *
 * Pure: no database, no Node, no DOM.
 */

/** What a billing plan does. The label on the plan is the office's to word. */
export const PLAN_KINDS = ['seasonal_installments', 'seasonal_yia', 'monthly_recurring', 'monthly_one_time'] as const;
export type PlanKind = (typeof PLAN_KINDS)[number];

/** Behaviour a tag switches on. */
export const TAG_KINDS = ['yia', 'route_code', 'referral'] as const;
export type TagKind = (typeof TAG_KINDS)[number];

export const PHONE_TYPES = ['mobile', 'home', 'work', 'other'] as const;
export type PhoneType = (typeof PHONE_TYPES)[number];

export const DRIVEWAY_WIDTHS = ['single', 'double', 'triple'] as const;
export type DrivewayWidth = (typeof DRIVEWAY_WIDTHS)[number];

export const NOTE_KINDS = ['account', 'operator'] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];

export const AGREEMENT_MEDIUMS = ['electronic', 'paper'] as const;
export type AgreementMedium = (typeof AGREEMENT_MEDIUMS)[number];

/** The boxes on the agreement a customer signs, in the order they appear. */
export const SIGNATURE_BOXES = ['commitment', 'service_commitment', 'card_authorization'] as const;
export type SignatureBox = (typeof SIGNATURE_BOXES)[number];

export const SIGNATURE_BOX_LABELS: Record<SignatureBox, string> = {
  commitment: 'Customer signature — commitment & cancellation',
  service_commitment: 'Customer signature — service commitment and payment',
  card_authorization: 'Cardholder signature — payment authorization',
};

/** The default season: November 1st to March 31st. */
export const SEASON_START_MONTH_DAY = '11-01';
export const SEASON_END_MONTH_DAY = '03-31';
export const DEFAULT_TRIGGER_CM = 3;
export const DEFAULT_REFERRAL_CREDIT_CENTS = 1000;

// ── Money ────────────────────────────────────────────────────────────────

/** "123.45", "$1,234.5", 12.3 → cents. Null for anything that is not money. */
export function toCents(value: string | number | null | undefined): number | null {
  if (value === null || value === undefined) return null;
  const text = typeof value === 'number' ? value.toFixed(2) : value.replace(/[$,\s]/g, '');
  if (!/^-?\d+(\.\d{0,2})?$/.test(text)) return null;
  const negative = text.startsWith('-');
  const [whole, fraction = ''] = text.replace('-', '').split('.') as [string, string?];
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

/** Cents → "1234.50", the form Postgres numeric columns take. */
export function centsToDecimal(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** Cents → "$1,234.50". */
export function formatMoney(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  const whole = Math.floor(abs / 100).toLocaleString('en-CA');
  return `${sign}$${whole}.${String(abs % 100).padStart(2, '0')}`;
}

/** A rate like "0.1300" or 0.13 → hundredths of a basis point (1300). */
export function rateUnits(rate: string | number): number {
  return Math.round(Number(rate) * 10000);
}

/** Tax on one payment, rounded half-up to the cent. */
export function taxOn(cents: number, rate: string | number): number {
  return Math.floor((cents * rateUnits(rate) + 5000) / 10000);
}

/** "13%" or "14.975%" from a rate. */
export function formatRate(rate: string | number): string {
  const percent = rateUnits(rate) / 100;
  return `${Number.isInteger(percent) ? percent : percent.toFixed(3).replace(/0+$/, '')}%`;
}

// ── Dates (YYYY-MM-DD strings, no time zones) ───────────────────────────

export function addMonths(isoDate: string, months: number): string {
  const [year, month, day] = isoDate.split('-').map(Number) as [number, number, number];
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(day, lastDay));
  return target.toISOString().slice(0, 10);
}

export function addYears(isoDate: string, years: number): string {
  return addMonths(isoDate, years * 12);
}

export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** The 1st of the month after this date. */
export function firstOfNextMonth(isoDate: string): string {
  return addMonths(`${isoDate.slice(0, 7)}-01`, 1);
}

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function monthLabel(isoDate: string): string {
  return MONTHS[Number(isoDate.slice(5, 7)) - 1] ?? '';
}

/** "09 Of Oct 2026", the way the agreement prints a signing date. */
export function agreementDateLabel(isoDate: string): string {
  const [year, month, day] = isoDate.split('-') as [string, string, string];
  return `${day} Of ${MONTH_NAMES[Number(month) - 1]} ${year}`;
}

/** "Nov 1, 2026". */
export function longDate(isoDate: string): string {
  const [year, month, day] = isoDate.split('-') as [string, string, string];
  return `${MONTH_NAMES[Number(month) - 1]} ${Number(day)}, ${year}`;
}

/**
 * The season a sign-up on this day is for: the coming winter from April on,
 * the one under way before that.
 */
export function defaultSeason(today: string): { season_start: string; season_end: string } {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const startYear = month >= 4 ? year : year - 1;
  return {
    season_start: `${startYear}-${SEASON_START_MONTH_DAY}`,
    season_end: `${startYear + 1}-${SEASON_END_MONTH_DAY}`,
  };
}

// ── Pricing ─────────────────────────────────────────────────────────────

export interface PricingInput {
  plan_kind: PlanKind;
  /** How many payments a season is split into (5: November to March). */
  installments_per_season: number;
  /** The Initial Service Commitment, in seasons. */
  seasons: number;
  /**
   * The list price, in cents: per season for the seasonal plans, per month
   * for the monthly ones. Add-ons are priced in the same unit.
   */
  normal_price: number;
  discount: number;
  addons: { label: string; price: number }[];
  tax_rate: string | number;
}

export interface Pricing {
  plan_kind: PlanKind;
  /** The rate every payment is taxed at, as given. */
  tax_rate: string | number;
  /** "season" or "month": what normal_price and net are per. */
  unit: 'season' | 'month';
  normal_price: number;
  addons_total: number;
  discount: number;
  /** normal_price + add-ons − discount, per unit. */
  net: number;
  first_payment: number;
  first_payment_tax: number;
  first_payment_total: number;
  /** Each payment after the first. Zero when there is only one payment. */
  recurring_payment: number;
  recurring_tax: number;
  recurring_total: number;
  /** Payments in the Initial Service Commitment; null for month-to-month. */
  payments_count: number | null;
  /** Over the whole commitment (one month, for month-to-month). */
  commitment_subtotal: number;
  commitment_tax: number;
  commitment_total: number;
}

export class PricingError extends Error {}

/** Everything the form, the agreement and the billing run need to know about the money. */
export function computePricing(input: PricingInput): Pricing {
  const addonsTotal = input.addons.reduce((sum, a) => sum + a.price, 0);
  const gross = input.normal_price + addonsTotal;
  if (input.normal_price < 0 || input.discount < 0 || input.addons.some((a) => a.price < 0)) {
    throw new PricingError('Prices and the discount cannot be negative');
  }
  if (input.discount > gross) {
    throw new PricingError('The discount cannot be more than the price');
  }
  const seasons = Math.max(1, Math.floor(input.seasons));
  const n = Math.max(1, Math.floor(input.installments_per_season));
  const net = gross - input.discount;
  const tax = (cents: number): number => taxOn(cents, input.tax_rate);

  let first: number;
  let recurring: number;
  let count: number | null;
  let subtotal: number;
  let totalTax: number;

  switch (input.plan_kind) {
    case 'seasonal_installments': {
      // The season price over five payments. Cents that do not divide evenly
      // ride on the first payment, so the five always add up to the season.
      recurring = Math.floor(net / n);
      first = net - recurring * (n - 1);
      count = n * seasons;
      subtotal = net * seasons;
      totalTax = seasons * (tax(first) + (n - 1) * tax(recurring));
      break;
    }
    case 'seasonal_yia': {
      // Year in advance: every season of the commitment, paid up front.
      first = net * seasons;
      recurring = 0;
      count = 1;
      subtotal = first;
      totalTax = tax(first);
      break;
    }
    case 'monthly_recurring': {
      first = net;
      recurring = net;
      count = null;
      subtotal = net;
      totalTax = tax(net);
      break;
    }
    case 'monthly_one_time': {
      first = net;
      recurring = 0;
      count = 1;
      subtotal = net;
      totalTax = tax(net);
      break;
    }
  }

  return {
    plan_kind: input.plan_kind,
    tax_rate: input.tax_rate,
    unit: input.plan_kind.startsWith('seasonal') ? 'season' : 'month',
    normal_price: input.normal_price,
    addons_total: addonsTotal,
    discount: input.discount,
    net,
    first_payment: first,
    first_payment_tax: tax(first),
    first_payment_total: first + tax(first),
    recurring_payment: recurring,
    recurring_tax: tax(recurring),
    recurring_total: recurring + tax(recurring),
    payments_count: count,
    commitment_subtotal: subtotal,
    commitment_tax: totalTax,
    commitment_total: subtotal + totalTax,
  };
}

// ── Payment schedule ────────────────────────────────────────────────────

export interface ScheduleTerms {
  plan_kind: PlanKind;
  installments_per_season: number;
  seasons: number;
  season_start: string;
  season_end: string;
  /** The day the agreement is signed (or today, for a preview). */
  signed_on: string;
  auto_renew: boolean;
}

export interface ScheduleEntry {
  /** When the payment falls due; also the start of the period it pays for. */
  due_on: string;
  /** The end of the period it pays for, always after due_on. */
  period_end: string;
  /** "NOV", or "PAID IN FULL". */
  label: string;
  /** 0 for the first season of the agreement. */
  season: number;
  /** Past the Initial Service Commitment: a renewal. */
  renewal: boolean;
  /** Months of service the payment covers: what a "$10 a month" referral credit is multiplied by. */
  months: number;
  amount: number;
  tax: number;
  total: number;
}

/** Guards the loops below against a corrupt date pair. */
const MAX_SEASONS = 50;

/**
 * The payments an agreement calls for.
 *
 * Without `through`, only the Initial Service Commitment — what the agreement
 * prints. With it, every payment due on or before that date, renewals
 * included where the agreement renews — what the billing run raises.
 *
 * The first payment falls on the season's first day, or on the day of signing
 * when that is later: a customer who signs up before the season pays on
 * November 1st, one who signs in December pays that day. Each payment after
 * that is on the 1st of the following month.
 */
export function paymentSchedule(terms: ScheduleTerms, pricing: Pricing, through?: string): ScheduleEntry[] {
  const entries: ScheduleEntry[] = [];
  const n = Math.max(1, Math.floor(terms.installments_per_season));
  const commitment = Math.max(1, Math.floor(terms.seasons));
  const renews = terms.auto_renew && terms.plan_kind !== 'monthly_one_time';
  const lastSeason = through === undefined || !renews ? commitment - 1 : MAX_SEASONS;

  const make = (
    due_on: string,
    period_end: string,
    label: string,
    season: number,
    amount: number,
    months = 1,
  ): ScheduleEntry => {
    const tax = taxOn(amount, pricing.tax_rate);
    return {
      due_on,
      period_end: period_end > due_on ? period_end : addDays(due_on, 1),
      label,
      season,
      renewal: season >= commitment,
      months,
      amount,
      tax,
      total: amount + tax,
    };
  };

  for (let season = 0; season <= lastSeason; season += 1) {
    const start = addYears(terms.season_start, season);
    const end = addYears(terms.season_end, season);
    if (through !== undefined && start > through && season > 0) break;
    const first = season === 0 && terms.signed_on > start ? terms.signed_on : start;

    switch (terms.plan_kind) {
      case 'seasonal_installments': {
        let due = first;
        for (let i = 0; i < n; i += 1) {
          const next = firstOfNextMonth(due);
          entries.push(
            make(due, next, monthLabel(due), season, i === 0 ? pricing.first_payment : pricing.recurring_payment),
          );
          due = next;
        }
        // A commitment of more than one season repeats the same five payments.
        break;
      }
      case 'seasonal_yia': {
        if (season === 0) {
          // The whole commitment, up front, at signing.
          const coveredTo = addYears(terms.season_end, commitment - 1);
          entries.push(
            make(
              terms.signed_on < first ? terms.signed_on : first,
              coveredTo,
              'PAID IN FULL',
              0,
              pricing.first_payment,
              n * commitment,
            ),
          );
        } else if (season >= commitment) {
          entries.push(make(start, end, 'PAID IN FULL', season, pricing.net, n));
        }
        break;
      }
      case 'monthly_recurring': {
        for (let due = first; due <= end; due = firstOfNextMonth(due)) {
          entries.push(make(due, firstOfNextMonth(due), monthLabel(due), season, pricing.net));
        }
        break;
      }
      case 'monthly_one_time': {
        if (season === 0) entries.push(make(first, addMonths(first, 1), monthLabel(first), 0, pricing.first_payment));
        break;
      }
    }
  }

  return through === undefined ? entries : entries.filter((e) => e.due_on <= through);
}

// ── Wording ─────────────────────────────────────────────────────────────

export const COMPANY = {
  name: 'Drift Property Services',
  legal: 'Drift Property Services, an Ontario general partnership',
};

export const BILLING_SCHEDULE_SMALL_PRINT =
  'Under the terms of this service agreement, scheduled services may not be forgone, skipped, or delayed within the ' +
  'Initial Service Commitment except as provided under the satisfaction guarantee.';

export const COOLING_OFF_BANNER =
  'YOU, THE BUYER, MAY CANCEL THIS AGREEMENT AT ANY TIME PRIOR TO MIDNIGHT OF THE TENTH DAY AFTER THE DATE OF THIS TRANSACTION.';

export interface AgreementWordingInput {
  plan_kind: PlanKind;
  seasons: number;
  season_start: string;
  season_end: string;
  trigger_cm: number;
  early_termination_fee_cents: number;
  referral_credit_cents: number;
  auto_renew: boolean;
}

/** The paragraphs of the agreement that depend on what was sold. */
export function agreementWording(input: AgreementWordingInput): {
  agreement_period: string;
  commitment: string;
  guarantee: string;
  notifications: string;
  continuation: string;
} {
  const seasonsWord = input.seasons === 1 ? 'one (1) season' : `${input.seasons === 2 ? 'two (2)' : input.seasons} seasons`;
  const span = `${longDate(input.season_start).replace(/, \d{4}$/, '')} to ${longDate(input.season_end).replace(/, \d{4}$/, '')}`;
  const monthToMonth = input.plan_kind === 'monthly_recurring';
  const oneTime = input.plan_kind === 'monthly_one_time';

  const agreement_period = monthToMonth
    ? `This is an ongoing month-to-month seasonal agreement that renews automatically each month of the season (${span}) ` +
      `until either party cancels it. Services are performed whenever snowfall at the service location reaches ` +
      `${input.trigger_cm} cm or more during the season dates. The Customer agrees to pay the first payment and each ` +
      `monthly payment as scheduled, and authorizes ${COMPANY.name} to charge the payment method on file according to ` +
      `the payment schedule. The Customer authorizes ${COMPANY.name} to access the property to perform snow clearing ` +
      `and to apply de-icing products to the selected areas.`
    : oneTime
      ? `This agreement covers one (1) month of service beginning on the first payment date. Services are performed ` +
        `whenever snowfall at the service location reaches ${input.trigger_cm} cm or more during that month. The ` +
        `Customer agrees to pay the payment shown and authorizes ${COMPANY.name} to charge the payment method on file. ` +
        `The Customer authorizes ${COMPANY.name} to access the property to perform snow clearing and to apply de-icing ` +
        `products to the selected areas.`
      : `This is an ongoing seasonal agreement with an Initial Service Commitment of ${seasonsWord}. Services are ` +
        `performed whenever snowfall at the service location reaches ${input.trigger_cm} cm or more during the season ` +
        `dates (${span}). The Customer agrees to pay the first payment and ongoing payments as scheduled, and ` +
        `authorizes ${COMPANY.name} to charge the payment method on file according to the payment schedule. The ` +
        `Customer authorizes ${COMPANY.name} to access the property to perform snow clearing and to apply de-icing ` +
        `products to the selected areas.`;

  const fee = formatMoney(input.early_termination_fee_cents);
  const commitment =
    input.early_termination_fee_cents > 0
      ? `If the Customer cancels this agreement before completing the Initial Service Commitment, the Customer agrees to ` +
        `pay an early termination fee of ${fee} plus applicable tax. The Customer confirms that they are not currently ` +
        `under contract with another snow removal provider for this property.`
      : monthToMonth
        ? `This month-to-month agreement has no early termination fee: the Customer may cancel at any time, effective ` +
          `at the end of the month already paid for. The Customer confirms that they are not currently under contract ` +
          `with another snow removal provider for this property.`
        : `This agreement has no early termination fee. The Customer confirms that they are not currently under ` +
          `contract with another snow removal provider for this property.`;

  const credit = formatMoney(input.referral_credit_cents || DEFAULT_REFERRAL_CREDIT_CENTS);
  const guarantee =
    `If a selected area is missed or is not cleared to standard, ${COMPANY.name} will return and re-clear it at no ` +
    `charge. Please let us know within 24 hours of the service. Referral program: for each new customer you refer ` +
    `who signs a service agreement, you receive a ${credit} credit for every month that customer remains on paid ` +
    `service. Credits are applied automatically to your next bill and have no cash value.`;

  const notifications =
    `The Customer agrees to receive dispatch and service-completion notifications from ${COMPANY.name} by email and ` +
    `by automated text and voice messages at the contact details below. Message and data rates may apply. The ` +
    `Customer may opt out of text messages at any time by replying STOP.`;

  const continuation =
    (monthToMonth || oneTime
      ? 'The terms and conditions on the following page are part of this agreement. '
      : input.auto_renew
        ? 'After the Initial Service Commitment, this agreement continues on the same seasonal schedule until the ' +
          'Customer requests that service be discontinued. The terms and conditions on the following page are part ' +
          'of this agreement. '
        : 'This agreement ends at the end of the Initial Service Commitment. The terms and conditions on the ' +
          'following page are part of this agreement. ') +
    'By accepting the first service, the Customer accepts all of its terms.';

  return { agreement_period, commitment, guarantee, notifications, continuation };
}

/** Page two. The company's own terms, with the trigger depth and province filled in. */
export function termsAndConditions(input: { trigger_cm: number; province_name: string; early_termination_fee_cents: number }): {
  heading: string;
  body: string[];
}[] {
  const fee = formatMoney(input.early_termination_fee_cents);
  return [
    {
      heading: '1. Scope of Services',
      body: [
        `${COMPANY.name} (the "Contractor") will provide snow removal at the service location (the "Property") for the areas selected under Scope of Service, and any Additional Services selected, at the prices shown.`,
        `Service is triggered when snowfall reaches ${input.trigger_cm} cm and is completed during or after the snowfall. During a long storm the Property is serviced once per day until snowfall stops.`,
        'Basic package: up to thirty (30) services for the season; services beyond thirty are $30 per occurrence, charged at the time of service. Premium package: unlimited services for the season.',
        'Additional Services are provided only when selected on this agreement or requested by the Customer and agreed in writing, at the agreed price.',
      ],
    },
    {
      heading: '2. Term',
      body: [
        'This agreement begins on the date it is signed and continues for the Initial Service Commitment shown on page 1, then as described under Agreement Period.',
      ],
    },
    {
      heading: '3. Payment and Fees',
      body: [
        'The Customer agrees to pay each payment on the date shown in the Payment Schedule, and any overages at the time of service, by the payment method on file.',
        'The Customer agrees to pay any invoice not paid automatically within 3 days of receiving it. Late payments incur a $10 fee for every 3 days the payment is late.',
        'Referral credits, where earned, are applied as a reduction of the Customer\'s next bill.',
        'Applicable sales tax (HST, GST and/or PST) is charged on every payment.',
      ],
    },
    {
      heading: '4. Cancellation',
      body: [
        'The Customer may cancel within ten (10) days after the date of this agreement at no charge.',
        `The Customer may cancel before the first day of the season with no early termination fee. Cancelling during the Initial Service Commitment of a seasonal agreement carries the early termination fee shown on page 1 (${fee} plus tax where it applies). Month-to-month agreements may be cancelled at any time without a fee.`,
      ],
    },
    {
      heading: "5. Contractor's Obligations",
      body: [
        'The Contractor will provide snow removal services in a professional manner and maintain the equipment needed to perform them. The Contractor will take all reasonable precautions to avoid damage to the Property but is not liable for damage resulting from normal snow removal procedures.',
      ],
    },
    {
      heading: "6. Customer's Obligations",
      body: [
        'Provide the Contractor with access to the Property for the term of this agreement.',
        'Keep the areas to be cleared free of obstacles (for example vehicles or debris) that would prevent the service.',
        'Tell the Contractor about anything that may affect snow removal, such as low structures, sensitive landscaping, gate codes or where snow should be piled.',
      ],
    },
    {
      heading: '7. Insurance and Liability',
      body: [
        'The Contractor maintains general liability insurance and any required workers\' compensation coverage throughout the term. The Contractor is not responsible for damage to underground sprinkler systems, landscaping, or any structures or fixtures that were not clearly marked and identified to the Contractor before service began.',
      ],
    },
    {
      heading: '8. Force Majeure',
      body: [
        'Neither party is responsible for a delay or failure to perform caused by events beyond its reasonable control, including severe weather, natural disasters or other emergencies.',
      ],
    },
    {
      heading: '9. Indemnification',
      body: [
        'The Customer agrees to indemnify and hold harmless the Contractor from claims, damages or liability arising from the Customer\'s failure to maintain a safe property, or from negligence, misuse or damage resulting from improper use of the services.',
      ],
    },
    {
      heading: '10. Governing Law',
      body: [`This agreement is governed by the laws of the Province of ${input.province_name}.`],
    },
    {
      heading: '11. Entire Agreement',
      body: [
        'This agreement, including these terms, is the entire understanding between the parties about its subject and replaces any earlier oral or written communication.',
      ],
    },
  ];
}

export const PROVINCE_NAMES: Record<string, string> = {
  ON: 'Ontario',
  BC: 'British Columbia',
  AB: 'Alberta',
  SK: 'Saskatchewan',
  MB: 'Manitoba',
  QC: 'Quebec',
  NS: 'Nova Scotia',
  NB: 'New Brunswick',
  NL: 'Newfoundland and Labrador',
  PE: 'Prince Edward Island',
  YT: 'Yukon',
  NT: 'the Northwest Territories',
  NU: 'Nunavut',
};

// ── The agreement document ──────────────────────────────────────────────

/** Everything printed on the agreement, already formatted. Built by the server; drawn by both. */
export interface AgreementModel {
  quote_id: string;
  contract_id: string | null;
  status: 'draft' | 'signed';
  terms_version: string;
  contract_type: string;
  agreement_medium: AgreementMedium;
  plan_kind: PlanKind;
  plan_label: string;
  package_label: string;
  branch_name: string;
  customer: { name: string; email: string | null; phone: string | null; address: string[] };
  billing: { name: string; email: string | null; phone: string | null; address: string[] };
  scope: { label: string; checked: boolean }[];
  /** Package, trigger depth, season dates and driveway, in one line. */
  service_summary: string;
  addons: { label: string; checked: boolean; price: string | null }[];
  length: { one: boolean; two: boolean; other: boolean; other_label: string | null };
  schedule: { label: string; due_on: string; amount: string; total: string; season: number }[];
  paid_in_full: boolean;
  pricing_lines: { label: string; value: string }[];
  tax_label: string;
  rep_name: string | null;
  card: { label: string; brand: string | null };
  notification_email: string | null;
  notification_phone: string | null;
  wording: ReturnType<typeof agreementWording>;
  terms: ReturnType<typeof termsAndConditions>;
  signer_name: string;
  signed_date_label: string | null;
  signed_at: string | null;
  signed_ip: string | null;
  /** Which boxes are signed; on a draft, all false. */
  boxes: Record<SignatureBox, boolean>;
}
