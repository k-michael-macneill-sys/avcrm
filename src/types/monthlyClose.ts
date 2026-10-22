/**
 * The monthly close: the prompt a branch pastes into an AI chat with its
 * receipts and statements, and the reader for the summary the chat gives
 * back. Shared by the client (which shows the prompt and fills the form from
 * a pasted summary) and the server (whose tests hold both to one format).
 *
 * The summary is a block of `KEY: amount` lines, one per expense category
 * and one per total, so a person can copy the numbers by eye or paste the
 * whole block and have the form fill itself.
 *
 * Pure: no database, no Node, no DOM.
 */

import type { ExpenseCategory } from './models';

export interface PromptCategory {
  code: ExpenseCategory;
  label: string;
  cra_line: string;
  help: string;
}

/** What each province charges, and which part of it comes back as an input tax credit. */
export const PROVINCE_TAX: Record<string, string> = {
  ON: 'Ontario: 13% HST on most purchases. All of the HST is claimable as an input tax credit. There is no separate PST.',
  BC: 'British Columbia: 5% GST plus 7% PST. Only the GST is claimable. PST is not recoverable: it stays part of the cost of the item.',
  SK: 'Saskatchewan: 5% GST plus 6% PST. Only the GST is claimable. PST is not recoverable: it stays part of the cost of the item.',
  AB: 'Alberta: 5% GST and no PST. All of the GST is claimable.',
  MB: 'Manitoba: 5% GST plus 7% RST. Only the GST is claimable. RST stays part of the cost of the item.',
  QC: 'Quebec: 5% GST plus 9.975% QST. Only the GST is claimable here. QST stays part of the cost of the item.',
  NS: 'Nova Scotia: 14% HST. All of the HST is claimable.',
  NB: 'New Brunswick: 15% HST. All of the HST is claimable.',
  NL: 'Newfoundland and Labrador: 15% HST. All of the HST is claimable.',
  PE: 'Prince Edward Island: 15% HST. All of the HST is claimable.',
};

/** The totals in the summary, after the categories, in the order the form shows them. */
export const SUMMARY_TOTALS = [
  { key: 'TOTAL_DEDUCTIBLE', field: 'deductible_total', label: 'Total tax-deductible expenses', help: 'The sum of the categories above.' },
  { key: 'GST_HST_ITC', field: 'gst_hst_itc', label: 'GST/HST to claim back (ITCs)', help: 'From receipts only. Never PST.' },
  { key: 'CAPITAL_PURCHASES', field: 'capital_purchases', label: 'Capital purchases (for CCA)', help: 'Equipment and vehicles bought outright, before GST/HST.' },
  { key: 'NON_DEDUCTIBLE', field: 'non_deductible', label: 'Personal / not deductible', help: 'Spending on the statements that is not a business cost.' },
  { key: 'NO_RECEIPT_TOTAL', field: 'no_receipt_total', label: 'Business costs with no receipt', help: 'Claimed in full, with no GST/HST back.' },
] as const;
export type SummaryTotalField = (typeof SUMMARY_TOTALS)[number]['field'];

const key = (code: string) => code.toUpperCase();

export interface PromptInput {
  categories: PromptCategory[];
  /** e.g. "Kingston", or "Company-wide". */
  branch_name: string;
  /** Two-letter province code; null for company-wide, which gets every rule. */
  province: string | null;
  /** YYYY-MM. */
  month: string;
}

