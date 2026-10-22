import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { makeContract } from './helpers/fixtures';
import { harness } from './helpers/harness';
import { call, login } from './helpers/server';
import { EXPENSE_CATEGORY_INFO } from '../src/services/expenses';
import { monthlyClosePrompt, parseCrmSummary } from '../src/types/monthlyClose';

const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
const CSV = Buffer.from('date,vendor,description,source,category,total_paid,gst_hst,pst,business_percent,amount_to_claim,itc,note\n');

/** What a chat answers for Part 2, with the decoration chats add. */
const SUMMARY = `Here is your summary:

**PART 2 - CRM SUMMARY**
\`\`\`
BRANCH: Kingston
MONTH: 2026-11
EQUIPMENT_MAINTENANCE: 1,200.00
FUEL: $412.50
SALT_AND_SUPPLIES: 300.00
MEALS: 10.00
SMALL_TOOLS: 0.00
TOTAL_DEDUCTIBLE: 1922.50
GST_HST_ITC: 296.79
CAPITAL_PURCHASES: 2500.00
NON_DEDUCTIBLE: 212.10
NO_RECEIPT_TOTAL: 56.50
NO_RECEIPT_COUNT: 2
NOTES: Plow blade on Nov 14 is a capital purchase.
\`\`\`
`;

/** Reads a stored ZIP into name → bytes. */
function unzip(bytes: Buffer): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  let at = 0;
  while (bytes.readUInt32LE(at) === 0x04034b50) {
    const size = bytes.readUInt32LE(at + 18);
    const nameLength = bytes.readUInt16LE(at + 26);
    const extra = bytes.readUInt16LE(at + 28);
    const name = bytes.subarray(at + 30, at + 30 + nameLength).toString('utf8');
    const start = at + 30 + nameLength + extra;
    files.set(name, bytes.subarray(start, start + size));
    at = start + size;
  }
  assert.equal(bytes.readUInt32LE(at), 0x02014b50, 'the central directory follows the entries');
  return files;
}

