import * as React from 'react';
import { Link } from 'react-router-dom';
import { Plus, Save } from 'lucide-react';
import type { Branch } from '../../../src/types/models';
import { ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import type { Lookups } from '@/lib/agreements';
import * as api from '@/lib/api';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';

/**
 * The lists the contract form is built from, edited without a deploy:
 * relabel, reorder, switch off, add. Nothing is ever deleted — a contract
 * signed against a retired option still says what it was.
 */

type Kind = 'text' | 'number' | 'money' | 'bool' | 'select';
interface Extra {
  name: string;
  label: string;
  kind: Kind;
  options?: { value: string; label: string }[];
}

const NONE = '__none__';

const TABLES: { table: keyof Lookups; title: string; help: string; extras: Extra[] }[] = [
  {
    table: 'contract_types',
    title: 'Contract types',
    help: 'The agreement names on the contract form. Paper types skip e-signing and take an uploaded scan.',
    extras: [
      { name: 'seasons', label: 'Seasons', kind: 'number' },
      {
        name: 'agreement_medium',
        label: 'Agreement',
        kind: 'select',
        options: [
          { value: 'electronic', label: 'Electronic' },
          { value: 'paper', label: 'Paper' },
        ],
      },
      { name: 'is_switch_over', label: 'Switch over', kind: 'bool' },
    ],
  },
  {
    table: 'billing_plans',
    title: 'Billing plans',
    help: 'What each plan does is fixed by its behaviour; the label, number of payments and early termination fee are yours.',
    extras: [
      {
        name: 'kind',
        label: 'Behaviour',
        kind: 'select',
        options: [
          { value: 'seasonal_installments', label: 'Season in monthly payments' },
          { value: 'seasonal_yia', label: 'Season paid in full (YIA)' },
          { value: 'monthly_recurring', label: 'Month to month' },
          { value: 'monthly_one_time', label: 'One month' },
        ],
      },
      { name: 'installments_per_season', label: 'Payments / season', kind: 'number' },
      { name: 'early_termination_fee', label: 'Early termination fee', kind: 'money' },
    ],
  },
  { table: 'scope_items', title: 'Scope of service', help: 'The areas a crew clears.', extras: [] },
  {
    table: 'addon_services',
    title: 'Add-on services',
    help: 'Extra services, each with the price the form starts from.',
    extras: [{ name: 'default_price', label: 'Default price', kind: 'money' }],
  },
  {
    table: 'contract_tags',
    title: 'Tags',
    help: 'YIA switches the agreement to pay-in-full; Referral credits the customer who referred them.',
    extras: [
      {
        name: 'kind',
        label: 'Behaviour',
        kind: 'select',
        options: [
          { value: NONE, label: 'None' },
          { value: 'yia', label: 'YIA (paid in full)' },
          { value: 'referral', label: 'Referral' },
          { value: 'route_code', label: 'Route code added' },
        ],
      },
    ],
  },
  {
    table: 'tax_codes',
    title: 'Tax codes',
    help: 'Rate as a fraction (0.13 is 13%). A new contract starts on the default for its branch’s province.',
    extras: [
      { name: 'rate', label: 'Rate', kind: 'text' },
      { name: 'province', label: 'Province', kind: 'text' },
      { name: 'is_default', label: 'Default', kind: 'bool' },
    ],
  },
  {
    table: 'service_routes',
    title: 'Routes',
    help: 'The routes operators drive. A route with no branch is offered to every branch.',
    extras: [{ name: 'branch_id', label: 'Branch', kind: 'select' }],
  },
];

export function ContractLists(): JSX.Element {
  const { data, loading, error, reload } = useQuery(
    () => Promise.all([api.get<Lookups>('/lookups', { include_inactive: 'true' }), api.get<Branch[]>('/branches')]),
    [],
  );
  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;
  const [lookups, branches] = data;
  const branchOptions = [{ value: NONE, label: 'Every branch' }, ...branches.map((b) => ({ value: b.id, label: b.name }))];

  return (
    <>
      <PageHeader
        title="Contract lists"
        subtitle="The choices on the contract form and the agreement."
        actions={
          <Button asChild variant="secondary">
            <Link to="/settings">Settings</Link>
          </Button>
        }
      />
      <div className="flex flex-col gap-4">
        {TABLES.map((spec) => (
          <Section key={spec.table} title={spec.title}>
            <p className="mb-3 text-sm text-muted-foreground">{spec.help}</p>
            <LookupEditor
              table={spec.table}
              rows={lookups[spec.table] as unknown as Record<string, unknown>[]}
              extras={spec.extras.map((e) => (e.name === 'branch_id' ? { ...e, options: branchOptions } : e))}
              onChanged={reload}
            />
          </Section>
        ))}
      </div>
    </>
  );
}

type Draft = Record<string, string | boolean>;

function toDraft(row: Record<string, unknown>, extras: Extra[]): Draft {
  const draft: Draft = { label: String(row.label ?? ''), active: row.active !== false, sort_order: String(row.sort_order ?? '') };
  for (const e of extras) {
    const value = row[e.name];
    draft[e.name] = e.kind === 'bool' ? value === true : value === null || value === undefined ? (e.kind === 'select' ? NONE : '') : String(value);
  }
  return draft;
}

function toBody(draft: Draft, extras: Extra[]): Record<string, unknown> {
  const body: Record<string, unknown> = { label: draft.label, active: draft.active };
  if (draft.sort_order !== '') body.sort_order = Number(draft.sort_order);
  for (const e of extras) {
    const value = draft[e.name];
    if (e.kind === 'bool') body[e.name] = value === true;
    else if (e.kind === 'number') body[e.name] = Number(value);
    else if (value === '' || value === NONE) body[e.name] = null;
    else body[e.name] = e.name === 'province' ? String(value).toUpperCase() : value;
  }
  return body;
}

function LookupEditor({
  table,
  rows,
  extras,
  onChanged,
}: {
  table: string;
  rows: Record<string, unknown>[];
  extras: Extra[];
  onChanged: () => void;
}): JSX.Element {
  const [drafts, setDrafts] = React.useState<Record<string, Draft>>({});
  const [adding, setAdding] = React.useState<Draft | null>(null);
  const [code, setCode] = React.useState('');
  const { run, pending, error } = useSubmit(() => {
    setDrafts({});
    setAdding(null);
    setCode('');
    onChanged();
  });

  const draftOf = (row: Record<string, unknown>): Draft => drafts[String(row.id)] ?? toDraft(row, extras);
  const edit = (id: string, row: Record<string, unknown>, key: string, value: string | boolean) =>
    setDrafts((d) => ({ ...d, [id]: { ...(d[id] ?? toDraft(row, extras)), [key]: value } }));

  const cell = (draft: Draft, key: string, kind: Kind, change: (v: string | boolean) => void, options?: Extra['options']) => {
    if (kind === 'bool') return <Checkbox checked={draft[key] === true} onCheckedChange={(v) => change(v === true)} aria-label={key} />;
    if (kind === 'select') {
      return (
        <Select value={String(draft[key] || NONE)} onValueChange={change}>
          <SelectTrigger className="h-8 min-w-[150px]" aria-label={key}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {(options ?? []).map((o) => (
              <SelectItem key={o.value} value={o.value}>
                {o.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      );
    }
    return (
      <Input
        className={kind === 'text' && key === 'label' ? 'h-8 w-full min-w-[320px]' : 'h-8 w-24'}
        value={String(draft[key] ?? '')}
        inputMode={kind === 'number' || kind === 'money' ? 'decimal' : undefined}
        onChange={(e) => change(e.target.value)}
        aria-label={key}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Label</TableHead>
              {extras.map((e) => (
                <TableHead key={e.name}>{e.label}</TableHead>
              ))}
              <TableHead>Order</TableHead>
              <TableHead>Active</TableHead>
              <TableHead />
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => {
              const id = String(row.id);
              const draft = draftOf(row);
              const dirty = !!drafts[id];
              return (
                <TableRow key={id} className={draft.active ? undefined : 'opacity-60'}>
                  <TableCell>
                    {cell(draft, 'label', 'text', (v) => edit(id, row, 'label', v))}
                    <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">{String(row.code)}</span>
                  </TableCell>
                  {extras.map((e) => (
                    <TableCell key={e.name}>{cell(draft, e.name, e.kind, (v) => edit(id, row, e.name, v), e.options)}</TableCell>
                  ))}
                  <TableCell>{cell(draft, 'sort_order', 'number', (v) => edit(id, row, 'sort_order', v))}</TableCell>
                  <TableCell>{cell(draft, 'active', 'bool', (v) => edit(id, row, 'active', v))}</TableCell>
                  <TableCell>
                    <Button
                      type="button"
                      size="sm"
                      variant={dirty ? 'default' : 'ghost'}
                      disabled={!dirty || pending}
                      onClick={() => run(() => api.patch(`/lookups/${table}/${id}`, toBody(draft, extras)))}
                    >
                      <Save className="size-3.5" /> Save
                    </Button>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {adding ? (
        <div className="flex flex-wrap items-end gap-2 rounded-xl border border-border bg-card/40 p-3">
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Code
            <Input className="h-8 w-40 font-mono" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. deck_path" />
          </label>
          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Label
            {cell(adding, 'label', 'text', (v) => setAdding({ ...adding, label: v }))}
          </label>
          {extras.map((e) => (
            <label key={e.name} className="flex flex-col gap-1 text-xs text-muted-foreground">
              {e.label}
              {cell(adding, e.name, e.kind, (v) => setAdding({ ...adding, [e.name]: v }), e.options)}
            </label>
          ))}
          <Button
            type="button"
            size="sm"
            disabled={pending || !code.trim() || !String(adding.label).trim()}
            onClick={() => run(() => api.post(`/lookups/${table}`, { code: code.trim(), ...toBody(adding, extras) }))}
          >
            Add
          </Button>
          <Button type="button" size="sm" variant="ghost" onClick={() => setAdding(null)}>
            Cancel
          </Button>
        </div>
      ) : (
        <Button type="button" size="sm" variant="secondary" className="w-fit" onClick={() => setAdding(toDraft({}, extras))}>
          <Plus className="size-3.5" /> Add
        </Button>
      )}
      {error ? <ErrorNotice message={error} /> : null}
    </div>
  );
}

