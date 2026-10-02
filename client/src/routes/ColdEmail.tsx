import * as React from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Branch, EmailLeadStatus, OptInSource } from '../../../src/types/models';
import { DataTable } from '@/components/DataTable';
import { Field, FieldList, ErrorNotice, Loading } from '@/components/Misc';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { StatRow, StatTile } from '@/components/Stat';
import { StatusPill } from '@/components/StatusPill';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
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
import * as api from '@/lib/api';
import { count, humanize, relative, stamp } from '@/lib/format';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';

interface DripStep {
  template_code: string;
  after_days: number;
  label: string;
}

interface LeadView {
  id: string;
  branch_id: string;
  branch_name: string;
  first_name: string;
  last_name: string | null;
  email: string;
  phone: string | null;
  source: OptInSource;
  status: EmailLeadStatus;
  steps_sent: number;
  next_send_at: string | null;
  opted_in_at: string;
  consent_text: string;
  campaign: string | null;
  emails_sent: number;
  next_step: string | null;
}

interface LeadDetail extends LeadView {
  messages: {
    id: string;
    template_code: string;
    subject: string | null;
    status: string;
    sent_at: string | null;
    created_at: string;
    error: string | null;
  }[];
}

type Stats = Record<EmailLeadStatus | OptInSource | 'total', number>;

const SOURCE_LABEL: Record<OptInSource, string> = {
  google_ads: 'Google Ads',
  door_to_door: 'Door-to-door',
};

const ANY = 'any';

/**
 * The cold email pipeline: who opted in, from where, and how far through the
 * follow-up sequence each person is. Sending is automatic — the confirmation
 * goes the moment somebody opts in, and the drip job sends the rest.
 */