/** Splits a CSV the export wrote: commas inside quotes stay in the cell. */
function rows(csv: Buffer): string[][] {
  return csv
    .toString('utf8')
    .replace(/^﻿/, '')
    .trim()
    .split('\r\n')
    .map((line) =>
      [...line.matchAll(/("(?:[^"]|"")*"|[^,]*)(,|$)/g)]
        .filter((m, i, all) => i < all.length - 1 || m[0] !== '')
        .map((m) => m[1]!.replace(/^"|"$/g, '').replace(/""/g, '"')),
    );
}

describe('the monthly close prompt', () => {
  it('is set for the branch, the month and the province’s sales tax', () => {
    const prompt = monthlyClosePrompt({ categories: EXPENSE_CATEGORY_INFO, branch_name: 'Cranbrook', province: 'BC', month: '2026-11' });
    assert.match(prompt, /Cranbrook branch/);
    assert.match(prompt, /The month is 2026-11/);
    assert.match(prompt, /PST is not recoverable/);
    assert.ok(!prompt.includes('Ontario'), 'only this branch’s rules');
    for (const c of EXPENSE_CATEGORY_INFO.filter((c) => c.code !== 'capital_purchase')) {
      assert.ok(prompt.includes(`${c.code.toUpperCase()}: 0.00`), `the summary asks for ${c.code}`);
    }
    for (const line of ['TOTAL_DEDUCTIBLE', 'GST_HST_ITC', 'CAPITAL_PURCHASES', 'NON_DEDUCTIBLE', 'NO_RECEIPT_TOTAL', 'NO_RECEIPT_COUNT']) {
      assert.ok(prompt.includes(`${line}: 0`), `the summary asks for ${line}`);
    }
  });

  it('gives company-wide every province the branches are in', () => {
    const prompt = monthlyClosePrompt({ categories: EXPENSE_CATEGORY_INFO, branch_name: 'Company-wide', province: null, month: '2026-11' });
    for (const province of ['Ontario', 'British Columbia', 'Saskatchewan', 'Alberta']) assert.ok(prompt.includes(province));
    assert.match(prompt, /bookkeeping for the company-wide accounts/);
  });

  it('reads the summary a chat gives back, decoration and all', () => {
    const parsed = parseCrmSummary(SUMMARY, EXPENSE_CATEGORY_INFO);
    assert.equal(parsed.month, '2026-11');
    assert.equal(parsed.branch, 'Kingston');
    assert.equal(parsed.categories.equipment_maintenance, 120000);
    assert.equal(parsed.categories.fuel, 41250);
    assert.equal(parsed.categories.small_tools, 0);
    assert.equal(parsed.totals.deductible_total, 192250);
    assert.equal(parsed.totals.gst_hst_itc, 29679);
    assert.equal(parsed.totals.capital_purchases, 250000);
    assert.equal(parsed.no_receipt_count, 2);
    assert.match(parsed.notes ?? '', /Plow blade/);
    assert.deepEqual(parsed.problems, []);
  });

  it('reports a number it cannot read instead of guessing', () => {
    const parsed = parseCrmSummary('FUEL: about forty\nGST_HST_ITC: 12.345\nNOTES: none', EXPENSE_CATEGORY_INFO);
    assert.equal(parsed.categories.fuel, undefined);
    assert.equal(parsed.problems.length, 2);
    assert.equal(parsed.notes, null);
  });

  it('reads back the summary its own prompt asks for', () => {
    const prompt = monthlyClosePrompt({ categories: EXPENSE_CATEGORY_INFO, branch_name: 'Regina', province: 'SK', month: '2026-12' });
    const block = prompt.slice(prompt.indexOf('BRANCH: Regina'), prompt.indexOf('TOTAL_DEDUCTIBLE must'));
    const parsed = parseCrmSummary(block, EXPENSE_CATEGORY_INFO);
    assert.equal(parsed.month, '2026-12');
    assert.equal(Object.keys(parsed.categories).length, EXPENSE_CATEGORY_INFO.length - 1);
    assert.equal(Object.keys(parsed.totals).length, 5);
    assert.deepEqual(parsed.problems, []);
  });
});

describe('the monthly close', () => {
  const h = harness();

  async function corporate(): Promise<string> {
    return login(h.server(), h.world().emails.corporate);
  }

  async function upload(token: string, contentType: string, body: Buffer, name: string): Promise<string> {
    const target = await call(h.server(), 'POST', '/uploads', {
      token,
      body: { purpose: 'bookkeeping_document', content_type: contentType, file_name: name },
    });
    assert.equal(target.status, 201, JSON.stringify(target.body));
    const put = await fetch(`${h.server().url}${target.body.data.upload_url}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body,
    });
    assert.equal(put.status, 201);
    return target.body.data.key as string;
  }

  async function attach(token: string, kind: string, contentType: string, body: Buffer, name: string, month = '2026-11') {
    const key = await upload(token, contentType, body, name);
    return call(h.server(), 'POST', '/expenses/months/documents', {
      token,
      body: { branch_id: h.world().branches.kingston, month, kind, file_key: key },
    });
  }

  const totals = (overrides: Record<string, unknown> = {}) => ({
    branch_id: h.world().branches.kingston,
    month: '2026-11',
    category_amounts: { equipment_maintenance: '1200.00', fuel: '412.50', salt_and_supplies: '300', meals: '10.00' },
    gst_hst_itc: '296.79',
    capital_purchases: '2500.00',
    non_deductible: '212.10',
    no_receipt_total: '56.50',
    no_receipt_count: 2,
    notes: 'Plow blade is a capital purchase.',
    ...overrides,
  });

  it('keeps a month’s receipts, statements and detail CSV together', async () => {
    const token = await corporate();
    const receipts = await attach(token, 'receipts', 'application/pdf', PDF, 'november-receipts.pdf');
    assert.equal(receipts.status, 201, JSON.stringify(receipts.body));
    await attach(token, 'bank_statement', 'application/pdf', PDF, 'rbc-chequing.pdf');
    await attach(token, 'bank_statement', 'application/pdf', PDF, 'visa.pdf');
    const detail = await attach(token, 'detail_csv', 'text/csv', CSV, 'detail.csv');

    const month = detail.body.data;
    assert.equal(month.month.slice(0, 10), '2026-11-01');
    assert.equal(month.branch_name, 'Kingston');
    assert.equal(month.totals_entered_at, null, 'documents in, no totals yet');
    assert.deepEqual(
      month.documents.map((d: { kind: string }) => d.kind),
      ['receipts', 'bank_statement', 'bank_statement', 'detail_csv'],
    );
    assert.equal((await db('bookkeeping_months')).length, 1, 'one month, not one per file');
  });

  it('refuses the wrong kind of file for each slot', async () => {
    const token = await corporate();
    const csvAsReceipts = await attach(token, 'receipts', 'text/csv', CSV, 'oops.csv');
    assert.equal(csvAsReceipts.status, 400);
    const pdfAsDetail = await attach(token, 'detail_csv', 'application/pdf', PDF, 'oops.pdf');
    assert.equal(pdfAsDetail.status, 400);
  });

  it('saves the totals, working out the deductible total itself', async () => {
    const token = await corporate();
    const saved = await call(h.server(), 'PUT', '/expenses/months', { token, body: totals() });
    assert.equal(saved.status, 200, JSON.stringify(saved.body));
    const month = saved.body.data;
    assert.equal(month.deductible_total, '1922.50');
    assert.equal(month.gst_hst_itc, '296.79');
    assert.equal(month.capital_purchases, '2500.00');
    assert.deepEqual(month.category_amounts, {
      equipment_maintenance: '1200.00',
      fuel: '412.50',
      salt_and_supplies: '300.00',
      meals: '10.00',
    });
    assert.ok(month.totals_entered_at);

    // Entered again, it replaces rather than adds.
    const again = await call(h.server(), 'PUT', '/expenses/months', {
      token,
      body: totals({ category_amounts: { fuel: '100.00' }, gst_hst_itc: '13' }),
    });
    assert.equal(again.body.data.deductible_total, '100.00');
    assert.deepEqual(again.body.data.category_amounts, { fuel: '100.00' });
    assert.equal((await db('bookkeeping_months')).length, 1);
    assert.ok(await db('audit_log').where({ action: 'bookkeeping_month.totals_saved' }).first());
  });

  it('refuses a capital purchase as an expense category, and amounts that are not money', async () => {
    const token = await corporate();
    const capital = await call(h.server(), 'PUT', '/expenses/months', {
      token,
      body: totals({ category_amounts: { capital_purchase: '2500' } }),
    });
    assert.equal(capital.status, 400);
    const negative = await call(h.server(), 'PUT', '/expenses/months', { token, body: totals({ gst_hst_itc: '-5' }) });
    assert.equal(negative.status, 400);
    const badMonth = await call(h.server(), 'PUT', '/expenses/months', { token, body: totals({ month: '2026-13' }) });
    assert.equal(badMonth.status, 400);
  });

  it('lists months with their files, and removes a file or a month', async () => {
    const token = await corporate();
    const added = await attach(token, 'receipts', 'application/pdf', PDF, 'november-receipts.pdf');
    await call(h.server(), 'PUT', '/expenses/months', { token, body: totals() });

    const list = await call(h.server(), 'GET', '/expenses/months?year=2026', { token });
    assert.equal(list.body.data.length, 1);
    assert.equal(list.body.data[0].documents.length, 1);
    assert.equal((await call(h.server(), 'GET', '/expenses/months?year=2025', { token })).body.data.length, 0);

    const doc = added.body.data.documents[0];
    assert.equal((await call(h.server(), 'DELETE', `/expenses/months/documents/${doc.id}`, { token })).status, 204);
    assert.equal((await db('bookkeeping_documents')).length, 0);
    assert.equal((await call(h.server(), 'DELETE', `/expenses/months/${added.body.data.id}`, { token })).status, 204);
    assert.equal((await db('bookkeeping_months')).length, 0);
  });

  it('exports the year from the monthly closes and the single expenses', async () => {
    const token = await corporate();
    const w = h.world();
    await attach(token, 'receipts', 'application/pdf', PDF, 'november-receipts.pdf');
    await attach(token, 'bank_statement', 'application/pdf', PDF, 'rbc.pdf');
    await attach(token, 'detail_csv', 'text/csv', CSV, 'detail.csv');
    await call(h.server(), 'PUT', '/expenses/months', { token, body: totals() });
    // December: documents in, totals not yet.
    await attach(token, 'receipts', 'application/pdf', PDF, 'december-receipts.pdf', '2026-12');
    // A single expense entered by hand: $113 of fuel with $13 HST.
    const single = await call(h.server(), 'POST', '/expenses', {
      token,
      body: { category: 'fuel', amount: '113.00', gst_hst: '13.00', spent_on: '2026-11-20', vendor: 'Esso', branch_id: w.branches.kingston },
    });
    assert.equal(single.status, 201, JSON.stringify(single.body));

    const contract = await makeContract(w.branches.kingston, w.users.corporate);
    await db('invoices').insert({
      contract_id: contract.contract_id,
      customer_id: contract.customer_id,
      branch_id: w.branches.kingston,
      billing_period_start: '2026-11-01',
      billing_period_end: '2026-11-30',
      amount_due: '565.00',
      subtotal: '500.00',
      tax_amount: '65.00',
      status: 'sent',
      due_date: '2026-11-15',
      sent_at: new Date('2026-11-01T15:00:00Z'),
    });

    const response = await fetch(`${h.server().url}/expenses/export?year=2026`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(response.status, 200);
    const files = unzip(Buffer.from(await response.arrayBuffer()));

    const byLine = rows(files.get('01-t2125-by-line.csv')!);
    const line = (code: string) => byLine.find((r) => r[0] === code);
    assert.equal(line('8000')![2], '500.00', 'gross sales before tax');
    assert.equal(line('9224 / 9281')![2], '512.50', '412.50 from the close plus 100.00 net from the single entry');
    assert.equal(line('8960')![2], '1200.00');
    assert.equal(line('8523')![2], '10.00');
    assert.equal(byLine.find((r) => r[1] === 'Total expenses')![2], '2022.50');

    const gst = rows(files.get('03-gst-hst-summary.csv')!);
    assert.equal(gst.find((r) => r[0] === '105')![2], '65.00');
    assert.equal(gst.find((r) => r[0] === '108')![2], '309.79', '296.79 from the close plus 13.00 on the single entry');
    assert.equal(gst.find((r) => r[0] === '109')![2], '-244.79', 'a refund, as a number');

    const capital = rows(files.get('06-capital-purchases.csv')!);
    assert.equal(capital.at(-1)![3], '2500.00');

    const closes = rows(files.get('05-monthly-closes.csv')!);
    assert.equal(closes.length, 3, 'November and December');
    const december = closes.find((r) => r[0] === '2026-12')!;
    assert.ok(december.includes('NOT ENTERED'));

    const names = [...files.keys()];
    assert.ok(names.includes('months/2026-11 Kingston/receipts.pdf'));
    assert.ok(names.includes('months/2026-11 Kingston/statement.pdf'));
    assert.ok(names.includes('months/2026-11 Kingston/detail.csv'));
    assert.ok(names.includes('months/2026-12 Kingston/receipts.pdf'));
    assert.deepEqual(files.get('months/2026-11 Kingston/receipts.pdf'), PDF);

    const readme = files.get('README.txt')!.toString('utf8');
    assert.match(readme, /1 month\(s\) with documents but no totals entered: Kingston 2026-12/);
    assert.match(readme, /56\.50 of business costs had no receipt \(2 purchases\)/);
  });
});
