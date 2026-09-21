import * as React from 'react';
import { PageHeader } from '@/components/PageHeader';
import { Section } from '@/components/Section';
import { DataFormFields, type FieldSpec } from '@/components/DataForm';
import { Field, FieldList, Loading, ErrorNotice } from '@/components/Misc';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useQuery } from '@/lib/useQuery';
import { useSubmit } from '@/lib/useSubmit';
import * as api from '@/lib/api';
import { stamp } from '@/lib/format';

/**
 * Where an administrator connects an outside service.
 *
 * The screen renders itself from the catalogue the server publishes, so
 * adding a provider on the server adds it here with no change to this file.
 * Credentials are write-only: a stored one shows as "saved", never as its
 * value, because a settings page anyone can leave open on a laptop is not a
 * place to display a token that can spend money.
 */

interface ProviderField {
  name: string;
  label: string;
  secret: boolean;
  required: boolean;
  placeholder: string | null;
  help: string | null;
}

interface Provider {
  id: string;
  label: string;
  help: string;
  fields: ProviderField[];
}

interface SmsSettings {
  provider: string;
  is_enabled: boolean;
  settings: Record<string, string>;
  secrets_set: string[];
  updated_at: string | null;
}

const NONE = 'none';

export function Settings(): JSX.Element {
  const { data, loading, error, reload } = useQuery(
    () => Promise.all([api.get<Provider[]>('/settings/sms/providers'), api.get<SmsSettings>('/settings/sms')]),
    [],
  );

  if (loading) return <Loading />;
  if (error) return <ErrorNotice message={error} />;
  if (!data) return <Loading />;

  const [providers, current] = data;
  return <SettingsBody providers={providers} current={current} onSaved={reload} />;
}

function SettingsBody({
  providers,
  current,
  onSaved,
}: {
  providers: Provider[];
  current: SmsSettings;
  onSaved: () => void;
}): JSX.Element {
  const [chosen, setChosen] = React.useState(current.provider);
  const [enabled, setEnabled] = React.useState(current.is_enabled);
  const provider = providers.find((p) => p.id === chosen) ?? null;

  // Only the values that belong to this provider: switching from Twilio to
  // Telnyx should not carry an account SID across.
  const saved = chosen === current.provider ? current.settings : {};
  const storedSecrets = chosen === current.provider ? current.secrets_set : [];

  const specs: FieldSpec[] = React.useMemo(
    () =>
      (provider?.fields ?? []).map((f) => ({
        name: f.name,
        label: f.label,
        type: f.secret ? 'password' : 'text',
        value: f.secret ? '' : (saved[f.name] ?? ''),
        placeholder: f.secret
          ? storedSecrets.includes(f.name)
            ? 'Saved — leave blank to keep it'
            : (f.placeholder ?? '')
          : (f.placeholder ?? ''),
        help:
          f.help ??
          (f.secret && storedSecrets.includes(f.name)
            ? 'Stored and encrypted. Type a new one to replace it.'
            : undefined),
      })),
    [provider, chosen], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const [values, setValues] = React.useState<Record<string, string>>({});
  React.useEffect(() => {
    setValues(Object.fromEntries(specs.map((s) => [s.name, s.value ?? ''])));
  }, [specs]);

  const { run, pending, error } = useSubmit(onSaved);

  const save = (): void => {
    const settings: Record<string, string> = {};
    const secrets: Record<string, string> = {};
    for (const f of provider?.fields ?? []) {
      const value = values[f.name] ?? '';
      if (!f.secret) settings[f.name] = value;
      // A blank secret means "keep what is stored", so it is not sent at all.
      else if (value) secrets[f.name] = value;
    }
    run(() => api.put('/settings/sms', { provider: chosen, is_enabled: enabled, settings, secrets }));
  };

  return (
    <>
      <PageHeader title="Settings" subtitle="Outside services this company uses" />

      <Section title="Text messages" className="mb-4">
        <FieldList>
          <Field label="Status">{current.is_enabled ? 'Sending' : 'Not sending'}</Field>
          <Field label="Last changed">{current.updated_at ? stamp(current.updated_at) : 'never'}</Field>
        </FieldList>

        <div className="mt-4 flex flex-col gap-1.5">
          <Label htmlFor="provider">Provider</Label>
          <Select value={chosen} onValueChange={setChosen}>
            <SelectTrigger id="provider" className="max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>Not configured</SelectItem>
              {providers.map((p) => (
                <SelectItem key={p.id} value={p.id}>
                  {p.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="mt-4">
          {provider ? (
            <>
              <p className="mb-3 max-w-[60ch] text-xs text-muted-foreground">{provider.help}</p>
              <DataFormFields
                specs={specs}
                values={values}
                setValue={(name, value) => setValues((v) => ({ ...v, [name]: value }))}
              />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">
              No provider yet. Messages queued for SMS are rendered and logged, and nothing is sent
              until one is picked here.
            </p>
          )}
        </div>

        <label className="mt-3 flex items-center gap-2 text-sm">
          <Checkbox checked={enabled} onCheckedChange={(v) => setEnabled(v === true)} />
          Send text messages to customers
        </label>

        {error ? <ErrorNotice message={error} /> : null}
        <div className="mt-3">
          <Button type="button" disabled={pending} onClick={save}>
            {pending ? 'Working…' : 'Save'}
          </Button>
        </div>
      </Section>

      <TestSection />
    </>
  );
}

function TestSection(): JSX.Element {
  const [to, setTo] = React.useState('');
  const [pending, setPending] = React.useState(false);
  const [message, setMessage] = React.useState('');
  const [tone, setTone] = React.useState<'good' | 'critical'>('good');

  const send = (): void => {
    const trimmed = to.trim();
    if (!trimmed) {
      setTone('critical');
      setMessage('Enter a number to send the test to.');
      return;
    }
    setPending(true);
    setMessage('Sending…');
    api
      .post<{ sent_to: string; provider_message_id: string }>('/settings/sms/test', { to: trimmed })
      .then((result) => {
        setTone('good');
        setMessage(`Sent to ${result.sent_to} (${result.provider_message_id}).`);
      })
      .catch((err: unknown) => {
        if (err instanceof api.Unauthenticated) {
          location.reload();
          return;
        }
        setTone('critical');
        setMessage(err instanceof api.ApiError ? err.full : String(err));
      })
      .finally(() => setPending(false));
  };

  return (
    <Section title="Test it">
      <p className="mb-3 max-w-[60ch] text-xs text-muted-foreground">
        Sends one message through the saved credentials, whether or not sending is switched on.
        Save first — this tests what is stored, not what is typed above.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="test-to">Send a test to</Label>
          <Input id="test-to" value={to} onChange={(e) => setTo(e.target.value)} placeholder="+19025550123" />
        </div>
        <Button type="button" variant="secondary" disabled={pending} onClick={send}>
          Send a test
        </Button>
      </div>
      {message ? (
        <p className={`mt-2 text-sm ${tone === 'critical' ? 'text-critical' : 'text-good'}`} aria-live="polite">
          {message}
        </p>
      ) : null}
    </Section>
  );
}
