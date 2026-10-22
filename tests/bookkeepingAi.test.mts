/*
 * Bookkeeping that files itself: receipts and bank statements read by a
 * stand-in Claude, and the year-end package for the accountant.
 *
 * The environment is set before anything imports the configuration, so the
 * app really calls the stand-in, with a key.
 */
import assert from 'node:assert/strict';
import { after, beforeEach, describe, it } from 'node:test';
import { startClaudeApi, type FakeClaudeApi } from './helpers/claudeApi';

const claude: FakeClaudeApi = await startClaudeApi();
process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
process.env.ANTHROPIC_API_BASE = claude.url;

const { db } = await import('./helpers/database');
const { makeContract } = await import('./helpers/fixtures');
const { harness } = await import('./helpers/harness');
const { call, login } = await import('./helpers/server');
const { statementSettled } = await import('../src/services/bookkeepingAi');

after(() => claude.close());

/** A one-pixel PNG, standing in for a photo of a till slip. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

const CSV = [
  'Date,Description,Withdrawals,Deposits',
  '2026-02-03,PETRO-CAN #1234 KINGSTON ON,84.37,',
  '2026-02-04,CDN TIRE #88,56.50,',
  '2026-02-05,LOBLAWS 1029,212.10,',
  '2026-02-06,PAYMENT THANK YOU,500.00,',
  '2026-02-07,SQUARE DEPOSIT,,1130.00',
  '2026-02-08,AMZN MKTP CA,39.99,',
].join('\n');

/** What the stand-in answers for that CSV. */
const STATEMENT = {
  is_statement: true,
  account_label: 'RBC Business Visa ••4321',
  period_start: '2026-02-01',
  period_end: '2026-02-28',
  transactions: [
    { date: '2026-02-03', description: 'PETRO-CAN #1234 KINGSTON ON', vendor: 'Petro-Canada', amount: 84.37, direction: 'debit', classification: 'deductible', category: 'fuel', deductible_percent: 100, note: 'Fuel' },
    { date: '2026-02-04', description: 'CDN TIRE #88', vendor: 'Canadian Tire', amount: 56.5, direction: 'debit', classification: 'deductible', category: 'small_tools', deductible_percent: 100, note: 'Shovels' },
    { date: '2026-02-05', description: 'LOBLAWS 1029', vendor: 'Loblaws', amount: 212.1, direction: 'debit', classification: 'personal', category: null, deductible_percent: 100, note: 'Groceries' },
    { date: '2026-02-06', description: 'PAYMENT THANK YOU', vendor: null, amount: 500, direction: 'debit', classification: 'transfer', category: null, deductible_percent: 100, note: 'Card payment' },
    { date: '2026-02-07', description: 'SQUARE DEPOSIT', vendor: 'Square', amount: 1130, direction: 'credit', classification: 'income', category: null, deductible_percent: 100, note: 'Customer payments' },
    { date: '2026-02-08', description: 'AMZN MKTP CA', vendor: 'Amazon', amount: 39.99, direction: 'debit', classification: 'review', category: 'office_and_software', deductible_percent: 100, note: 'Could be business or personal' },
  ],
};

function receipt(overrides: Record<string, unknown> = {}) {
  return {
    is_receipt: true,
    vendor: 'Petro-Canada',
    date: '2026-02-03',
    total: 84.37,
    gst_hst: 9.71,
    currency: 'CAD',
    category: 'fuel',
    deductible_percent: 100,
    description: 'Diesel for plow truck',
    business_expense: true,
    confidence: 'high',
    review_reason: null,
    ...overrides,
  };
}

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

