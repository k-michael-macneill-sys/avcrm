import type { Writable } from 'node:stream';
import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { BookkeepingDocument, BookkeepingMonth, Expense, ExpenseCategory } from '../types/models';
import { EXPENSE_CATEGORY_INFO } from './expenses';
import { storage } from './storage';
import { ZipWriter } from '../utils/zip';

/**
 * The year's books in one download for the accountant: a ZIP with the T2125
 * totals by line and by category, the GST/HST return figures, revenue from
 * the invoices, each branch's monthly close, capital purchases for CCA, any
 * expenses entered one by one, and every receipts PDF, statement and
 * receipt kept with them.
 *
 * The figures are the monthly closes' totals (worked out in an AI chat from
 * the receipts and statements, and entered here) plus the expenses entered
 * by hand. Money is whole cents throughout. The business charges GST/HST on
 * its invoices, so it is a registrant: an expense's deductible amount is its
 * cost net of GST/HST, which comes back as an input tax credit instead.
 */

const INFO = new Map(EXPENSE_CATEGORY_INFO.map((c) => [c.code, c]));

function toCents(value: string | number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  return Math.round(Number(value) * 100);
}

function dollars(value: number): string {
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  return `${sign}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** A spreadsheet treats a cell starting with = + - @ as a formula; text from a receipt must never run as one. */
function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return '';
  let text = String(value);
  // A plain amount, negative ones included, stays a number.
  if (typeof value === 'string' && /^[=+\-@\t\r]/.test(text) && !/^-?\d+(\.\d+)?$/.test(text)) text = `'${text}`;
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function csv(rows: (string | number | null | undefined)[][]): Buffer {
  // The byte-order mark makes Excel read the accents in vendor names right.
  return Buffer.from('﻿' + rows.map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n', 'utf8');
}

interface ExpenseRow extends Expense {
  branch_name: string | null;
}

export interface ExpenseMoney {
  total: number;
  gst_hst: number;
  net: number;
  deductible: number;
  itc: number;
}

/**
 * One expense's figures. A capital purchase is not deducted (it goes to CCA)
 * but its GST/HST is still an input tax credit, for the business-use share.
 */
export function expenseMoney(e: Pick<Expense, 'amount' | 'gst_hst' | 'deductible_percent' | 'category'>): ExpenseMoney {
  const total = toCents(e.amount);
  const gst = toCents(e.gst_hst);
  const net = total - gst;
  const share = e.deductible_percent / 100;
  return {
    total,
    gst_hst: gst,
    net,
    deductible: e.category === 'capital_purchase' ? 0 : Math.round(net * share),
    itc: Math.round(gst * share),
  };
}

function safeName(text: string): string {
  return text.replace(/[^\p{L}\p{N} ._-]+/gu, '').replace(/\s+/g, ' ').trim().slice(0, 60) || 'receipt';
}

function scoped<T extends Knex.QueryBuilder>(query: T, column: string, scope: BranchScope): T {
  if (scope.kind === 'branch') query.where(column, scope.branchId);
  return query;
}

async function readBytes(key: string): Promise<Buffer | null> {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of storage.read(key)) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  } catch {
    return null;
  }
}

