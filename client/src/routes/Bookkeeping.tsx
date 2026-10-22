import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Download, FileSpreadsheet, Paperclip, Pencil, RotateCw, ScanLine } from 'lucide-react';
import type { BankStatement, BankTransaction, Branch, Expense, ExpenseCategory } from '../../../src/types/models';
import { ConfirmDelete } from '@/components/ConfirmDelete';
import { DataTable } from '@/components/DataTable';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { StatRow, StatTile } from '@/components/Stat';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useAuth } from '@/auth/AuthContext';
import * as api from '@/lib/api';
import { count, date, isoDate, money } from '@/lib/format';
import { downloadDocument, formatBytes, openFile, uploadBlob } from '@/lib/upload';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';

interface CategoryInfo {
  code: ExpenseCategory;
  label: string;
  cra_line: string;
  help: string;
}

interface ExpenseView extends Omit<Expense, 'created_at' | 'updated_at'> {
  category_label: string;
  branch_name: string | null;
  created_by_name: string | null;
  created_at: string;
}

interface StatementView extends Omit<BankStatement, 'created_at' | 'updated_at' | 'processed_at'> {
  created_at: string;
  review_count: number;
  deductible_count: number;
}

type ReviewLine = Omit<BankTransaction, 'created_at' | 'updated_at'>;

const SORTS = [
  { value: 'recent', label: 'Recent' },
  { value: 'category', label: 'Category' },
  { value: 'amount_desc', label: 'Amount: High-to-Low' },
  { value: 'amount_asc', label: 'Amount: Low-to-High' },
] as const;
type Sort = (typeof SORTS)[number]['value'];

const RECEIPT_TYPES = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const STATEMENT_TYPES = '.pdf,.csv,application/pdf,text/csv';
const COMPANY_WIDE = 'company';

const SOURCE_LABELS: Record<ExpenseView['source'], string> = {
  manual: 'Entered',
  receipt_scan: 'Scanned',
  bank_statement: 'From bank',
};

/** Whole cents, so a column of totals adds up the way the accountant's will. */
function cents(value: string | number | null | undefined): number {
  return Math.round(Number(value ?? 0) * 100);
}

/**
 * The Business Console's books. Receipts and bank statements are read by
 * Claude and filed on their own; anything it was unsure of waits under "To
 * review" and stays out of the totals until someone approves it. "Add +"
 * still files one by hand, and the year-end export is the package for the
 * accountant.
 */