describe('bookkeeping with Claude', () => {
  const h = harness();
  beforeEach(() => claude.reset());

  async function corporate(): Promise<string> {
    return login(h.server(), h.world().emails.corporate);
  }

  async function upload(token: string, purpose: string, contentType: string, body: Buffer, name: string): Promise<string> {
    const target = await call(h.server(), 'POST', '/uploads', {
      token,
      body: { purpose, content_type: contentType, file_name: name },
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

  async function scan(token: string, answer: Record<string, unknown>, branch: string | null = null) {
    claude.answer(() => answer);
    const key = await upload(token, 'receipt', 'image/png', PNG, 'receipt.png');
    return call(h.server(), 'POST', '/expenses/scan', { token, body: { receipt_key: key, branch_id: branch } });
  }

  async function importStatement(token: string, answer: Record<string, unknown> = STATEMENT) {
    claude.answer(() => answer);
    const key = await upload(token, 'bank_statement', 'text/csv', Buffer.from(CSV), 'february.csv');
    const reply = await call(h.server(), 'POST', '/expenses/statements', { token, body: { file_key: key } });
    assert.equal(reply.status, 202, JSON.stringify(reply.body));
    await statementSettled(reply.body.data.id);
    return reply.body.data.id as string;
  }

  it('says scanning is on when a key is set', async () => {
    const reply = await call(h.server(), 'GET', '/expenses/automation', { token: await corporate() });
    assert.deepEqual(reply.body.data, { enabled: true });
  });

  it('files a clear receipt straight into the books, GST/HST and all', async () => {
    const token = await corporate();
    const reply = await scan(token, receipt(), h.world().branches.kingston);

    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    assert.equal(reply.body.data.outcome, 'filed');
    const e = reply.body.data.expense;
    assert.equal(e.amount, '84.37');
    assert.equal(e.gst_hst, '9.71');
    assert.equal(e.category, 'fuel');
    assert.equal(e.vendor, 'Petro-Canada');
    assert.equal(e.spent_on, '2026-02-03');
    assert.equal(e.source, 'receipt_scan');
    assert.equal(e.status, 'filed');
    assert.equal(e.branch_name, 'Kingston');
    assert.ok(e.receipt_key, 'the receipt stays attached');

    const [asked] = claude.requests();
    assert.deepEqual(asked!.blocks, ['image', 'text'], 'the photo goes as an image');
    assert.equal(asked!.model, 'claude-opus-5-5');
    assert.equal(asked!.effort, 'low');
    assert.equal(asked!.fallbacks, 'default');
    assert.match(asked!.beta ?? '', /server-side-fallback-2026-07-01/);
    assert.equal(asked!.apiKey, 'sk-ant-test');
    assert.match(asked!.system, /T2125/);
  });

  it('takes half of a meal', async () => {
    const reply = await scan(await corporate(), receipt({ vendor: 'Tim Hortons', category: 'meals', deductible_percent: 50, total: 18.4, gst_hst: 2.12 }));
    assert.equal(reply.body.data.expense.deductible_percent, 50);
  });

  it('holds anything it was unsure of for review, and a person approves it', async () => {
    const token = await corporate();
    const reply = await scan(token, receipt({ confidence: 'low', review_reason: 'The total is smudged.' }));
    assert.equal(reply.body.data.outcome, 'review');
    const e = reply.body.data.expense;
    assert.equal(e.status, 'review');
    assert.match(e.review_note, /smudged/);

    const approved = await call(h.server(), 'PATCH', `/expenses/${e.id}`, {
      token,
      body: { amount: '84.73', status: 'filed' },
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body.data.status, 'filed');
    assert.equal(approved.body.data.amount, '84.73');
    assert.equal(approved.body.data.review_note, null);
    assert.ok(await db('audit_log').where({ action: 'expense.approved', entity_id: e.id }).first());
  });

  it('holds personal spending, foreign currency, capital purchases and likely duplicates', async () => {
    const token = await corporate();
    const personal = await scan(token, receipt({ vendor: 'Loblaws', business_expense: false, category: 'other', description: 'Groceries' }));
    assert.equal(personal.body.data.outcome, 'review');
    assert.equal(personal.body.data.expense.deductible_percent, 0);
    assert.match(personal.body.data.expense.review_note, /personal/);

    const usd = await scan(token, receipt({ currency: 'USD', date: '2026-02-10' }));
    assert.match(usd.body.data.expense.review_note, /USD/);

    const truck = await scan(token, receipt({ category: 'capital_purchase', total: 8400, gst_hst: 966, date: '2026-02-11', description: 'Plow blade' }));
    assert.match(truck.body.data.expense.review_note, /Capital purchase/);

    await scan(token, receipt({ date: '2026-03-01' }));
    const again = await scan(token, receipt({ date: '2026-03-01' }));
    assert.match(again.body.data.expense.review_note, /filed twice/);
  });

  it('turns away a photo that is not a receipt, or has no total', async () => {
    const token = await corporate();
    const cat = await scan(token, receipt({ is_receipt: false }));
    assert.equal(cat.status, 422);
    const blurred = await scan(token, receipt({ total: null }));
    assert.equal(blurred.status, 422);
    assert.match(blurred.body.error.message, /by hand/);
    assert.equal((await db('expenses').count<{ count: string }[]>({ count: '*' }))[0]!.count, '0');
  });

  it('says so when Claude declines', async () => {
    const token = await corporate();
    claude.answer(() => ({ refusal: true }));
    const key = await upload(token, 'receipt', 'image/png', PNG, 'receipt.png');
    const reply = await call(h.server(), 'POST', '/expenses/scan', { token, body: { receipt_key: key } });
    assert.equal(reply.status, 422);
    assert.match(reply.body.error.message, /by hand/);
  });

  it('reads a bank statement line by line, filing business costs and matching receipts', async () => {
    const token = await corporate();
    // The fuel receipt was already scanned: the bank line should match it, not file it again.
    const fuel = (await scan(token, receipt())).body.data.expense;

    const id = await importStatement(token);
    const [asked] = claude.requests().slice(-1);
    assert.deepEqual(asked!.blocks, ['text', 'text'], 'a CSV goes as text');
    assert.match(asked!.text ?? '', /PETRO-CAN/);
    assert.equal(asked!.effort, 'medium');

    const statements = await call(h.server(), 'GET', '/expenses/statements', { token });
    const statement = statements.body.data.find((s: { id: string }) => s.id === id);
    assert.equal(statement.status, 'done');
    assert.equal(statement.transaction_count, 6);
    assert.equal(statement.account_label, 'RBC Business Visa ••4321');
    assert.equal(statement.review_count, 1);

    const lines = await db('bank_transactions').where({ statement_id: id }).orderBy('posted_on');
    assert.deepEqual(
      lines.map((l: { classification: string }) => l.classification),
      ['deductible', 'deductible', 'personal', 'transfer', 'income', 'review'],
    );
    assert.equal(lines[0].expense_id, fuel.id, 'the fuel line is the receipt already filed');
    const linked = await db('expenses').where({ id: fuel.id }).first();
    assert.equal(linked.bank_transaction_id, lines[0].id);

    const fromBank = await db('expenses').where({ source: 'bank_statement' });
    assert.equal(fromBank.length, 1, 'only the line with no receipt is filed from the bank');
    assert.equal(fromBank[0].vendor, 'Canadian Tire');
    assert.equal(fromBank[0].amount, '56.50');
    assert.equal(fromBank[0].gst_hst, null, 'no receipt, so no GST/HST split');
    assert.equal(fromBank[0].status, 'filed');
  });

  it('adds nothing the second time the same statement is imported', async () => {
    const token = await corporate();
    await importStatement(token);
    await importStatement(token);
    assert.equal((await db('bank_transactions')).length, 6);
    assert.equal((await db('expenses').where({ source: 'bank_statement' })).length, 2);
  });

  it('lets a person settle a line Claude was unsure of', async () => {
    const token = await corporate();
    await importStatement(token);
    const review = await call(h.server(), 'GET', '/expenses/bank-transactions/review', { token });
    assert.equal(review.body.data.length, 1);
    const line = review.body.data[0];

    const settled = await call(h.server(), 'POST', `/expenses/bank-transactions/${line.id}/resolve`, {
      token,
      body: { decision: 'business', category: 'office_and_software' },
    });
    assert.equal(settled.status, 200, JSON.stringify(settled.body));
    assert.equal(settled.body.data.classification, 'deductible');
    assert.ok(settled.body.data.expense_id);
    const expense = await db('expenses').where({ id: settled.body.data.expense_id }).first();
    assert.equal(expense.amount, '39.99');
    assert.equal(expense.status, 'filed');

    const again = await call(h.server(), 'POST', `/expenses/bank-transactions/${line.id}/resolve`, {
      token,
      body: { decision: 'personal' },
    });
    assert.equal(again.status, 409, 'once it is in the books, it is settled');
  });

  it('marks a statement failed when it cannot be read, and reads it again on retry', async () => {
    const token = await corporate();
    const id = await importStatement(token, { is_statement: false, account_label: null, period_start: null, period_end: null, transactions: [] });
    let statement = await db('bank_statements').where({ id }).first();
    assert.equal(statement.status, 'failed');
    assert.match(statement.error, /statement/);

    claude.answer(() => STATEMENT);
    const retried = await call(h.server(), 'POST', `/expenses/statements/${id}/retry`, { token });
    assert.equal(retried.status, 202);
    await statementSettled(id);
    statement = await db('bank_statements').where({ id }).first();
    assert.equal(statement.status, 'done');
    assert.equal(statement.transaction_count, 6);
  });

  it('removes a statement with the expenses filed from it, and keeps receipts', async () => {
    const token = await corporate();
    const fuel = (await scan(token, receipt())).body.data.expense;
    const id = await importStatement(token);
    const gone = await call(h.server(), 'DELETE', `/expenses/statements/${id}`, { token });
    assert.equal(gone.status, 204);
    assert.equal((await db('bank_transactions')).length, 0);
    assert.equal((await db('expenses').where({ source: 'bank_statement' })).length, 0);
    const kept = await db('expenses').where({ id: fuel.id }).first();
    assert.ok(kept, 'the scanned receipt stays');
    assert.equal(kept.bank_transaction_id, null);
  });

  it('exports the year as one ZIP the accountant can file from', async () => {
    const token = await corporate();
    const w = h.world();
    await scan(token, receipt(), w.branches.kingston); // fuel 84.37, 9.71 HST
    await scan(token, receipt({ vendor: 'Tim Hortons', category: 'meals', deductible_percent: 50, total: 22.6, gst_hst: 2.6, date: '2026-02-12', description: 'Crew lunch' }));
    await scan(token, receipt({ category: 'capital_purchase', total: 1130, gst_hst: 130, date: '2026-02-13', description: 'Snow blower' }));
    const pending = (await scan(token, receipt({ confidence: 'low', total: 999, date: '2026-02-14' }))).body.data.expense;
    // Approve the blower; leave the smudged one waiting.
    const blower = await db('expenses').where({ category: 'capital_purchase' }).first();
    await call(h.server(), 'PATCH', `/expenses/${blower.id}`, { token, body: { status: 'filed' } });
    await importStatement(token);
    // Last year's receipt stays out.
    await scan(token, receipt({ date: '2025-12-30', total: 50, gst_hst: 5 }));

    const contract = await makeContract(w.branches.kingston, w.users.corporate);
    await db('invoices').insert({
      contract_id: contract.contract_id,
      customer_id: contract.customer_id,
      branch_id: w.branches.kingston,
      billing_period_start: '2026-02-01',
      billing_period_end: '2026-02-28',
      amount_due: '113.00',
      subtotal: '100.00',
      tax_amount: '13.00',
      status: 'sent',
      due_date: '2026-02-15',
      sent_at: new Date('2026-02-01T15:00:00Z'),
    });

    const response = await fetch(`${h.server().url}/expenses/export?year=2026`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'application/zip');
    const files = unzip(Buffer.from(await response.arrayBuffer()));

    for (const name of [
      'README.txt',
      '01-t2125-by-line.csv',
      '02-t2125-by-category.csv',
      '03-gst-hst-summary.csv',
      '04-revenue.csv',
      '05-expenses.csv',
      '06-capital-purchases.csv',
      '07-bank-transactions.csv',
      '08-not-yet-reviewed.csv',
    ]) {
      assert.ok(files.has(name), `${name} is in the package`);
    }

    const byLine = rows(files.get('01-t2125-by-line.csv')!);
    const line = (code: string) => byLine.find((r) => r[0] === code);
    assert.equal(line('8000')![2], '100.00', 'gross sales before tax');
    assert.equal(line('9224 / 9281')![2], '74.66', 'fuel net of its HST');
    assert.equal(line('8523')![2], '10.00', 'half of a meal net of tax');
    assert.equal(line('9270')![2], '56.50', 'shovels from the bank, no receipt');

    const gst = rows(files.get('03-gst-hst-summary.csv')!);
    assert.deepEqual(gst.find((r) => r[0] === '105'), ['105', 'GST/HST collected on invoices', '13.00']);
    // 9.71 fuel + 1.30 (half the meal) + 130.00 blower.
    assert.deepEqual(gst.find((r) => r[0] === '108'), ['108', 'Input tax credits (from filed expenses)', '141.01']);

    const capital = rows(files.get('06-capital-purchases.csv')!);
    assert.equal(capital.length, 2, 'the blower, for CCA');
    assert.equal(capital[1]![10], '0.00', 'not deducted as an expense');

    const expenses = rows(files.get('05-expenses.csv')!);
    assert.equal(expenses.length, 4, 'fuel, meal and shovels; not last year, the blower or the waiting one');
    const waiting = files.get('08-not-yet-reviewed.csv')!.toString('utf8');
    assert.match(waiting, /999\.00/);
    assert.ok(!files.get('05-expenses.csv')!.toString('utf8').includes(pending.id.slice(0, 8)));

    const receipts = [...files.keys()].filter((n) => n.startsWith('receipts/'));
    assert.equal(receipts.length, 4, 'every 2026 receipt, the waiting one too');
    assert.deepEqual(files.get(receipts[0]!), PNG);

    const net = byLine.find((r) => r[1]!.startsWith('Net income'))!;
    assert.match(net[2]!, /^-?\d+\.\d{2}$/, 'a negative amount is a number, not escaped text');
    const readme = files.get('README.txt')!.toString('utf8');
    assert.match(readme, /1 expense\(s\) and 1 bank line\(s\) are still waiting for review/);
  });
});