export async function writeYearEndExport(
  year: number,
  scope: BranchScope,
  out: Writable,
  db: Knex = defaultDb,
): Promise<void> {
  const from = `${year}-01-01`;
  const to = `${year}-12-31`;

  const months = (await scoped(
    db('bookkeeping_months').leftJoin('branches', 'branches.id', 'bookkeeping_months.branch_id') as Knex.QueryBuilder,
    'bookkeeping_months.branch_id',
    scope,
  )
    .whereBetween('bookkeeping_months.month', [from, to])
    .orderBy([{ column: 'bookkeeping_months.month' }, { column: 'branches.name' }])
    .select('bookkeeping_months.*', 'branches.name as branch_name')) as (BookkeepingMonth & { branch_name: string | null })[];
  const documents = months.length
    ? ((await db('bookkeeping_documents')
        .whereIn('month_id', months.map((m) => m.id))
        .orderBy('created_at')) as BookkeepingDocument[])
    : [];

  const expenses = (await scoped(
    db('expenses').leftJoin('branches', 'branches.id', 'expenses.branch_id') as Knex.QueryBuilder,
    'expenses.branch_id',
    scope,
  )
    .whereBetween('expenses.spent_on', [from, to])
    .orderBy([{ column: 'expenses.spent_on' }, { column: 'expenses.created_at' }])
    .select('expenses.*', 'branches.name as branch_name')) as ExpenseRow[];

  // Revenue: invoices issued in the year, in each branch's own time zone.
  const invoices = (await scoped(
    db('invoices').join('branches', 'branches.id', 'invoices.branch_id') as Knex.QueryBuilder,
    'invoices.branch_id',
    scope,
  )
    .whereNotIn('invoices.status', ['draft', 'void'])
    .whereRaw(`extract(year from (coalesce(invoices.sent_at, invoices.created_at) at time zone branches.timezone)) = ?`, [year])
    .select(
      'branches.name as branch_name',
      db.raw('count(*)::int as count'),
      db.raw('sum(coalesce(invoices.subtotal, invoices.amount_due - coalesce(invoices.tax_amount, 0)))::text as subtotal'),
      db.raw('sum(coalesce(invoices.tax_amount, 0))::text as tax'),
      db.raw('sum(invoices.amount_due)::text as total'),
    )
    .groupBy('branches.name')
    .orderBy('branches.name')) as { branch_name: string; count: number; subtotal: string; tax: string; total: string }[];

  const payments = (await scoped(
    db('payments')
      .join('invoices', 'invoices.id', 'payments.invoice_id')
      .join('branches', 'branches.id', 'invoices.branch_id') as Knex.QueryBuilder,
    'invoices.branch_id',
    scope,
  )
    .where('payments.status', 'succeeded')
    .whereRaw(`extract(year from (coalesce(payments.processed_at, payments.created_at) at time zone branches.timezone)) = ?`, [year])
    .select('payments.method', db.raw('count(*)::int as count'), db.raw('sum(payments.amount)::text as total'))
    .groupBy('payments.method')
    .orderBy('payments.method')) as { method: string; count: number; total: string }[];

  // ── Totals: the monthly closes, then the expenses entered by hand ──
  const byCategory = new Map<ExpenseCategory, { closes: number; manual: number; manualTotal: number; manualCount: number }>();
  const add = (code: ExpenseCategory) => {
    const row = byCategory.get(code) ?? { closes: 0, manual: 0, manualTotal: 0, manualCount: 0 };
    byCategory.set(code, row);
    return row;
  };
  for (const m of months) {
    for (const [code, amount] of Object.entries(m.category_amounts) as [ExpenseCategory, string][]) {
      add(code).closes += toCents(amount);
    }
  }
  let manualItc = 0;
  let manualCapital = 0;
  for (const e of expenses) {
    const money = expenseMoney(e);
    manualItc += money.itc;
    if (e.category === 'capital_purchase') {
      manualCapital += money.net;
      continue;
    }
    const row = add(e.category);
    row.manual += money.deductible;
    row.manualTotal += money.total;
    row.manualCount += 1;
  }
  const sum = (pick: (m: BookkeepingMonth) => string | number) => months.reduce((n, m) => n + toCents(pick(m)), 0);
  const closesDeductible = sum((m) => m.deductible_total);
  const manualDeductible = [...byCategory.values()].reduce((n, r) => n + r.manual, 0);
  const totalDeductible = closesDeductible + manualDeductible;
  const totalItc = sum((m) => m.gst_hst_itc) + manualItc;
  const totalCapital = sum((m) => m.capital_purchases) + manualCapital;
  const revenue = invoices.reduce(
    (acc, r) => ({ subtotal: acc.subtotal + toCents(r.subtotal), tax: acc.tax + toCents(r.tax), total: acc.total + toCents(r.total) }),
    { subtotal: 0, tax: 0, total: 0 },
  );

  // What is missing, for the README's checks.
  const branchNames = [...new Set(months.map((m) => m.branch_name ?? 'Company-wide'))];
  const noTotals = months.filter((m) => !m.totals_entered_at);
  const docsOf = (m: BookkeepingMonth) => documents.filter((d) => d.month_id === m.id);
  const noReceipts = months.filter((m) => m.totals_entered_at && !docsOf(m).some((d) => d.kind === 'receipts'));
  const noStatements = months.filter((m) => m.totals_entered_at && !docsOf(m).some((d) => d.kind === 'bank_statement'));
  const monthLabel = (m: BookkeepingMonth & { branch_name: string | null }) => `${m.branch_name ?? 'Company-wide'} ${m.month.slice(0, 7)}`;

  const zip = new ZipWriter(out);
  const now = new Date();

  await zip.add(
    'README.txt',
    Buffer.from(
      [
        `Year-end books for ${year}${scope.kind === 'branch' ? ' (one branch)' : ''}, exported ${now.toISOString().slice(0, 10)}.`,
        '',
        'Files:',
        '  01-t2125-by-line.csv        Totals by Form T2125 line: gross sales and each expense line.',
        '  02-t2125-by-category.csv    The same expenses, by category, split between monthly closes and single entries.',
        '  03-gst-hst-summary.csv      GST/HST collected on invoices, input tax credits, and the net.',
        '  04-revenue.csv              Invoices issued in the year by branch, and payments received by method.',
        '  05-monthly-closes.csv       Each branch\'s month: the totals entered, and the documents kept with it.',
        '  06-capital-purchases.csv    Capital purchases for CCA: monthly totals, and items entered one by one.',
        '  07-single-expenses.csv      Expenses entered one at a time with Add +, each with its receipt file name.',
        '  months/                     Each month\'s receipts PDF, bank and card statements, and the line-by-line CSV.',
        '  receipts/                   Receipts attached to single expenses.',
        '',
        'Where the numbers come from:',
        '  - Monthly closes: each month, the receipts PDF and the statements were worked through in an AI chat',
        '    with the prompt from the CRM, matching receipts to statement lines, and the totals entered here.',
        '    The line-by-line detail is the CSV in that month\'s folder.',
        '  - Amount to claim = (total paid - GST/HST) x business share (meals 50%). PST stays in the cost.',
        '  - Input tax credits = GST/HST shown on receipts x business share. Business costs with only a',
        '    statement line and no receipt are claimed in full with no ITC.',
        '  - Capital purchases are not deducted: they are listed in 06 for CCA.',
        '',
        'Checks:',
        `  ${months.length} monthly close(s) for ${branchNames.length ? branchNames.join(', ') : 'no branch'}.`,
        `  ${noTotals.length} month(s) with documents but no totals entered${noTotals.length ? `: ${noTotals.map(monthLabel).join(', ')}` : ''}.`,
        `  ${noReceipts.length} month(s) with totals but no receipts PDF${noReceipts.length ? `: ${noReceipts.map(monthLabel).join(', ')}` : ''}.`,
        `  ${noStatements.length} month(s) with totals but no statement${noStatements.length ? `: ${noStatements.map(monthLabel).join(', ')}` : ''}.`,
        `  ${dollars(sum((m) => m.no_receipt_total))} of business costs had no receipt (${months.reduce((n, m) => n + m.no_receipt_count, 0)} purchases): no GST/HST was claimed on them.`,
        '',
        'This is bookkeeping, not tax advice: the accountant decides what is finally claimed, including vehicle',
        'business-use percentages (which need a logbook) and the CCA class of each capital purchase.',
        '',
      ].join('\r\n'),
      'utf8',
    ),
    now,
  );

  // 01: by T2125 line. Several categories share a line (9270 "other expenses").
  const byLine = new Map<string, { labels: string[]; amount: number }>();
  for (const info of EXPENSE_CATEGORY_INFO) {
    const row = byCategory.get(info.code);
    if (!row || info.code === 'capital_purchase') continue;
    const line = byLine.get(info.cra_line) ?? { labels: [], amount: 0 };
    line.labels.push(info.label);
    line.amount += row.closes + row.manual;
    byLine.set(info.cra_line, line);
  }
  await zip.add(
    '01-t2125-by-line.csv',
    csv([
      ['T2125 line', 'What', 'Amount to claim'],
      ['8000', 'Gross sales (invoices issued, before GST/HST)', dollars(revenue.subtotal)],
      ...[...byLine.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([line, v]) => [line, v.labels.join('; '), dollars(v.amount)]),
      ['', 'Total expenses', dollars(totalDeductible)],
      ['', 'Net income before CCA (gross sales minus total expenses)', dollars(revenue.subtotal - totalDeductible)],
    ]),
    now,
  );

  await zip.add(
    '02-t2125-by-category.csv',
    csv([
      ['Category', 'T2125 line', 'From monthly closes', 'From single entries', 'Amount to claim'],
      ...EXPENSE_CATEGORY_INFO.filter((c) => byCategory.has(c.code)).map((c) => {
        const row = byCategory.get(c.code)!;
        return [c.label, c.cra_line, dollars(row.closes), dollars(row.manual), dollars(row.closes + row.manual)];
      }),
      ['Total', '', dollars(closesDeductible), dollars(manualDeductible), dollars(totalDeductible)],
    ]),
    now,
  );

  await zip.add(
    '03-gst-hst-summary.csv',
    csv([
      ['GST/HST return line', 'What', 'Amount'],
      ['101', 'Sales and other revenue (invoices issued, before GST/HST)', dollars(revenue.subtotal)],
      ['105', 'GST/HST collected on invoices', dollars(revenue.tax)],
      ['108', 'Input tax credits (monthly closes and single entries)', dollars(totalItc)],
      ['109', 'Net tax (105 minus 108)', dollars(revenue.tax - totalItc)],
    ]),
    now,
  );

  await zip.add(
    '04-revenue.csv',
    csv([
      ['Invoices issued', 'Branch', 'Count', 'Before GST/HST', 'GST/HST', 'Total'],
      ...invoices.map((r) => ['', r.branch_name, r.count, dollars(toCents(r.subtotal)), dollars(toCents(r.tax)), dollars(toCents(r.total))]),
      ['', 'Total', invoices.reduce((n, r) => n + r.count, 0), dollars(revenue.subtotal), dollars(revenue.tax), dollars(revenue.total)],
      [],
      ['Payments received', 'Method', 'Count', 'Amount'],
      ...payments.map((p) => ['', p.method.replace(/_/g, ' '), p.count, dollars(toCents(p.total))]),
      ['', 'Total', payments.reduce((n, p) => n + p.count, 0), dollars(payments.reduce((n, p) => n + toCents(p.total), 0))],
    ]),
    now,
  );

  // Each month's files go in a folder of its own; the CSV names them.
  const folderOf = (m: BookkeepingMonth & { branch_name: string | null }) =>
    `months/${m.month.slice(0, 7)} ${safeName(m.branch_name ?? 'Company-wide')}`;
  const docNames = new Map<string, string>();
  for (const m of months) {
    const counts = new Map<string, number>();
    for (const d of docsOf(m)) {
      const n = (counts.get(d.kind) ?? 0) + 1;
      counts.set(d.kind, n);
      const ext = d.file_key.split('.').pop() ?? 'bin';
      const base = d.kind === 'receipts' ? 'receipts' : d.kind === 'bank_statement' ? 'statement' : 'detail';
      docNames.set(d.id, `${folderOf(m)}/${base}${n > 1 ? `-${n}` : ''}.${ext}`);
    }
  }

  const categoryCodes = EXPENSE_CATEGORY_INFO.filter((c) => c.code !== 'capital_purchase');
  await zip.add(
    '05-monthly-closes.csv',
    csv([
      [
        'Month', 'Branch', ...categoryCodes.map((c) => `${c.label} (${c.cra_line})`), 'Total deductible', 'GST/HST ITCs',
        'Capital purchases', 'Personal / not deductible', 'No-receipt total', 'No-receipt count', 'Notes', 'Files',
      ],
      ...months.map((m) => [
        m.month.slice(0, 7),
        m.branch_name ?? 'Company-wide',
        ...categoryCodes.map((c) => dollars(toCents(m.category_amounts[c.code]))),
        m.totals_entered_at ? dollars(toCents(m.deductible_total)) : 'NOT ENTERED',
        dollars(toCents(m.gst_hst_itc)),
        dollars(toCents(m.capital_purchases)),
        dollars(toCents(m.non_deductible)),
        dollars(toCents(m.no_receipt_total)),
        m.no_receipt_count,
        m.notes,
        docsOf(m).map((d) => docNames.get(d.id)?.replace(`${folderOf(m)}/`, '')).join('; '),
      ]),
    ]),
    now,
  );

  // Receipts attached to single expenses are named once, and the CSVs point at the same names.
  const receiptNames = new Map<string, string>();
  for (const e of expenses) {
    if (!e.receipt_key) continue;
    const ext = e.receipt_key.split('.').pop() ?? 'bin';
    receiptNames.set(
      e.id,
      `receipts/${e.spent_on} ${safeName(e.vendor ?? INFO.get(e.category)?.label ?? 'receipt')} ${dollars(toCents(e.amount))} ${e.id.slice(0, 8)}.${ext}`,
    );
  }
  const expenseRow = (e: ExpenseRow): (string | number | null)[] => {
    const m = expenseMoney(e);
    const info = INFO.get(e.category);
    return [
      e.spent_on,
      e.vendor,
      e.description,
      info?.label ?? e.category,
      info?.cra_line ?? '',
      e.branch_name ?? 'Company-wide',
      dollars(m.total),
      e.gst_hst === null ? '' : dollars(m.gst_hst),
      dollars(m.net),
      e.deductible_percent,
      dollars(m.deductible),
      dollars(m.itc),
      receiptNames.get(e.id)?.replace('receipts/', '') ?? 'NO RECEIPT',
    ];
  };
  const expenseHeader = [
    'Date', 'Vendor', 'Description', 'Category', 'T2125 line', 'Branch', 'Total paid (incl. tax)', 'GST/HST',
    'Net of tax', 'Business %', 'Deductible', 'ITC', 'Receipt',
  ];

  await zip.add(
    '06-capital-purchases.csv',
    csv([
      ['Month or date', 'Branch', 'What', 'Cost before GST/HST'],
      ...months
        .filter((m) => toCents(m.capital_purchases) > 0)
        .map((m) => [m.month.slice(0, 7), m.branch_name ?? 'Company-wide', `Monthly close${m.notes ? `: ${m.notes}` : ''} (see that month's detail CSV)`, dollars(toCents(m.capital_purchases))]),
      ...expenses
        .filter((e) => e.category === 'capital_purchase')
        .map((e) => [e.spent_on, e.branch_name ?? 'Company-wide', [e.vendor, e.description].filter(Boolean).join(' · '), dollars(expenseMoney(e).net)]),
      ['', '', 'Total', dollars(totalCapital)],
    ]),
    now,
  );

  await zip.add('07-single-expenses.csv', csv([expenseHeader, ...expenses.map(expenseRow)]), now);

  for (const m of months) {
    for (const d of docsOf(m)) {
      const bytes = await readBytes(d.file_key);
      if (bytes) await zip.add(docNames.get(d.id)!, bytes, new Date(`${m.month}T12:00:00`));
    }
  }
  for (const e of expenses) {
    const name = receiptNames.get(e.id);
    if (!name || !e.receipt_key) continue;
    const bytes = await readBytes(e.receipt_key);
    if (bytes) await zip.add(name, bytes, new Date(`${e.spent_on}T12:00:00`));
  }

  await zip.finish();
}
