import type { Writable } from 'node:stream';
import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { BankTransaction, Expense, ExpenseCategory } from '../types/models';
import { EXPENSE_CATEGORY_INFO } from './expenses';
import { storage } from './storage';
import { ZipWriter } from '../utils/zip';

/**
 * The year's books in one download for the accountant: a ZIP with the T2125
 * totals by category and by line, the GST/HST return figures, revenue from
 * the invoices, every expense, capital purchases for CCA, every bank line,
 * what is still waiting for review, and every receipt.
 *
 * Money is whole cents throughout. The business charges GST/HST on its
 * invoices, so it is a registrant: the deductible amount of an expense is
 * its cost net of the GST/HST, which comes back as an input tax credit
 * instead. Only filed expenses count; review items are listed separately.
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

  const expenses = (await scoped(
    db('expenses').leftJoin('branches', 'branches.id', 'expenses.branch_id'),
    'expenses.branch_id',
    scope,
  )
    .whereBetween('expenses.spent_on', [from, to])
    .orderBy([{ column: 'expenses.spent_on' }, { column: 'expenses.created_at' }])
    .select('expenses.*', 'branches.name as branch_name')) as ExpenseRow[];
  const filed = expenses.filter((e) => e.status === 'filed');
  const review = expenses.filter((e) => e.status === 'review');

  const lines = (await scoped(db('bank_transactions'), 'branch_id', scope)
    .whereBetween('posted_on', [from, to])
    .orderBy('posted_on')) as BankTransaction[];

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

  // ── Totals ──
  const byCategory = new Map<ExpenseCategory, { count: number; m: ExpenseMoney }>();
  for (const e of filed) {
    const m = expenseMoney(e);
    const sum = byCategory.get(e.category) ?? { count: 0, m: { total: 0, gst_hst: 0, net: 0, deductible: 0, itc: 0 } };
    sum.count += 1;
    for (const k of Object.keys(m) as (keyof ExpenseMoney)[]) sum.m[k] += m[k];
    byCategory.set(e.category, sum);
  }
  const all = [...byCategory.values()].reduce(
    (acc, { count, m }) => ({
      count: acc.count + count,
      total: acc.total + m.total,
      gst: acc.gst + m.gst_hst,
      deductible: acc.deductible + m.deductible,
      itc: acc.itc + m.itc,
    }),
    { count: 0, total: 0, gst: 0, deductible: 0, itc: 0 },
  );
  const revenue = invoices.reduce(
    (acc, r) => ({ subtotal: acc.subtotal + toCents(r.subtotal), tax: acc.tax + toCents(r.tax), total: acc.total + toCents(r.total) }),
    { subtotal: 0, tax: 0, total: 0 },
  );
  const noReceipt = filed.filter((e) => !e.receipt_key);
  const noTaxSplit = filed.filter((e) => e.gst_hst === null);

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
        '  02-t2125-by-category.csv    The same expenses, by the category they were filed under.',
        '  03-gst-hst-summary.csv      GST/HST collected on invoices, input tax credits, and the net.',
        '  04-revenue.csv              Invoices issued in the year by branch, and payments received by method.',
        '  05-expenses.csv             Every filed expense, one row each, with its receipt file name.',
        '  06-capital-purchases.csv    Equipment and vehicles bought outright: for capital cost allowance (CCA).',
        '  07-bank-transactions.csv    Every imported bank and card line, and what it was classified as.',
        '  08-not-yet-reviewed.csv     Entries still waiting for review. NOT included in any total.',
        '  receipts/                   Every receipt on file, named by date, vendor and amount.',
        '',
        'How the numbers are worked out:',
        '  - Total paid includes tax. Net of tax = total paid minus the GST/HST shown on the receipt.',
        '  - Deductible = net of tax x the business share (meals are 50%). Capital purchases are not deducted:',
        '    they are listed in 06 for CCA.',
        '  - Input tax credit (ITC) = the GST/HST on the receipt x the business share.',
        '  - Expenses with no GST/HST recorded (usually ones filed from a bank line with no receipt) are counted',
        '    at their full amount with no ITC. Attaching the receipt may recover the ITC.',
        '',
        `Checks: ${noReceipt.length} filed expense(s) have no receipt attached; ${noTaxSplit.length} have no GST/HST recorded;`,
        `${review.length} expense(s) and ${lines.filter((l) => l.classification === 'review').length} bank line(s) are still waiting for review.`,
        '',
        'Categories were suggested by Claude from the receipts and statements and checked where it was unsure.',
        'This is bookkeeping, not tax advice: the accountant decides what is finally claimed, including vehicle',
        'business-use percentages (which need a logbook) and the CCA class of each capital purchase.',
        '',
      ].join('\r\n'),
      'utf8',
    ),
    now,
  );

  // 01: by T2125 line. Several categories share a line (9270 "other expenses").
  const byLine = new Map<string, { labels: string[]; deductible: number; itc: number; total: number }>();
  for (const info of EXPENSE_CATEGORY_INFO) {
    const sum = byCategory.get(info.code);
    if (!sum || info.code === 'capital_purchase') continue;
    const line = byLine.get(info.cra_line) ?? { labels: [], deductible: 0, itc: 0, total: 0 };
    line.labels.push(info.label);
    line.deductible += sum.m.deductible;
    line.itc += sum.m.itc;
    line.total += sum.m.total;
    byLine.set(info.cra_line, line);
  }
  await zip.add(
    '01-t2125-by-line.csv',
    csv([
      ['T2125 line', 'What', 'Amount to claim', 'Total paid (incl. tax)', 'ITCs (GST/HST)'],
      ['8000', 'Gross sales (invoices issued, before GST/HST)', dollars(revenue.subtotal), '', ''],
      ...[...byLine.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([line, v]) => [line, v.labels.join('; '), dollars(v.deductible), dollars(v.total), dollars(v.itc)]),
      ['', 'Total expenses', dollars(all.deductible), dollars(all.total - (byCategory.get('capital_purchase')?.m.total ?? 0)), dollars(all.itc)],
      ['', 'Net income before CCA (gross sales minus total expenses)', dollars(revenue.subtotal - all.deductible), '', ''],
    ]),
    now,
  );

  // 02: by category.
  await zip.add(
    '02-t2125-by-category.csv',
    csv([
      ['Category', 'T2125 line', 'Entries', 'Total paid (incl. tax)', 'GST/HST', 'Net of tax', 'Deductible', 'ITCs'],
      ...EXPENSE_CATEGORY_INFO.filter((c) => byCategory.has(c.code)).map((c) => {
        const { count, m } = byCategory.get(c.code)!;
        return [c.label, c.cra_line, count, dollars(m.total), dollars(m.gst_hst), dollars(m.net), dollars(m.deductible), dollars(m.itc)];
      }),
      ['Total', '', all.count, dollars(all.total), dollars(all.gst), '', dollars(all.deductible), dollars(all.itc)],
    ]),
    now,
  );

  // 03: the GST/HST return's figures.
  await zip.add(
    '03-gst-hst-summary.csv',
    csv([
      ['GST/HST return line', 'What', 'Amount'],
      ['101', 'Sales and other revenue (invoices issued, before GST/HST)', dollars(revenue.subtotal)],
      ['105', 'GST/HST collected on invoices', dollars(revenue.tax)],
      ['108', 'Input tax credits (from filed expenses)', dollars(all.itc)],
      ['109', 'Net tax (105 minus 108)', dollars(revenue.tax - all.itc)],
    ]),
    now,
  );

  // 04: revenue.
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

  // Receipts are named once, and the CSVs point at the same names.
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
      e.source.replace(/_/g, ' '),
      receiptNames.get(e.id)?.replace('receipts/', '') ?? 'NO RECEIPT',
    ];
  };
  const expenseHeader = [
    'Date', 'Vendor', 'Description', 'Category', 'T2125 line', 'Branch', 'Total paid (incl. tax)', 'GST/HST',
    'Net of tax', 'Business %', 'Deductible', 'ITC', 'Entered by', 'Receipt',
  ];

  await zip.add('05-expenses.csv', csv([expenseHeader, ...filed.filter((e) => e.category !== 'capital_purchase').map(expenseRow)]), now);
  await zip.add('06-capital-purchases.csv', csv([expenseHeader, ...filed.filter((e) => e.category === 'capital_purchase').map(expenseRow)]), now);

  await zip.add(
    '07-bank-transactions.csv',
    csv([
      ['Date', 'Description', 'Vendor', 'Money out', 'Money in', 'Classified as', 'Category', 'Business %', 'Note', 'In the books'],
      ...lines.map((l) => [
        l.posted_on,
        l.description,
        l.vendor,
        l.direction === 'debit' ? dollars(toCents(l.amount)) : '',
        l.direction === 'credit' ? dollars(toCents(l.amount)) : '',
        l.classification,
        l.category ? (INFO.get(l.category)?.label ?? l.category) : '',
        l.category ? l.deductible_percent : '',
        l.note,
        l.expense_id ? 'yes' : '',
      ]),
    ]),
    now,
  );

  await zip.add(
    '08-not-yet-reviewed.csv',
    csv([
      ['Kind', 'Date', 'Vendor / description', 'Amount', 'Why it is waiting'],
      ...review.map((e) => ['expense', e.spent_on, e.vendor ?? e.description, dollars(toCents(e.amount)), e.review_note]),
      ...lines
        .filter((l) => l.classification === 'review')
        .map((l) => ['bank line', l.posted_on, l.vendor ?? l.description, dollars(toCents(l.amount)), l.note]),
    ]),
    now,
  );

  for (const e of expenses) {
    const name = receiptNames.get(e.id);
    if (!name || !e.receipt_key) continue;
    const bytes = await readBytes(e.receipt_key);
    if (bytes) await zip.add(name, bytes, new Date(`${e.spent_on}T12:00:00`));
  }

  await zip.finish();
}
