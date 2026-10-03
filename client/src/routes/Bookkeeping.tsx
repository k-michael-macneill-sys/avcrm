import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import { Paperclip } from 'lucide-react';
import type { Branch, Expense, ExpenseCategory } from '../../../src/types/models';
import { ConfirmDelete } from '@/components/ConfirmDelete';
import { DataTable } from '@/components/DataTable';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
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
import { formatBytes, openFile, uploadBlob } from '@/lib/upload';
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

const SORTS = [
  { value: 'recent', label: 'Recent' },
  { value: 'category', label: 'Category' },
  { value: 'amount_desc', label: 'Amount: High-to-Low' },
  { value: 'amount_asc', label: 'Amount: Low-to-High' },
] as const;
type Sort = (typeof SORTS)[number]['value'];

const RECEIPT_TYPES = '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png';
const COMPANY_WIDE = 'company';

/**
 * The Business Console's books: every deduction, with its receipt. "Add +"
 * files one; the list sorts the way an accountant asks for it.
 */
export function Bookkeeping(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const sort = (SORTS.some((s) => s.value === params.get('sort')) ? params.get('sort') : 'recent') as Sort;
  const [adding, setAdding] = React.useState(false);

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
      ]),
    [sort],
  );

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [expenses, categories, branches] = data;
  const total = expenses.reduce((sum, e) => sum + Math.round(Number(e.amount) * 100), 0) / 100;
  const withReceipt = expenses.filter((e) => e.receipt_key).length;
  const thisYear = String(new Date().getFullYear());
  const yearTotal =
    expenses
      .filter((e) => e.spent_on.startsWith(thisYear))
      .reduce((sum, e) => sum + Math.round(Number(e.amount) * 100), 0) / 100;

  return (
    <>
      <PageHeader
        title="Bookkeeping"
        subtitle="Receipts and deductions, sorted by CRA T2125 category"
        actions={
          <Button type="button" onClick={() => setAdding(true)}>
            Add +
          </Button>
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
      </StatRow>

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
          emptyMessage="No deductions logged yet. Press Add + to file the first receipt."
          columns={[
            {
              header: 'Receipt',
              cell: (row) => <ReceiptIndicator expense={row} />,
            },
            {
              header: 'Category',
              cell: (row) => (
                <div className="min-w-[10rem]">
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
            { header: 'Amount', numeric: true, cell: (row) => money(row.amount) },
            {
              header: '',
              cell: (row) => (
                <ConfirmDelete
                  what={`this ${row.category_label.toLowerCase()} expense of ${money(row.amount)}`}
                  onConfirm={() => api.del(`/expenses/${row.id}`)}
                  onDeleted={reload}
                />
              ),
            },
          ]}
        />
      </div>
      <ul className="hidden flex-col gap-2 max-[720px]:flex">
        {expenses.length === 0 ? (
          <li className="text-sm text-muted-foreground">No deductions logged yet. Press Add + to file the first receipt.</li>
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
              <ConfirmDelete
                what={`this ${row.category_label.toLowerCase()} expense of ${money(row.amount)}`}
                onConfirm={() => api.del(`/expenses/${row.id}`)}
                onDeleted={reload}
              />
            </div>
          </li>
        ))}
      </ul>

      <AddExpense
        open={adding}
        onOpenChange={setAdding}
        categories={categories}
        branches={branches}
        onAdded={() => {
          setAdding(false);
          reload();
        }}
      />
    </>
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

function AddExpense({
  open,
  onOpenChange,
  categories,
  branches,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  categories: CategoryInfo[];
  branches: Branch[];
  onAdded: () => void;
}): JSX.Element {
  const [file, setFile] = React.useState<File | null>(null);
  const [category, setCategory] = React.useState<string>('');
  const [amount, setAmount] = React.useState('');
  const [spentOn, setSpentOn] = React.useState(isoDate());
  const [vendor, setVendor] = React.useState('');
  const [description, setDescription] = React.useState('');
  const { isCorporate } = useAuth();
  const [branch, setBranch] = React.useState(COMPANY_WIDE);
  const fileInput = React.useRef<HTMLInputElement>(null);

  const reset = (): void => {
    setFile(null);
    setCategory('');
    setAmount('');
    setSpentOn(isoDate());
    setVendor('');
    setDescription('');
    setBranch(COMPANY_WIDE);
    if (fileInput.current) fileInput.current.value = '';
  };

  const { run, pending, error, clearError } = useSubmit(() => {
    reset();
    onAdded();
  });

  const chosen = categories.find((c) => c.code === category);
  const isOther = category === 'other';

  const submit = (event: React.FormEvent): void => {
    event.preventDefault();
    run(async () => {
      const receiptKey = file ? await uploadBlob('receipt', file, file.name) : null;
      await api.post('/expenses', {
        category,
        amount: amount.replace(/[$,\s]/g, ''),
        spent_on: spentOn || null,
        vendor: vendor.trim() || null,
        description: description.trim() || null,
        branch_id: branch === COMPANY_WIDE ? null : branch,
        receipt_key: receiptKey,
      });
    });
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (pending) return;
        if (!next) clearError();
        onOpenChange(next);
      }}
    >
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Add a deduction</DialogTitle>
          <DialogDescription>Attach the receipt, pick what it was for, and enter the amount.</DialogDescription>
        </DialogHeader>

        <form onSubmit={submit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <Label htmlFor="expense-receipt">Attach receipt</Label>
            <input
              id="expense-receipt"
              ref={fileInput}
              type="file"
              accept={RECEIPT_TYPES}
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              className="text-sm text-foreground file:mr-3 file:rounded-md file:border-0 file:bg-secondary file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-secondary-foreground"
            />
            <p className="text-xs text-muted-foreground">
              {file ? `${file.name} — ${formatBytes(file.size)}` : 'PDF, JPG or PNG. A phone photo is fine.'}
            </p>
          </div>

          <div className="flex flex-col gap-1">
            <Label htmlFor="expense-category">Category</Label>
            <Select value={category} onValueChange={setCategory}>
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
                {chosen.help} T2125 line {chosen.cra_line}.
              </p>
            ) : null}
          </div>

          <div className="grid grid-cols-2 gap-3 max-[480px]:grid-cols-1">
            <div className="flex flex-col gap-1">
              <Label htmlFor="expense-amount">Amount ($)</Label>
              <Input
                id="expense-amount"
                type="text"
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
          </div>

          <div className="grid grid-cols-2 gap-3 max-[480px]:grid-cols-1">
            <div className="flex flex-col gap-1">
              <Label htmlFor="expense-vendor">Vendor</Label>
              <Input id="expense-vendor" value={vendor} onChange={(e) => setVendor(e.target.value)} placeholder="Optional" />
            </div>
            {/* A branch's own books: the server files the expense against that branch. */}
            {isCorporate ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="expense-branch">Branch</Label>
                <Select value={branch} onValueChange={setBranch}>
                  <SelectTrigger id="expense-branch">
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
            ) : null}
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
            <Button type="button" variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !category || !amount.trim()}>
              {pending ? (file ? 'Uploading…' : 'Saving…') : 'Save'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
