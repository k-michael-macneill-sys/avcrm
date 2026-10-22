import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Check, ClipboardCopy, Download, FileText, Paperclip, Pencil, Upload } from 'lucide-react';
import type {
  BookkeepingDocument,
  BookkeepingDocumentKind,
  BookkeepingMonth,
  Branch,
  Expense,
  ExpenseCategory,
} from '../../../src/types/models';
import {
  amountToCents,
  centsToAmount,
  monthlyClosePrompt,
  parseCrmSummary,
  SUMMARY_TOTALS,
  type SummaryTotalField,
} from '../../../src/types/monthlyClose';
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

interface MonthView extends Omit<BookkeepingMonth, 'created_at' | 'updated_at' | 'totals_entered_at'> {
  branch_name: string | null;
  totals_entered_at: string | null;
  documents: (Omit<BookkeepingDocument, 'created_at'> & { created_at: string })[];
}

const SORTS = [
  { value: 'recent', label: 'Recent' },
  { value: 'category', label: 'Category' },
  { value: 'amount_desc', label: 'Amount: High-to-Low' },
  { value: 'amount_asc', label: 'Amount: Low-to-High' },
] as const;
type Sort = (typeof SORTS)[number]['value'];

const RECEIPT_TYPES = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const COMPANY_WIDE = 'company';

const DOCUMENT_LABELS: Record<BookkeepingDocumentKind, string> = {
  receipts: 'Receipts PDF',
  bank_statement: 'Statement',
  detail_csv: 'Detail CSV',
};

/** Whole cents, so a column of totals adds up the way the accountant's will. */
function cents(value: string | number | null | undefined): number {
  return Math.round(Number(value ?? 0) * 100);
}