export function Bookkeeping(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const sort = (SORTS.some((s) => s.value === params.get('sort')) ? params.get('sort') : 'recent') as Sort;
  const [editing, setEditing] = React.useState<ExpenseView | 'new' | null>(null);
  const [prefillFile, setPrefillFile] = React.useState<File | null>(null);
  const [exporting, setExporting] = React.useState(false);

  const setSort = (value: string): void => {
    const next = new URLSearchParams(params);
    if (value === 'recent') next.delete('sort');
    else next.set('sort', value);
    setParams(next, { replace: true });
  };

  const { data, loading, error, reload } = useQuery(
    () =>
      Promise.all([
        api.get<ExpenseView[]>('/expenses', { sort }),
        api.get<CategoryInfo[]>('/expenses/categories'),
        api.get<Branch[]>('/branches'),
        api.get<{ enabled: boolean }>('/expenses/automation'),
        api.get<StatementView[]>('/expenses/statements'),
        api.get<ReviewLine[]>('/expenses/bank-transactions/review'),
      ]),
    [sort],
  );

  // While a statement is being read, look again every few seconds.
  const processing = data?.[4].some((s) => s.status === 'processing') ?? false;
  React.useEffect(() => {
    if (!processing) return undefined;
    const timer = setInterval(reload, 5000);
    return () => clearInterval(timer);
  }, [processing, reload]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [all, categories, branches, automation, statements, reviewLines] = data;
  const expenses = all.filter((e) => e.status === 'filed');
  const reviewExpenses = all.filter((e) => e.status === 'review');
  const total = expenses.reduce((sum, e) => sum + cents(e.amount), 0) / 100;
  const withReceipt = expenses.filter((e) => e.receipt_key).length;
  const thisYear = String(new Date().getFullYear());
  const yearTotal =
    expenses.filter((e) => e.spent_on.startsWith(thisYear)).reduce((sum, e) => sum + cents(e.amount), 0) / 100;
  const waiting = reviewExpenses.length + reviewLines.length;

  const addByHand = (file: File | null): void => {
    setPrefillFile(file);
    setEditing('new');
  };

  return (
    <>
      <PageHeader
        title="Bookkeeping"
        subtitle="Receipts and deductions, sorted by CRA T2125 category"
        actions={
          <>
            <Button type="button" variant="secondary" onClick={() => setExporting(true)}>
              <Download className="size-4" /> Year-end export
            </Button>
            <Button type="button" onClick={() => addByHand(null)}>
              Add +
            </Button>
          </>
        }
      />

      <StatRow>
        <StatTile label="Deductions logged" value={money(total)} note={`${count(expenses.length)} entries`} />
        <StatTile label={`This year (${thisYear})`} value={money(yearTotal)} />
        <StatTile
          label="Receipts attached"
          value={`${count(withReceipt)} of ${count(expenses.length)}`}
          note={expenses.length > withReceipt ? 'CRA can ask for any of them' : undefined}
        />
        <StatTile label="To review" value={count(waiting)} note={waiting ? 'not in the totals yet' : 'nothing waiting'} />
      </StatRow>

      <div className="mb-4 grid gap-4 lg:grid-cols-2">
        <ScanReceipts enabled={automation.enabled} branches={branches} onFiled={reload} onAddByHand={addByHand} />
        <ImportStatement enabled={automation.enabled} branches={branches} statements={statements} onChanged={reload} />
      </div>

      {waiting ? (
        <ToReview
          expenses={reviewExpenses}
          lines={reviewLines}
          categories={categories}
          onEdit={setEditing}
          onChanged={reload}
        />
      ) : null}

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="expense-sort">Sort by</Label>
          <Select value={sort} onValueChange={setSort}>
            <SelectTrigger id="expense-sort" className="w-52">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SORTS.map((s) => (
                <SelectItem key={s.value} value={s.value}>
                  {s.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* A table where there is room for one; a list of cards on a phone. */}
      <div className="max-[720px]:hidden">
        <DataTable
          rowKey={(row) => row.id}
          rows={expenses}
          emptyMessage="No deductions logged yet. Scan a receipt, import a statement, or press Add +."
          columns={[
            { header: 'Receipt', cell: (row) => <ReceiptIndicator expense={row} /> },
            {
              header: 'Category',
              cell: (row) => (
                <div className="min-w-40">
                  <p className="text-foreground">{row.category_label}</p>
                  {row.description || row.vendor ? (
                    <p className="text-xs text-muted-foreground">
                      {[row.vendor, row.description].filter(Boolean).join(' · ')}
                    </p>
                  ) : null}
                </div>
              ),
            },
            { header: 'Date', cell: (row) => <span className="whitespace-nowrap">{date(row.spent_on)}</span> },
            { header: 'Source', cell: (row) => <span className="text-xs text-muted-foreground">{SOURCE_LABELS[row.source]}</span> },
            { header: 'GST/HST', numeric: true, cell: (row) => (row.gst_hst === null ? '—' : money(row.gst_hst)) },
            { header: 'Business %', numeric: true, cell: (row) => `${row.deductible_percent}%` },
            { header: 'Amount', numeric: true, cell: (row) => money(row.amount) },
            { header: '', cell: (row) => <RowActions expense={row} onEdit={setEditing} onDeleted={reload} /> },
          ]}
        />
      </div>
      <ul className="hidden flex-col gap-2 max-[720px]:flex">
        {expenses.length === 0 ? (
          <li className="text-sm text-muted-foreground">No deductions logged yet. Scan a receipt or press Add +.</li>
        ) : null}
        {expenses.map((row) => (
          <li key={row.id} className="rounded-xl border border-border bg-card/60 p-3">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{row.category_label}</p>
                {row.description || row.vendor ? (
                  <p className="truncate text-xs text-muted-foreground">
                    {[row.vendor, row.description].filter(Boolean).join(' · ')}
                  </p>
                ) : null}
              </div>
              <p className="shrink-0 text-sm font-semibold tabular-nums text-foreground">{money(row.amount)}</p>
            </div>
            <div className="mt-2 flex items-center justify-between gap-2">
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <span>{date(row.spent_on)}</span>
                <span>{SOURCE_LABELS[row.source]}</span>
                <ReceiptIndicator expense={row} />
              </div>
              <RowActions expense={row} onEdit={setEditing} onDeleted={reload} />
            </div>
          </li>
        ))}
      </ul>

      <ExpenseDialog
        expense={editing}
        initialFile={prefillFile}
        onClose={() => {
          setEditing(null);
          setPrefillFile(null);
        }}
        categories={categories}
        branches={branches}
        onSaved={() => {
          setEditing(null);
          setPrefillFile(null);
          reload();
        }}
      />
      <ExportDialog open={exporting} onOpenChange={setExporting} waiting={waiting} />
    </>
  );
}

function RowActions({
  expense,
  onEdit,
  onDeleted,
}: {
  expense: ExpenseView;
  onEdit: (e: ExpenseView) => void;
  onDeleted: () => void;
}): JSX.Element {
  return (
    <div className="flex items-center gap-1">
      <Button type="button" variant="ghost" size="sm" aria-label="Edit" onClick={() => onEdit(expense)}>
        <Pencil className="size-3.5" />
      </Button>
      <ConfirmDelete
        what={`this ${expense.category_label.toLowerCase()} expense of ${money(expense.amount)}`}
        onConfirm={() => api.del(`/expenses/${expense.id}`)}
        onDeleted={onDeleted}
      />
    </div>
  );
}

function BranchPicker({
  value,
  onChange,
  branches,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  branches: Branch[];
  id: string;
}): JSX.Element | null {
  // A branch's own books: the server files everything against that branch.
  const { isCorporate } = useAuth();
  if (!isCorporate) return null;
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>Branch</Label>
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger id={id} className="w-48">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={COMPANY_WIDE}>Company-wide</SelectItem>
          {branches.map((b) => (
            <SelectItem key={b.id} value={b.id}>
              {b.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

const OFF_MESSAGE = 'Scanning is off until an Anthropic API key (ANTHROPIC_API_KEY) is set on the server.';

type ScanState =
  | { status: 'scanning' }
  | { status: 'filed' | 'review'; amount: string; label: string }
  | { status: 'failed'; message: string };

/** Pick one receipt or a pile of them; each is read and filed in turn. */
function ScanReceipts({
  enabled,
  branches,
  onFiled,
  onAddByHand,
}: {
  enabled: boolean;
  branches: Branch[];
  onFiled: () => void;
  onAddByHand: (file: File) => void;
}): JSX.Element {
  const [branch, setBranch] = React.useState(COMPANY_WIDE);
  const [results, setResults] = React.useState<{ file: File; state: ScanState }[]>([]);
  const [busy, setBusy] = React.useState(false);
  const input = React.useRef<HTMLInputElement>(null);

  const scanAll = async (files: File[]): Promise<void> => {
    setBusy(true);
    setResults(files.map((file) => ({ file, state: { status: 'scanning' } })));
    for (const [i, file] of files.entries()) {
      let state: ScanState;
      try {
        const key = await uploadBlob('receipt', file, file.name);
        const result = await api.post<{ expense: ExpenseView; outcome: 'filed' | 'review' }>('/expenses/scan', {
          receipt_key: key,
          branch_id: branch === COMPANY_WIDE ? null : branch,
        });
        state = {
          status: result.outcome,
          amount: result.expense.amount,
          label: [result.expense.vendor, result.expense.category_label].filter(Boolean).join(' · '),
        };
      } catch (err) {
        state = { status: 'failed', message: err instanceof Error ? err.message : String(err) };
      }
      setResults((r) => r.map((row, j) => (j === i ? { ...row, state } : row)));
      onFiled();
    }
    setBusy(false);
    if (input.current) input.current.value = '';
  };

  return (
    <Section title="Scan receipts">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          Photos or PDFs, as many as you like. Claude reads each one and files it with its category, GST/HST and business
          share. Anything it is unsure of waits under To review.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <BranchPicker id="scan-branch" value={branch} onChange={setBranch} branches={branches} />
          <input
            ref={input}
            type="file"
            multiple
            accept={RECEIPT_TYPES}
            className="hidden"
            onChange={(e) => {
              const files = [...(e.target.files ?? [])];
              if (files.length) void scanAll(files);
            }}
          />
          <Button type="button" disabled={!enabled || busy} onClick={() => input.current?.click()}>
            <ScanLine className="size-4" /> {busy ? 'Scanning…' : 'Scan receipts'}
          </Button>
        </div>
        {!enabled ? <p className="text-xs text-muted-foreground">{OFF_MESSAGE}</p> : null}
        {results.length ? (
          <ul className="flex flex-col gap-1.5">
            {results.map(({ file, state }, i) => (
              <li key={`${file.name}-${i}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
                <span className="min-w-0 truncate">{file.name}</span>
                {state.status === 'scanning' ? (
                  <span className="text-muted-foreground">Reading…</span>
                ) : state.status === 'failed' ? (
                  <span className="flex items-center gap-2">
                    <span className="text-critical">{state.message}</span>
                    <Button type="button" size="sm" variant="secondary" onClick={() => onAddByHand(file)}>
                      Add by hand
                    </Button>
                  </span>
                ) : (
                  <span className={state.status === 'review' ? 'text-warning' : 'text-foreground'}>
                    {money(state.amount)} · {state.label} · {state.status === 'review' ? 'to review' : 'filed'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </Section>
  );
}

function ImportStatement({
  enabled,
  branches,
  statements,
  onChanged,
}: {
  enabled: boolean;
  branches: Branch[];
  statements: StatementView[];
  onChanged: () => void;
}): JSX.Element {
  const [branch, setBranch] = React.useState(COMPANY_WIDE);
  const input = React.useRef<HTMLInputElement>(null);
  const { run, pending, error } = useSubmit(onChanged);

  const send = (file: File): void =>
    run(async () => {
      // Browsers disagree on what a .csv is; the server takes text/csv.
      const blob = file.name.toLowerCase().endsWith('.csv') ? new Blob([file], { type: 'text/csv' }) : file;
      const key = await uploadBlob('bank_statement', blob, file.name);
      await api.post('/expenses/statements', { file_key: key, branch_id: branch === COMPANY_WIDE ? null : branch });
      if (input.current) input.current.value = '';
    });

  return (
    <Section title="Bank and card statements">
      <div className="flex flex-col gap-3 text-sm">
        <p className="text-muted-foreground">
          The CSV your bank exports reads most reliably; a PDF statement works too. Every line is recorded; business costs
          are filed, matched to receipts already scanned, and anything unclear waits under To review.
        </p>
        <div className="flex flex-wrap items-end gap-3">
          <BranchPicker id="statement-branch" value={branch} onChange={setBranch} branches={branches} />
          <input
            ref={input}
            type="file"
            accept={STATEMENT_TYPES}
            className="hidden"
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) send(file);
            }}
          />
          <Button type="button" disabled={!enabled || pending} onClick={() => input.current?.click()}>
            <FileSpreadsheet className="size-4" /> {pending ? 'Uploading…' : 'Import statement'}
          </Button>
        </div>
        {!enabled ? <p className="text-xs text-muted-foreground">{OFF_MESSAGE}</p> : null}
        {error ? <ErrorNotice message={error} /> : null}
        {statements.length ? (
          <ul className="flex flex-col gap-1.5">
            {statements.slice(0, 8).map((s) => (
              <StatementRow key={s.id} statement={s} onChanged={onChanged} />
            ))}
          </ul>
        ) : null}
      </div>
    </Section>
  );
}

function StatementRow({ statement: s, onChanged }: { statement: StatementView; onChanged: () => void }): JSX.Element {
  const { run, pending, error } = useSubmit(onChanged);
  const period = s.period_start && s.period_end ? `${date(s.period_start)} – ${date(s.period_end)}` : null;
  return (
    <li className="rounded-lg border border-border px-3 py-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-foreground">{s.account_label ?? s.file_name ?? 'Statement'}</p>
          <p className="text-xs text-muted-foreground">
            {s.status === 'processing'
              ? 'Reading… this can take a minute or two.'
              : s.status === 'failed'
                ? (s.error ?? 'Could not be read.')
                : [period, `${s.transaction_count} lines`, `${s.deductible_count} business`, s.review_count ? `${s.review_count} to review` : null]
                    .filter(Boolean)
                    .join(' · ')}
          </p>
        </div>
        <div className="flex items-center gap-1">
          {s.status === 'failed' ? (
            <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run(() => api.post(`/expenses/statements/${s.id}/retry`))}>
              <RotateCw className="size-3.5" /> Retry
            </Button>
          ) : null}
          {s.status !== 'processing' ? (
            <ConfirmDelete
              what="this statement and the expenses filed from it (scanned receipts stay)"
              onConfirm={() => api.del(`/expenses/statements/${s.id}`)}
              onDeleted={onChanged}
            />
          ) : null}
        </div>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
    </li>
  );
}

function ToReview({
  expenses,
  lines,
  categories,
  onEdit,
  onChanged,
}: {
  expenses: ExpenseView[];
  lines: ReviewLine[];
  categories: CategoryInfo[];
  onEdit: (e: ExpenseView) => void;
  onChanged: () => void;
}): JSX.Element {
  return (
    <Section title={`To review (${expenses.length + lines.length})`} className="mb-4">
      <p className="mb-3 text-sm text-muted-foreground">
        Claude was not sure about these, so they are left out of the totals and the year-end export until you check them.
      </p>
      <ul className="flex flex-col gap-2">
        {expenses.map((e) => (
          <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-sm">
            <div className="min-w-0">
              <p className="text-foreground">
                {money(e.amount)} · {e.vendor ?? e.category_label} · {date(e.spent_on)}
              </p>
              <p className="text-xs text-warning">{e.review_note ?? 'Check the details.'}</p>
            </div>
            <div className="flex items-center gap-2">
              <ReceiptIndicator expense={e} />
              <Button type="button" size="sm" onClick={() => onEdit(e)}>
                Check and file
              </Button>
              <ConfirmDelete
                what={`this ${money(e.amount)} entry`}
                onConfirm={() => api.del(`/expenses/${e.id}`)}
                onDeleted={onChanged}
              />
            </div>
          </li>
        ))}
        {lines.map((line) => (
          <ReviewLineRow key={line.id} line={line} categories={categories} onChanged={onChanged} />
        ))}
      </ul>
    </Section>
  );
}

function ReviewLineRow({
  line,
  categories,
  onChanged,
}: {
  line: ReviewLine;
  categories: CategoryInfo[];
  onChanged: () => void;
}): JSX.Element {
  const [category, setCategory] = React.useState<string>(line.category ?? '');
  const { run, pending, error } = useSubmit(onChanged);
  const resolve = (decision: 'business' | 'personal' | 'transfer' | 'income') =>
    run(() =>
      api.post(`/expenses/bank-transactions/${line.id}/resolve`, {
        decision,
        ...(decision === 'business' ? { category } : {}),
      }),
    );

  return (
    <li className="rounded-lg border border-border px-3 py-2 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="text-foreground">
            {money(line.amount)} {line.direction === 'credit' ? 'in' : 'out'} · {line.vendor ?? line.description} ·{' '}
            {date(line.posted_on)}
          </p>
          <p className="text-xs text-muted-foreground">Bank line: {line.description}</p>
          {line.note ? <p className="text-xs text-warning">{line.note}</p> : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {line.direction === 'debit' ? (
            <>
              <Select value={category} onValueChange={setCategory}>
                <SelectTrigger className="w-48" aria-label="Category">
                  <SelectValue placeholder="Category" />
                </SelectTrigger>
                <SelectContent>
                  {categories.map((c) => (
                    <SelectItem key={c.code} value={c.code}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Button type="button" size="sm" disabled={pending || !category} onClick={() => resolve('business')}>
                Business
              </Button>
              <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => resolve('personal')}>
                Personal
              </Button>
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => resolve('transfer')}>
                Transfer
              </Button>
            </>
          ) : (
            <>
              <Button type="button" size="sm" disabled={pending} onClick={() => resolve('income')}>
                Income
              </Button>
              <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => resolve('transfer')}>
                Transfer / refund
              </Button>
            </>
          )}
        </div>
      </div>
      {error ? <ErrorNotice message={error} /> : null}
    </li>
  );
}

function ReceiptIndicator({ expense }: { expense: ExpenseView }): JSX.Element {
  const [error, setError] = React.useState<string | null>(null);
  if (!expense.receipt_key) {
    return <span className="text-xs text-muted-foreground">No receipt</span>;
  }
  const key = expense.receipt_key;
  return (
    <div className="flex flex-col">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="justify-start gap-1.5 px-1.5 text-primary"
        title={expense.receipt_file_name ?? 'Receipt'}
        onClick={() => {
          setError(null);
          openFile(key, expense.receipt_file_name ?? 'receipt').catch((err: unknown) =>
            setError(err instanceof Error ? err.message : String(err)),
          );
        }}
      >
        <Paperclip className="size-3.5" /> Attached
      </Button>
      {error ? <span className="text-xs text-critical">{error}</span> : null}
    </div>
  );
}

/** Adding one by hand, or checking and correcting one already in the books. */
function ExpenseDialog({
  expense,
  initialFile,
  onClose,
  categories,
  branches,
  onSaved,
}: {
  expense: ExpenseView | 'new' | null;
  initialFile: File | null;
  onClose: () => void;
  categories: CategoryInfo[];
  branches: Branch[];
  onSaved: () => void;
}): JSX.Element {
  const open = expense !== null;
  const existing = expense && expense !== 'new' ? expense : null;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        {open ? (
          <ExpenseForm
            key={existing?.id ?? 'new'}
            existing={existing}
            initialFile={initialFile}
            categories={categories}
            branches={branches}
            onCancel={onClose}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function ExpenseForm({
  existing,
  initialFile,
  categories,
  branches,
  onCancel,
  onSaved,
}: {
  existing: ExpenseView | null;
  initialFile: File | null;
  categories: CategoryInfo[];
  branches: Branch[];
  onCancel: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [file, setFile] = React.useState<File | null>(initialFile);
  const [category, setCategory] = React.useState<string>(existing?.category ?? '');
  const [amount, setAmount] = React.useState(existing?.amount ?? '');
  const [gstHst, setGstHst] = React.useState(existing?.gst_hst ?? '');
  const [percent, setPercent] = React.useState(existing ? String(existing.deductible_percent) : '');
  const [spentOn, setSpentOn] = React.useState(existing?.spent_on ?? isoDate());
  const [vendor, setVendor] = React.useState(existing?.vendor ?? '');
  const [description, setDescription] = React.useState(existing?.description ?? '');
  const [branch, setBranch] = React.useState(existing?.branch_id ?? COMPANY_WIDE);
  const { run, pending, error } = useSubmit(onSaved);

  const chosen = categories.find((c) => c.code === category);
  const isOther = category === 'other';
  const reviewing = existing?.status === 'review';
  const clean = (v: string) => v.replace(/[$,\s]/g, '');

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    const fields = {
      category,
      amount: clean(amount),
      spent_on: spentOn || null,
      vendor: vendor.trim() || null,
      description: description.trim() || null,
      branch_id: branch === COMPANY_WIDE ? null : branch,
      gst_hst: clean(gstHst) || null,
      ...(percent.trim() ? { deductible_percent: Number(percent) } : {}),
    };
    run(async () => {
      if (existing) {
        await api.patch(`/expenses/${existing.id}`, { ...fields, spent_on: spentOn, status: 'filed' });
      } else {
        const receiptKey = file ? await uploadBlob('receipt', file, file.name) : null;
        await api.post('/expenses', { ...fields, receipt_key: receiptKey });
      }
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{existing ? (reviewing ? 'Check and file' : 'Edit deduction') : 'Add a deduction'}</DialogTitle>
        <DialogDescription>
          {reviewing
            ? (existing.review_note ?? 'Check what Claude read, correct anything wrong, and file it.')
            : existing
              ? 'Correct anything that is wrong.'
              : 'Attach the receipt, pick what it was for, and enter the amount.'}
        </DialogDescription>
      </DialogHeader>

      <form onSubmit={submit} className="flex flex-col gap-4">
        {existing ? (
          existing.receipt_key ? <ReceiptIndicator expense={existing} /> : null
        ) : (
          <div className="flex flex-col gap-1">
            <Label htmlFor="expense-receipt">Attach receipt</Label>
            <input
              id="expense-receipt"
              type="file"
              accept={RECEIPT_TYPES}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground"
            />
            <p className="text-xs text-muted-foreground">
              {file ? `${file.name} — ${formatBytes(file.size)}` : 'PDF, JPG or PNG. A phone photo is fine.'}
            </p>
          </div>
        )}

        <div className="flex flex-col gap-1">
          <Label htmlFor="expense-category">Category</Label>
          <Select
            value={category}
            onValueChange={(v) => {
              setCategory(v);
              if (!percent.trim() || percent === '50' || percent === '100') setPercent(v === 'meals' ? '50' : '100');
            }}
          >
            <SelectTrigger id="expense-category">
              <SelectValue placeholder="What was it for?" />
            </SelectTrigger>
            <SelectContent>
              {categories.map((c) => (
                <SelectItem key={c.code} value={c.code}>
                  {c.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {chosen ? (
            <p className="text-xs text-muted-foreground">
              {chosen.help} {chosen.cra_line === 'CCA' ? '' : `T2125 line ${chosen.cra_line}.`}
            </p>
          ) : null}
        </div>

        <div className="grid grid-cols-2 gap-3 max-[480px]:grid-cols-1">
          <div className="flex flex-col gap-1">
            <Label htmlFor="expense-amount">Total paid, tax included ($)</Label>
            <Input
              id="expense-amount"
              inputMode="decimal"
              placeholder="0.00"
              autoComplete="off"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="expense-date">Date on receipt</Label>
            <Input id="expense-date" type="date" value={spentOn} onChange={(e) => setSpentOn(e.target.value)} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="expense-gst">GST/HST on the receipt ($)</Label>
            <Input
              id="expense-gst"
              inputMode="decimal"
              placeholder="Optional"
              autoComplete="off"
              value={gstHst}
              onChange={(e) => setGstHst(e.target.value)}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="expense-percent">Business share (%)</Label>
            <Input
              id="expense-percent"
              inputMode="numeric"
              placeholder={category === 'meals' ? '50' : '100'}
              value={percent}
              onChange={(e) => setPercent(e.target.value.replace(/[^\d]/g, '').slice(0, 3))}
            />
          </div>
        </div>

        <div className="grid grid-cols-2 gap-3 max-[480px]:grid-cols-1">
          <div className="flex flex-col gap-1">
            <Label htmlFor="expense-vendor">Vendor</Label>
            <Input id="expense-vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Optional" />
          </div>
          <BranchPicker id="expense-branch" value={branch} onChange={setBranch} branches={branches} />
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="expense-description">{isOther ? 'What was it?' : 'Note'}</Label>
          <Textarea
            id="expense-description"
            rows={2}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={isOther ? 'Required for Other' : 'Optional'}
            required={isOther}
          />
        </div>

        {error ? <ErrorNotice message={error} /> : null}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !category || !amount.trim()}>
            {pending ? (file ? 'Uploading…' : 'Saving…') : reviewing ? 'Approve and file' : 'Save'}
          </Button>
        </div>
      </form>
    </>
  );
}

function ExportDialog({
  open,
  onOpenChange,
  waiting,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  waiting: number;
}): JSX.Element {
  const now = new Date();
  // Early in the year, the year to file is last year.
  const [year, setYear] = React.useState(String(now.getMonth() < 4 ? now.getFullYear() - 1 : now.getFullYear()));
  const { run, pending, error } = useSubmit(() => onOpenChange(false));
  const years = Array.from({ length: 6 }, (_, i) => String(now.getFullYear() - i));

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Year-end export</DialogTitle>
          <DialogDescription>
            One ZIP for the accountant: T2125 totals by line and category, the GST/HST return figures, revenue from your
            invoices, every expense and bank line, capital purchases for CCA, and every receipt.
          </DialogDescription>
        </DialogHeader>
        <div className="flex flex-col gap-3 text-sm">
          <div className="flex flex-col gap-1">
            <Label htmlFor="export-year">Tax year</Label>
            <Select value={year} onValueChange={setYear}>
              <SelectTrigger id="export-year" className="w-32">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {years.map((y) => (
                  <SelectItem key={y} value={y}>
                    {y}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {waiting ? (
            <p className="text-warning">
              {waiting} item{waiting === 1 ? ' is' : 's are'} still waiting for review and will be left out of the totals.
              Review {waiting === 1 ? 'it' : 'them'} first for complete numbers.
            </p>
          ) : null}
          {error ? <ErrorNotice message={error} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              type="button"
              disabled={pending}
              onClick={() => run(() => downloadDocument(`/expenses/export?year=${year}`, `books-${year}.zip`))}
            >
              <Download className="size-4" /> {pending ? 'Preparing…' : 'Download ZIP'}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