export function ColdEmail(): JSX.Element {
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? '';
  const source = params.get('source') ?? '';
  const [adding, setAdding] = React.useState(false);
  const [openId, setOpenId] = React.useState<string | null>(null);

  const setParam = (key: string, value: string): void => {
    const next = new URLSearchParams(params);
    if (value && value !== ANY) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
  };

  const { data, loading, error, reload } = useQuery(
    () =>
      Promise.all([
        api.get<LeadView[]>('/cold-email/leads', { status: status || undefined, source: source || undefined }),
        api.get<Stats>('/cold-email/stats'),
        api.get<DripStep[]>('/cold-email/sequence'),
        api.get<Branch[]>('/branches'),
      ]),
    [status, source],
  );

  if (loading && !data) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [leads, stats, sequence, branches] = data;

  return (
    <>
      <PageHeader
        title="Cold Email"
        subtitle="Follow-up emails for people who opted in from Google Ads or at the door"
        actions={
          <Button type="button" onClick={() => setAdding(true)}>
            Add opt-in
          </Button>
        }
      />

      <StatRow>
        <StatTile label="In the sequence" value={count(stats.active)} note={`${count(stats.total)} opted in all told`} />
        <StatTile label="From Google Ads" value={count(stats.google_ads)} />
        <StatTile label="From door-to-door" value={count(stats.door_to_door)} />
        <StatTile
          label="Became customers"
          value={count(stats.converted)}
          note={`${count(stats.unsubscribed)} unsubscribed`}
        />
      </StatRow>

      <div className="mb-4 grid grid-cols-2 gap-4 max-[900px]:grid-cols-1">
        <Section title="The sequence">
          <ol className="flex flex-col gap-3">
            {sequence.map((step, i) => (
              <li key={step.template_code} className="flex items-start gap-3">
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-primary/15 text-xs font-semibold text-primary">
                  {i + 1}
                </span>
                <div>
                  <p className="text-sm font-medium text-foreground">{step.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {step.after_days === 0 ? 'The moment they opt in' : `${step.after_days} days after opting in`} ·{' '}
                    <code>{step.template_code}</code>
                  </p>
                </div>
              </li>
            ))}
          </ol>
          <p className="mt-4 text-xs text-muted-foreground">
            The sequence stops by itself when somebody unsubscribes or becomes an active customer. Every email carries
            an unsubscribe link, as CASL requires. The wording is in the message templates.
          </p>
        </Section>

        <LandingPageSetup branches={branches} />
      </div>

      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="lead-status">Status</Label>
          <Select value={status || ANY} onValueChange={(v) => setParam('status', v)}>
            <SelectTrigger id="lead-status" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any status</SelectItem>
              {(['active', 'completed', 'converted', 'unsubscribed'] as const).map((s) => (
                <SelectItem key={s} value={s}>
                  {humanize(s)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="lead-source">Source</Label>
          <Select value={source || ANY} onValueChange={(v) => setParam('source', v)}>
            <SelectTrigger id="lead-source" className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ANY}>Any source</SelectItem>
              <SelectItem value="google_ads">Google Ads</SelectItem>
              <SelectItem value="door_to_door">Door-to-door</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      <DataTable
        rowKey={(row) => row.id}
        rows={leads}
        onRowClick={(row) => setOpenId(row.id)}
        emptyMessage="Nobody has opted in yet. Google Ads sign-ups arrive on their own; door-to-door ones come from the leads map."
        columns={[
          {
            header: 'Name',
            cell: (row) => (
              <div>
                <p className="text-foreground">{[row.first_name, row.last_name].filter(Boolean).join(' ')}</p>
                <p className="text-xs text-muted-foreground">{row.email}</p>
              </div>
            ),
          },
          { header: 'Source', cell: (row) => SOURCE_LABEL[row.source] },
          { header: 'Branch', cell: (row) => row.branch_name },
          { header: 'Opted in', cell: (row) => relative(row.opted_in_at) },
          { header: 'Sent', numeric: true, cell: (row) => count(row.emails_sent) },
          {
            header: 'Next',
            cell: (row) =>
              row.next_step && row.next_send_at ? (
                <span className="text-xs">
                  {row.next_step}, {relative(row.next_send_at)}
                </span>
              ) : (
                <span className="text-xs text-muted-foreground">—</span>
              ),
          },
          { header: 'Status', cell: (row) => <StatusPill status={row.status} /> },
        ]}
      />

      <AddOptIn
        open={adding}
        onOpenChange={setAdding}
        branches={branches}
        onAdded={() => {
          setAdding(false);
          reload();
        }}
      />
      <LeadDialog id={openId} onClose={() => setOpenId(null)} onChanged={reload} />
    </>
  );
}

/** What to put on the Google Ads landing page so its sign-ups land here. */
function LandingPageSetup({ branches }: { branches: Branch[] }): JSX.Element {
  const [branch, setBranch] = React.useState(branches[0]?.id ?? '');
  const endpoint = `${window.location.origin}/public/opt-in`;
  const snippet = [
    `<form method="post" action="${endpoint}">`,
    `  <input type="hidden" name="branch_id" value="${branch}">`,
    `  <input type="hidden" name="utm_campaign" value="YOUR-CAMPAIGN">`,
    `  <input type="hidden" name="gclid" value=""> <!-- fill from the ?gclid= in the URL -->`,
    `  <input name="first_name" placeholder="First name" required>`,
    `  <input name="email" type="email" placeholder="Email" required>`,
    `  <label><input type="checkbox" name="consent" value="yes" required>`,
    `    I agree to receive emails about snow clearing. I can unsubscribe at any time.</label>`,
    `  <input name="website" style="display:none" tabindex="-1" autocomplete="off">`,
    `  <button type="submit">Get my quote</button>`,
    `</form>`,
  ].join('\n');

  return (
    <Section title="Google Ads landing page">
      <p className="mb-3 text-sm text-muted-foreground">
        Put this form on the page your ads point to. Each sign-up is confirmed by email straight away and enters the
        sequence. The hidden <code>website</code> field catches bots.
      </p>
      {branches.length > 1 ? (
        <div className="mb-3 flex flex-col gap-1">
          <Label htmlFor="snippet-branch">Branch the ad is for</Label>
          <Select value={branch} onValueChange={setBranch}>
            <SelectTrigger id="snippet-branch" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {branches.map((b) => (
                <SelectItem key={b.id} value={b.id}>
                  {b.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}
      <Textarea readOnly rows={9} value={snippet} className="font-mono text-[11px]" onFocus={(e) => e.target.select()} />
    </Section>
  );
}

function AddOptIn({
  open,
  onOpenChange,
  branches,
  onAdded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  branches: Branch[];
  onAdded: () => void;
}): JSX.Element {
  const empty = { first_name: '', last_name: '', email: '', phone: '', campaign: '' };
  const [form, setForm] = React.useState(empty);
  const [source, setSource] = React.useState<OptInSource>('door_to_door');
  const [branch, setBranch] = React.useState(branches[0]?.id ?? '');
  const [consent, setConsent] = React.useState(false);

  const { run, pending, error, clearError } = useSubmit(() => {
    setForm(empty);
    setConsent(false);
    onAdded();
  });

  const text = (key: keyof typeof empty, label: string, type = 'text', required = false) => (
    <div className="flex flex-col gap-1">
      <Label htmlFor={`optin-${key}`}>{label}</Label>
      <Input
        id={`optin-${key}`}
        type={type}
        required={required}
        value={form[key]}
        onChange={(e) => setForm({ ...form, [key]: e.target.value })}
      />
    </div>
  );

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
          <DialogTitle>Add an opt-in</DialogTitle>
          <DialogDescription>Somebody who said yes to hearing from us. Their confirmation email goes at once.</DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            run(() =>
              api.post('/cold-email/leads', {
                branch_id: branch,
                source,
                consent,
                first_name: form.first_name,
                last_name: form.last_name || null,
                email: form.email,
                phone: form.phone || null,
                campaign: form.campaign || null,
              }),
            );
          }}
        >
          <div className="grid grid-cols-2 gap-3 max-[480px]:grid-cols-1">
            {text('first_name', 'First name', 'text', true)}
            {text('last_name', 'Last name')}
            {text('email', 'Email', 'email', true)}
            {text('phone', 'Phone', 'tel')}
          </div>
          <div className="grid grid-cols-2 gap-3 max-[480px]:grid-cols-1">
            <div className="flex flex-col gap-1">
              <Label htmlFor="optin-source">Where they opted in</Label>
              <Select value={source} onValueChange={(v) => setSource(v as OptInSource)}>
                <SelectTrigger id="optin-source">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="door_to_door">Door-to-door</SelectItem>
                  <SelectItem value="google_ads">Google Ads</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {/* One branch to choose from is no choice: a branch adds to its own list. */}
            {branches.length > 1 ? (
              <div className="flex flex-col gap-1">
                <Label htmlFor="optin-branch">Branch</Label>
                <Select value={branch} onValueChange={setBranch}>
                  <SelectTrigger id="optin-branch">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
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
          {source === 'google_ads' ? text('campaign', 'Campaign') : null}
          <label className="flex items-start gap-2 text-sm">
            <Checkbox className="mt-0.5" checked={consent} onCheckedChange={(v) => setConsent(v === true)} />
            <span>They agreed to receive emails about snow clearing, and know they can unsubscribe at any time.</span>
          </label>
          {error ? <ErrorNotice message={error} /> : null}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" disabled={pending} onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !consent || !branch}>
              {pending ? 'Adding…' : 'Add and send confirmation'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function LeadDialog({
  id,
  onClose,
  onChanged,
}: {
  id: string | null;
  onClose: () => void;
  onChanged: () => void;
}): JSX.Element {
  const { data: lead, loading, error, reload } = useQuery(
    () => (id ? api.get<LeadDetail>(`/cold-email/leads/${id}`) : Promise.resolve(null)),
    [id],
  );
  const { run, pending, error: stopError } = useSubmit(() => {
    reload();
    onChanged();
  });

  return (
    <Dialog open={id !== null} onOpenChange={(next) => (!next ? onClose() : undefined)}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{lead ? [lead.first_name, lead.last_name].filter(Boolean).join(' ') : 'Lead'}</DialogTitle>
          <DialogDescription>{lead?.email ?? ''}</DialogDescription>
        </DialogHeader>
        {loading && !lead ? <Loading /> : null}
        {error ? <ErrorNotice message={error} /> : null}
        {lead ? (
          <div className="flex flex-col gap-4">
            <FieldList>
              <Field label="Status">
                <StatusPill status={lead.status} />
              </Field>
              <Field label="Source">{SOURCE_LABEL[lead.source]}</Field>
              <Field label="Opted in">{stamp(lead.opted_in_at)}</Field>
              <Field label="Branch">{lead.branch_name}</Field>
              {lead.phone ? <Field label="Phone">{lead.phone}</Field> : null}
              {lead.campaign ? <Field label="Campaign">{lead.campaign}</Field> : null}
            </FieldList>
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Consent</p>
              <p className="mt-0.5 text-sm text-foreground">{lead.consent_text}</p>
            </div>
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Emails</p>
              <ul className="flex flex-col gap-1.5">
                {lead.messages.map((m) => (
                  <li key={m.id} className="flex items-center justify-between gap-2 text-sm">
                    <span className="min-w-0 truncate">{m.subject ?? m.template_code}</span>
                    <span className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                      {stamp(m.sent_at ?? m.created_at)} <StatusPill status={m.status} />
                    </span>
                  </li>
                ))}
              </ul>
              {lead.next_step && lead.next_send_at ? (
                <p className="mt-2 text-xs text-muted-foreground">
                  Next: {lead.next_step}, {relative(lead.next_send_at)}.
                </p>
              ) : null}
            </div>
            {stopError ? <ErrorNotice message={stopError} /> : null}
            {lead.status === 'active' ? (
              <div className="flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  disabled={pending}
                  onClick={() => run(() => api.post(`/cold-email/leads/${lead.id}/stop`, { status: 'unsubscribed' }))}
                >
                  Stop emails
                </Button>
                <Button
                  type="button"
                  disabled={pending}
                  onClick={() => run(() => api.post(`/cold-email/leads/${lead.id}/stop`, { status: 'converted' }))}
                >
                  Mark as customer
                </Button>
              </div>
            ) : null}
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