/** Last month, YYYY-MM: the month a close is usually done for. */
function lastMonth(): string {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() - 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function monthLabel(month: string): string {
  const [y, m] = month.slice(0, 7).split('-').map(Number) as [number, number];
  return new Date(y, m - 1, 1).toLocaleDateString('en-CA', { month: 'long', year: 'numeric' });
}

/**
 * The Business Console's books. Once a month each branch closes its books in
 * an AI chat: the page gives the prompt, keeps the receipts PDF and the
 * statements, and takes the totals the chat works out. Single expenses can
 * still be entered with "Add +", and the year-end export is the package for
 * the accountant. No AI runs inside the CRM.
 */
export function Bookkeeping(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const sort = (SORTS.some((s) => s.value === params.get('sort')) ? params.get('sort') : 'recent') as Sort;
  const [editing, setEditing] = React.useState<ExpenseView | 'new' | null>(null);
  const [exporting, setExporting] = React.useState(false);
  const [entering, setEntering] = React.useState<{ branch_id: string | null; month: string } | null>(null);

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
        api.get<MonthView[]>('/expenses/months'),
      ]),
    [sort],
  );

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [expenses, categories, branches, months] = data;
  const thisYear = String(new Date().getFullYear());
  const yearMonths = months.filter((m) => m.month.startsWith(thisYear));
  const yearExpenses = expenses.filter((e) => e.spent_on.startsWith(thisYear));
  const singleDeductible = (e: ExpenseView) =>
    e.category === 'capital_purchase' ? 0 : Math.round((cents(e.amount) - cents(e.gst_hst)) * (e.deductible_percent / 100));
  const deductible =
    yearMonths.reduce((n, m) => n + cents(m.deductible_total), 0) + yearExpenses.reduce((n, e) => n + singleDeductible(e), 0);
  const itc =
    yearMonths.reduce((n, m) => n + cents(m.gst_hst_itc), 0) +
    yearExpenses.reduce((n, e) => n + Math.round(cents(e.gst_hst) * (e.deductible_percent / 100)), 0);
  const missingTotals = months.filter((m) => !m.totals_entered_at && m.documents.length).length;
  const entered = entering ? months.find((m) => m.month.startsWith(entering.month) && m.branch_id === entering.branch_id) ?? null : null;

  return (
    <>
      <PageHeader
        title="Bookkeeping"
        subtitle="Monthly receipts and statements, sorted by CRA T2125 category"
        actions={
          <>
            <Button type="button" variant="secondary" onClick={() => setExporting(true)}>
              <Download className="size-4" /> Year-end export
            </Button>
            <Button type="button" variant="secondary" onClick={() => setEditing('new')}>
              Add +
            </Button>
          </>
        }
      />

      <StatRow>
        <StatTile label={`Tax-deductible (${thisYear})`} value={money(deductible / 100)} note="monthly closes and single entries" />
        <StatTile label={`GST/HST to claim back (${thisYear})`} value={money(itc / 100)} />
        <StatTile label="Months closed" value={count(yearMonths.filter((m) => m.totals_entered_at).length)} note={`in ${thisYear}`} />
        <StatTile
          label="Totals still to enter"
          value={count(missingTotals)}
          note={missingTotals ? 'documents in, no totals yet' : 'all caught up'}
        />
      </StatRow>

      <MonthlyClose
        categories={categories}
        branches={branches}
        months={months}
        onChanged={reload}
        onEnterTotals={setEntering}
      />

      <Section title="Monthly closes" className="mb-6">
        <DataTable
          rowKey={(row) => row.id}
          rows={months}
          emptyMessage="No months closed yet. Start with the monthly close above."
          columns={[
            { header: 'Month', cell: (row) => <span className="whitespace-nowrap">{monthLabel(row.month)}</span> },
            { header: 'Branch', cell: (row) => row.branch_name ?? 'Company-wide' },
            {
              header: 'Files',
              cell: (row) => <span className="text-xs text-muted-foreground">{row.documents.map((d) => DOCUMENT_LABELS[d.kind]).join(', ') || 'None'}</span>,
            },
            { header: 'Deductible', numeric: true, cell: (row) => (row.totals_entered_at ? money(row.deductible_total) : '—') },
            { header: 'GST/HST back', numeric: true, cell: (row) => (row.totals_entered_at ? money(row.gst_hst_itc) : '—') },
            { header: 'Capital', numeric: true, cell: (row) => (row.totals_entered_at ? money(row.capital_purchases) : '—') },
            {
              header: '',
              cell: (row) => (
                <div className="flex items-center gap-1">
                  <Button
                    type="button"
                    size="sm"
                    variant={row.totals_entered_at ? 'ghost' : 'default'}
                    onClick={() => setEntering({ branch_id: row.branch_id, month: row.month.slice(0, 7) })}
                  >
                    {row.totals_entered_at ? <Pencil className="size-3.5" /> : 'Enter totals'}
                  </Button>
                  <ConfirmDelete
                    what={`${monthLabel(row.month)} for ${row.branch_name ?? 'company-wide'}, with its totals and file list`}
                    onConfirm={() => api.del(`/expenses/months/${row.id}`)}
                    onDeleted={reload}
                  />
                </div>
              ),
            },
          ]}
        />
      </Section>

      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold text-foreground">Single expenses</h2>
          <p className="text-sm text-muted-foreground">One-offs entered by hand with Add +, outside a monthly close.</p>
        </div>
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
          emptyMessage="No single expenses. Most months go through the monthly close above."
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
            { header: 'GST/HST', numeric: true, cell: (row) => (row.gst_hst === null ? '—' : money(row.gst_hst)) },
            { header: 'Business %', numeric: true, cell: (row) => `${row.deductible_percent}%` },
            { header: 'Amount', numeric: true, cell: (row) => money(row.amount) },
            { header: '', cell: (row) => <RowActions expense={row} onEdit={setEditing} onDeleted={reload} /> },
          ]}
        />
      </div>
      <ul className="hidden flex-col gap-2 max-[720px]:flex">
        {expenses.length === 0 ? (
          <li className="text-sm text-muted-foreground">No single expenses. Most months go through the monthly close above.</li>
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
                <ReceiptIndicator expense={row} />
              </div>
              <RowActions expense={row} onEdit={setEditing} onDeleted={reload} />
            </div>
          </li>
        ))}
      </ul>

      <ExpenseDialog
        expense={editing}
        initialFile={null}
        onClose={() => setEditing(null)}
        categories={categories}
        branches={branches}
        onSaved={() => {
          setEditing(null);
          reload();
        }}
      />
      <TotalsDialog
        target={entering}
        existing={entered}
        categories={categories}
        branches={branches}
        onClose={() => setEntering(null)}
        onSaved={() => {
          setEntering(null);
          reload();
        }}
      />
      <ExportDialog open={exporting} onOpenChange={setExporting} waiting={missingTotals} />
    </>
  );
}

/**
 * The month-end routine, in three steps: copy the prompt, file the documents,
 * enter what the chat worked out.
 */