/** The prompt, ready to paste into an AI chat with the month's receipts PDF and statements. */
export function monthlyClosePrompt(input: PromptInput): string {
  const expenseCategories = input.categories.filter((c) => c.code !== 'capital_purchase');
  const taxRules = input.province && PROVINCE_TAX[input.province]
    ? PROVINCE_TAX[input.province]!
    : Object.values(PROVINCE_TAX).slice(0, 4).join('\n');
  const categoryList = expenseCategories
    .map((c) => `- ${key(c.code)}: ${c.label} (T2125 line ${c.cra_line}). ${c.help}`)
    .join('\n');
  const summaryLines = [
    `BRANCH: ${input.branch_name}`,
    `MONTH: ${input.month}`,
    ...expenseCategories.map((c) => `${key(c.code)}: 0.00`),
    ...SUMMARY_TOTALS.map((t) => `${t.key}: 0.00`),
    'NO_RECEIPT_COUNT: 0',
    'NOTES: (one line: anything the accountant should know, or "none")',
  ].join('\n');

  const whose = input.province === null && /company/i.test(input.branch_name)
    ? 'the company-wide accounts'
    : `the ${input.branch_name} branch`;
  return `You are doing the monthly bookkeeping for ${whose} of a Canadian snow removal business (plowing and shovelling driveways and walkways, salting, roof raking; crews, plow trucks, snow blowers and loaders). The business files Form T2125 and is registered for GST/HST, so it claims back the GST/HST it pays as input tax credits (ITCs). The month is ${input.month}.

I am attaching:
1. RECEIPTS: one PDF of this month's receipts, scanned with a phone (one or more receipts per page).
2. STATEMENTS: this month's bank and/or credit card statement(s).

Work through it in this order.

STEP 1: Read every receipt. For each one note the date, vendor, what was bought, the total paid, the GST/HST shown, and any PST shown.

STEP 2: Read every statement line. Match each receipt to its statement line: same amount, usually posted 0 to 5 days after the receipt date. Each purchase is counted once, never twice.

STEP 3: Decide what every purchase is (receipts, and statement lines with no receipt):
- A business expense: give it one category from the list below.
- A capital purchase: equipment or a vehicle bought outright that lasts more than a year and costs more than about $500 (a plow, a snow blower, a truck). These are not expenses; they go in CAPITAL_PURCHASES.
- Personal or not a business cost (groceries for home, personal clothing, family entertainment, personal subscriptions): NON_DEDUCTIBLE.
- Not spending at all, so leave it out completely: transfers between accounts, credit card payments, loan principal, owner withdrawals, tax payments to the CRA, refunds, and money coming in.

Categories (use the CODE exactly):
${categoryList}

STEP 4: Work out the amounts.
Sales tax for this branch:
${taxRules}
- Amount to claim for a business expense = (total paid - GST/HST) x business share. PST, where there is any, stays in: it is part of the cost.
- Business share is 100%, except meals and entertainment (MEALS), which are 50%.
- GST/HST to claim back (ITC) = the GST/HST on the receipt x business share. Only from a receipt that shows it. Never claim PST.
- A business cost on a statement with no receipt: claim its full total as the expense, with no ITC, and count it in NO_RECEIPT_TOTAL and NO_RECEIPT_COUNT.
- Capital purchases: add their cost before GST/HST to CAPITAL_PURCHASES. Their GST/HST still counts in GST_HST_ITC.
- Never guess a number you cannot read. Leave it out and list it in PART 3.

Give your answer in exactly three parts.

PART 1 - DETAIL. A CSV in a code block, one row per purchase, with this header:
date,vendor,description,source,category,total_paid,gst_hst,pst,business_percent,amount_to_claim,itc,note
source is one of: receipt+statement, receipt only, statement only. category is a CODE from the list, CAPITAL, or PERSONAL. Amounts are plain numbers like 84.37 with no $ sign and no commas.

PART 2 - CRM SUMMARY. A code block in exactly this format, every line present, amounts like 1234.56 with no $ sign and no commas, 0.00 when there is nothing:
${summaryLines}
TOTAL_DEDUCTIBLE must equal the sum of the category lines.

PART 3 - CHECK. A short list of anything unreadable or uncertain, receipts with no matching statement line, and large statement purchases with no receipt (worth finding the receipt for the GST/HST back).`;
}

export interface ParsedSummary {
  month: string | null;
  branch: string | null;
  /** Cents per category, for the categories the summary named. */
  categories: Partial<Record<ExpenseCategory, number>>;
  /** Cents per total. */
  totals: Partial<Record<SummaryTotalField, number>>;
  no_receipt_count: number | null;
  notes: string | null;
  /** Lines that looked like they should be read but could not be. */
  problems: string[];
}

/** "1,234.56", "$84.37", "-0" → cents; null for anything that is not an amount. */
export function amountToCents(text: string): number | null {
  const cleaned = text.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  if (!/^-?\d+(\.\d{1,2})?$/.test(cleaned)) return null;
  const negative = cleaned.startsWith('-');
  const [whole, fraction = ''] = cleaned.replace('-', '').split('.') as [string, string?];
  const cents = Number(whole) * 100 + Number((fraction + '00').slice(0, 2));
  return negative ? -cents : cents;
}

/**
 * Reads the CRM SUMMARY block the prompt asks for. Forgiving about what is
 * around it (code fences, bold markers, the other two parts), strict about
 * the numbers: a line it cannot read is reported, never guessed.
 */
export function parseCrmSummary(text: string, categories: { code: ExpenseCategory }[]): ParsedSummary {
  const byKey = new Map(categories.map((c) => [key(c.code), c.code]));
  const totalsByKey = new Map<string, SummaryTotalField>(SUMMARY_TOTALS.map((t) => [t.key, t.field]));
  const result: ParsedSummary = {
    month: null,
    branch: null,
    categories: {},
    totals: {},
    no_receipt_count: null,
    notes: null,
    problems: [],
  };

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/[*`]/g, '').trim();
    const match = /^([A-Z][A-Z_ ]*[A-Z])\s*[:=]\s*(.*)$/.exec(line);
    if (!match) continue;
    const name = match[1]!.replace(/ /g, '_');
    const value = match[2]!.trim();

    if (name === 'MONTH') {
      const month = /(\d{4})-(\d{2})/.exec(value);
      result.month = month ? `${month[1]}-${month[2]}` : null;
      continue;
    }
    if (name === 'BRANCH') {
      result.branch = value || null;
      continue;
    }
    if (name === 'NOTES') {
      result.notes = value && !/^\(?none\)?\.?$/i.test(value) ? value : null;
      continue;
    }
    if (name === 'NO_RECEIPT_COUNT') {
      const n = Number(value.replace(/[^\d]/g, ''));
      if (value && Number.isFinite(n)) result.no_receipt_count = n;
      else result.problems.push(line);
      continue;
    }
    const category = byKey.get(name);
    const total = totalsByKey.get(name);
    if (!category && !total) continue;
    const cents = amountToCents(value);
    if (cents === null || cents < 0) {
      result.problems.push(line);
      continue;
    }
    if (category) result.categories[category] = cents;
    else result.totals[total!] = cents;
  }
  return result;
}

/** Cents → "1234.56", the form Postgres numeric columns and the inputs take. */
export function centsToAmount(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(cents);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