function MonthlyClose({
  categories,
  branches,
  months,
  onChanged,
  onEnterTotals,
}: {
  categories: CategoryInfo[];
  branches: Branch[];
  months: MonthView[];
  onChanged: () => void;
  onEnterTotals: (target: { branch_id: string | null; month: string }) => void;
}): JSX.Element {
  const { isCorporate, branch: sessionBranch } = useAuth();
  const [branchChoice, setBranchChoice] = React.useState(COMPANY_WIDE);
  const [month, setMonth] = React.useState(lastMonth());
  const [copied, setCopied] = React.useState(false);

  // A branch's own sign-in closes its own books; corporate picks.
  const branchId = isCorporate ? (branchChoice === COMPANY_WIDE ? null : branchChoice) : (sessionBranch?.id ?? null);
  const branch = branches.find((b) => b.id === branchId) ?? null;
  const branchName = branch?.name ?? (isCorporate ? 'Company-wide' : (sessionBranch?.name ?? 'Company-wide'));
  const province = branch?.province ?? (isCorporate ? null : (sessionBranch?.province ?? null));
  const prompt = monthlyClosePrompt({ categories, branch_name: branchName, province, month });
  const current = months.find((m) => m.month.startsWith(month) && m.branch_id === branchId) ?? null;

  const copy = (): void => {
    void navigator.clipboard?.writeText(prompt).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2500);
    });
  };

  return (
    <Section title="Monthly close" className="mb-4">
      <div className="flex flex-col gap-5 text-sm">
        <div className="flex flex-wrap items-end gap-3">
          {isCorporate ? (
            <BranchPicker id="close-branch" value={branchChoice} onChange={setBranchChoice} branches={branches} />
          ) : null}
          <div className="flex flex-col gap-1">
            <Label htmlFor="close-month">Month</Label>
            <Input id="close-month" type="month" className="w-44" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
          </div>
          <p className="pb-2 text-muted-foreground">
            {branchName} · {monthLabel(month)}
            {current?.totals_entered_at ? ' · totals entered' : ''}
          </p>
        </div>

        <ol className="flex flex-col gap-5">
          <li className="flex flex-col gap-2">
            <p className="font-medium text-foreground">1. Scan and send</p>
            <p className="text-muted-foreground">
              Scan the month's receipts with the iPhone Notes app (Scan Documents) and share them as one PDF. Download the
              month's bank and credit card statements as PDFs. Then open ChatGPT or Claude, attach the receipts PDF and the
              statements, and paste this prompt. It is already set for {branchName} and {monthLabel(month)}.
            </p>
            <div className="flex flex-col gap-2">
              <div>
                <Button type="button" size="sm" onClick={copy}>
                  {copied ? <Check className="size-3.5" /> : <ClipboardCopy className="size-3.5" />}
                  {copied ? 'Copied' : 'Copy prompt'}
                </Button>
              </div>
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-lg border border-border bg-muted/40 p-3 text-xs leading-relaxed text-foreground">
                {prompt}
              </pre>
            </div>
          </li>

          <li className="flex flex-col gap-2">
            <p className="font-medium text-foreground">2. Keep the documents here</p>
            <p className="text-muted-foreground">
              Upload the same receipts PDF and statements, and the line-by-line CSV the chat gives you (Part 1, saved as a
              .csv file), so everything for the month is in one place for the accountant and the CRA.
            </p>
            <div className="flex flex-wrap gap-2">
              <DocumentUpload kind="receipts" label="Upload receipts PDF" accept=".pdf,application/pdf" branchId={branchId} month={month} onUploaded={onChanged} />
              <DocumentUpload kind="bank_statement" label="Upload bank / card statement" accept=".pdf,application/pdf" branchId={branchId} month={month} onUploaded={onChanged} multiple />
              <DocumentUpload kind="detail_csv" label="Upload detail CSV" accept=".csv,text/csv" branchId={branchId} month={month} onUploaded={onChanged} />
            </div>
            {current?.documents.length ? (
              <ul className="flex flex-col gap-1">
                {current.documents.map((d) => (
                  <li key={d.id} className="flex items-center justify-between gap-2 rounded-lg border border-border px-3 py-1.5">
                    <button
                      type="button"
                      className="flex min-w-0 items-center gap-2 text-left text-primary hover:underline"
                      onClick={() => void openFile(d.file_key, d.file_name ?? DOCUMENT_LABELS[d.kind])}
                    >
                      <FileText className="size-3.5 shrink-0" />
                      <span className="truncate">
                        {DOCUMENT_LABELS[d.kind]}: {d.file_name ?? 'file'}
                      </span>
                    </button>
                    <ConfirmDelete what={`this ${DOCUMENT_LABELS[d.kind].toLowerCase()}`} onConfirm={() => api.del(`/expenses/months/documents/${d.id}`)} onDeleted={onChanged} />
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-xs text-muted-foreground">Nothing uploaded for this month yet.</p>
            )}
          </li>

          <li className="flex flex-col gap-2">
            <p className="font-medium text-foreground">3. Enter the totals</p>
            <p className="text-muted-foreground">
              Copy the chat's CRM SUMMARY block (Part 2) and paste it into the form; it fills itself in. Check Part 3 for
              anything the chat could not read.
            </p>
            <div>
              <Button type="button" onClick={() => onEnterTotals({ branch_id: branchId, month })}>
                {current?.totals_entered_at ? 'Change the totals' : 'Enter the totals'}
              </Button>
            </div>
          </li>
        </ol>
      </div>
    </Section>
  );
}

function DocumentUpload({
  kind,
  label,
  accept,
  branchId,
  month,
  onUploaded,
  multiple = false,
}: {
  kind: BookkeepingDocumentKind;
  label: string;
  accept: string;
  branchId: string | null;
  month: string;
  onUploaded: () => void;
  multiple?: boolean;
}): JSX.Element {
  const input = React.useRef<HTMLInputElement>(null);
  const { run, pending, error } = useSubmit(onUploaded);

  const send = (files: File[]): void =>
    run(async () => {
      for (const file of files) {
        // Browsers disagree on what a .csv is; the server takes text/csv.
        const blob = file.name.toLowerCase().endsWith('.csv') ? new Blob([file], { type: 'text/csv' }) : file;
        const key = await uploadBlob('bookkeeping_document', blob, file.name);
        await api.post('/expenses/months/documents', { branch_id: branchId, month, kind, file_key: key });
      }
      if (input.current) input.current.value = '';
    });

  return (
    <div className="flex flex-col gap-1">
      <input
        ref={input}
        type="file"
        accept={accept}
        multiple={multiple}
        className="hidden"
        onChange={(e) => {
          const files = [...(e.target.files ?? [])];
          if (files.length) send(files);
        }}
      />
      <Button type="button" variant="secondary" disabled={pending} onClick={() => input.current?.click()}>
        <Upload className="size-4" /> {pending ? 'Uploading…' : label}
      </Button>
      {error ? <span className="max-w-64 text-xs text-critical">{error}</span> : null}
    </div>
  );
}

type TotalsForm = {
  categories: Partial<Record<ExpenseCategory, string>>;
  totals: Record<SummaryTotalField, string>;
  no_receipt_count: string;
  notes: string;
};

function emptyForm(existing: MonthView | null): TotalsForm {
  return {
    categories: { ...(existing?.category_amounts ?? {}) },
    totals: {
      deductible_total: existing?.totals_entered_at ? existing.deductible_total : '',
      gst_hst_itc: existing?.totals_entered_at ? existing.gst_hst_itc : '',
      capital_purchases: existing?.totals_entered_at ? existing.capital_purchases : '',
      non_deductible: existing?.totals_entered_at ? existing.non_deductible : '',
      no_receipt_total: existing?.totals_entered_at ? existing.no_receipt_total : '',
    },
    no_receipt_count: existing?.totals_entered_at ? String(existing.no_receipt_count) : '',
    notes: existing?.notes ?? '',
  };
}

/** The pop-up for a month's totals: paste the chat's summary, check, save. */
function TotalsDialog({
  target,
  existing,
  categories,
  branches,
  onClose,
  onSaved,
}: {
  target: { branch_id: string | null; month: string } | null;
  existing: MonthView | null;
  categories: CategoryInfo[];
  branches: Branch[];
  onClose: () => void;
  onSaved: () => void;
}): JSX.Element {
  return (
    <Dialog open={target !== null} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        {target ? (
          <TotalsFormBody
            key={`${target.branch_id}-${target.month}`}
            target={target}
            existing={existing}
            categories={categories}
            branchName={branches.find((b) => b.id === target.branch_id)?.name ?? existing?.branch_name ?? 'Company-wide'}
            onCancel={onClose}
            onSaved={onSaved}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function TotalsFormBody({
  target,
  existing,
  categories,
  branchName,
  onCancel,
  onSaved,
}: {
  target: { branch_id: string | null; month: string };
  existing: MonthView | null;
  categories: CategoryInfo[];
  branchName: string;
  onCancel: () => void;
  onSaved: () => void;
}): JSX.Element {
  const [form, setForm] = React.useState<TotalsForm>(() => emptyForm(existing));
  const [pasted, setPasted] = React.useState('');
  const [notice, setNotice] = React.useState<{ tone: 'good' | 'warn'; text: string } | null>(null);
  const { run, pending, error } = useSubmit(onSaved);
  const expenseCategories = categories.filter((c) => c.code !== 'capital_purchase');

  const categorySum = expenseCategories.reduce((n, c) => n + (amountToCents(form.categories[c.code] || '0') ?? 0), 0);
  const statedTotal = amountToCents(form.totals.deductible_total || '');
  const mismatch = statedTotal !== null && statedTotal !== categorySum;

  const fill = (): void => {
    const parsed = parseCrmSummary(pasted, categories);
    const found = Object.keys(parsed.categories).length + Object.keys(parsed.totals).length;
    if (!found) {
      setNotice({ tone: 'warn', text: 'No summary found. Paste the whole CRM SUMMARY block (Part 2), including the lines like FUEL: 123.45.' });
      return;
    }
    setForm({
      categories: Object.fromEntries(
        expenseCategories.map((c) => [c.code, parsed.categories[c.code] !== undefined ? centsToAmount(parsed.categories[c.code]!) : '']),
      ),
      totals: Object.fromEntries(
        SUMMARY_TOTALS.map((t) => [t.field, parsed.totals[t.field] !== undefined ? centsToAmount(parsed.totals[t.field]!) : '']),
      ) as Record<SummaryTotalField, string>,
      no_receipt_count: parsed.no_receipt_count !== null ? String(parsed.no_receipt_count) : '',
      notes: parsed.notes ?? '',
    });
    const warnings: string[] = [];
    if (parsed.month && parsed.month !== target.month) warnings.push(`The summary is for ${parsed.month}, not ${target.month}.`);
    if (parsed.branch && parsed.branch.toLowerCase() !== branchName.toLowerCase()) {
      warnings.push(`The summary says ${parsed.branch}, not ${branchName}.`);
    }
    if (parsed.problems.length) warnings.push(`Could not read: ${parsed.problems.join('; ')}`);
    setNotice(
      warnings.length
        ? { tone: 'warn', text: warnings.join(' ') }
        : { tone: 'good', text: `Filled in ${found} amounts. Check them against the chat before saving.` },
    );
  };

  const amountField = (id: string, label: string, value: string, onChange: (v: string) => void, help?: string) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input id={id} inputMode="decimal" placeholder="0.00" autoComplete="off" value={value} onChange={(e) => onChange(e.target.value)} />
      {help ? <span className="text-xs text-muted-foreground">{help}</span> : null}
    </div>
  );

  const save = (event: React.FormEvent): void => {
    event.preventDefault();
    const clean = (v: string) => v.replace(/[$,\s]/g, '') || '0';
    run(() =>
      api.put('/expenses/months', {
        branch_id: target.branch_id,
        month: target.month,
        category_amounts: Object.fromEntries(
          expenseCategories.filter((c) => (form.categories[c.code] ?? '').trim()).map((c) => [c.code, clean(form.categories[c.code]!)]),
        ),
        gst_hst_itc: clean(form.totals.gst_hst_itc),
        capital_purchases: clean(form.totals.capital_purchases),
        non_deductible: clean(form.totals.non_deductible),
        no_receipt_total: clean(form.totals.no_receipt_total),
        no_receipt_count: form.no_receipt_count.trim() || '0',
        notes: form.notes.trim() || null,
      }),
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          Totals for {monthLabel(target.month)}, {branchName}
        </DialogTitle>
        <DialogDescription>Paste the chat's CRM SUMMARY to fill this in, or type the numbers from it.</DialogDescription>
      </DialogHeader>

      <form onSubmit={save} className="flex flex-col gap-4 text-sm">
        <div className="flex flex-col gap-2">
          <Label htmlFor="summary-paste">Paste the CRM SUMMARY (Part 2)</Label>
          <Textarea
            id="summary-paste"
            rows={4}
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            placeholder={'BRANCH: ...\nMONTH: ...\nFUEL: 412.50\n...'}
            className="font-mono text-xs"
          />
          <div>
            <Button type="button" variant="secondary" size="sm" disabled={!pasted.trim()} onClick={fill}>
              Fill in from summary
            </Button>
          </div>
          {notice ? <p className={notice.tone === 'good' ? 'text-good' : 'text-warning'}>{notice.text}</p> : null}
        </div>

        <div className="grid gap-3 rounded-xl border border-border p-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label>Total tax-deductible expenses</Label>
            <p className="text-lg font-semibold tabular-nums text-foreground">{money(categorySum / 100)}</p>
            <span className={mismatch ? 'text-xs text-warning' : 'text-xs text-muted-foreground'}>
              {mismatch
                ? `The chat's total was ${money((statedTotal ?? 0) / 100)}: the categories below do not add up to it. Check them.`
                : 'The sum of the categories below.'}
            </span>
          </div>
          {amountField('totals-itc', 'GST/HST to claim back (ITCs)', form.totals.gst_hst_itc, (v) => setForm((f) => ({ ...f, totals: { ...f.totals, gst_hst_itc: v } })), 'From receipts only. Never PST.')}
          {amountField('totals-capital', 'Capital purchases (for CCA)', form.totals.capital_purchases, (v) => setForm((f) => ({ ...f, totals: { ...f.totals, capital_purchases: v } })), 'Equipment and vehicles, before GST/HST.')}
          {amountField('totals-personal', 'Personal / not deductible', form.totals.non_deductible, (v) => setForm((f) => ({ ...f, totals: { ...f.totals, non_deductible: v } })))}
          {amountField('totals-noreceipt', 'Business costs with no receipt', form.totals.no_receipt_total, (v) => setForm((f) => ({ ...f, totals: { ...f.totals, no_receipt_total: v } })), 'Claimed in full, no GST/HST back.')}
          <div className="flex flex-col gap-1">
            <Label htmlFor="totals-noreceipt-count">How many with no receipt</Label>
            <Input id="totals-noreceipt-count" inputMode="numeric" placeholder="0" value={form.no_receipt_count} onChange={(e) => setForm((f) => ({ ...f, no_receipt_count: e.target.value.replace(/[^\d]/g, '') }))} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <p className="font-medium text-foreground">Amount to claim by category</p>
          <div className="grid gap-3 sm:grid-cols-2">
            {expenseCategories.map((c) =>
              amountField(
                `totals-${c.code}`,
                `${c.label} (${c.cra_line})`,
                form.categories[c.code] ?? '',
                (v) => setForm((f) => ({ ...f, categories: { ...f.categories, [c.code]: v } })),
              ),
            )}
          </div>
        </div>

        <div className="flex flex-col gap-1">
          <Label htmlFor="totals-notes">Notes for the accountant</Label>
          <Textarea id="totals-notes" rows={2} value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))} placeholder="Optional" />
        </div>

        {error ? <ErrorNotice message={error} /> : null}
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" disabled={pending} onClick={onCancel}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending}>
            {pending ? 'Saving…' : 'Save totals'}
          </Button>
        </div>
      </form>
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
        await api.patch(`/expenses/${existing.id}`, { ...fields, spent_on: spentOn });
      } else {
        const receiptKey = file ? await uploadBlob('receipt', file, file.name) : null;
        await api.post('/expenses', { ...fields, receipt_key: receiptKey });
      }
    });
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>{existing ? 'Edit deduction' : 'Add a deduction'}</DialogTitle>
        <DialogDescription>
          {existing ? 'Correct anything that is wrong.' : 'Attach the receipt, pick what it was for, and enter the amount.'}
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
            {pending ? (file ? 'Uploading…' : 'Saving…') : 'Save'}
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
  /** Months with documents in but no totals entered. */
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
            invoices, every monthly close with its receipts PDF and statements, capital purchases for CCA, and every
            single expense with its receipt.
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
              {waiting} month{waiting === 1 ? ' has' : 's have'} documents but no totals entered yet, so the totals will be
              short. Enter {waiting === 1 ? 'it' : 'them'} first for complete numbers.
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
