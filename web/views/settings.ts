import * as api from '../api.js';
import { flash, input, labelled, pageHeader, select } from '../components.js';
import { field, fieldList, fragment, h, section } from '../dom.js';
import { buildForm, errorLine, submitter, type FieldSpec } from '../form.js';
import { stamp } from '../format.js';
import * as router from '../router.js';

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

export async function renderSettings(root: HTMLElement): Promise<void> {
  const [providers, current] = await Promise.all([
    api.get<Provider[]>('/settings/sms/providers'),
    api.get<SmsSettings>('/settings/sms'),
  ]);

  const error = errorLine();
  const run = submitter(error, () => router.render());

  // Held in a local so switching provider re-renders the fields without
  // saving anything — picking one to look at is not a change.
  let chosen = current.provider;

  const providerPicker = select(
    [
      { value: NONE, label: 'Not configured' },
      ...providers.map((p) => ({ value: p.id, label: p.label })),
    ],
    chosen,
    (value) => {
      chosen = value;
      renderBody();
    },
  );

  const enabled = h('input', { type: 'checkbox', id: 'sms-enabled' });
  enabled.checked = current.is_enabled;

  const body = h('div');
  const testResult = h('p', { 'aria-live': 'polite' });
  let form: ReturnType<typeof buildForm> | null = null;

  function renderBody(): void {
    const provider = providers.find((p) => p.id === chosen) ?? null;

    if (!provider) {
      form = null;
      body.replaceChildren(
        h(
          'p',
          { class: 'empty' },
          'No provider yet. Messages queued for SMS are rendered and logged, '
            + 'and nothing is sent until one is picked here.',
        ),
      );
      return;
    }

    // Only the values that belong to this provider: switching from Twilio to
    // Telnyx should not carry an account SID across.
    const saved = chosen === current.provider ? current.settings : {};
    const storedSecrets = chosen === current.provider ? current.secrets_set : [];

    const specs: FieldSpec[] = provider.fields.map((f) => ({
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
        f.help
        ?? (f.secret && storedSecrets.includes(f.name)
          ? 'Stored and encrypted. Type a new one to replace it.'
          : undefined),
    }));

    form = buildForm(specs);
    body.replaceChildren(h('p', { class: 'form-help' }, provider.help), form.node);
  }

  renderBody();

  function payload(): {
    provider: string;
    is_enabled: boolean;
    settings: Record<string, string>;
    secrets: Record<string, string>;
  } {
    const provider = providers.find((p) => p.id === chosen) ?? null;
    const values = form?.values() ?? {};
    const settings: Record<string, string> = {};
    const secrets: Record<string, string> = {};

    for (const f of provider?.fields ?? []) {
      const value = values[f.name] ?? '';
      if (!f.secret) settings[f.name] = value;
      // A blank secret means "keep what is stored", so it is not sent at all.
      else if (value) secrets[f.name] = value;
    }

    return { provider: chosen, is_enabled: enabled.checked, settings, secrets };
  }

  const testNumber = input({ type: 'text', placeholder: '+19025550123' });
  const testButton = h(
    'button',
    {
      type: 'button',
      class: 'btn btn-secondary',
      onclick: () => {
        const to = testNumber.value.trim();
        if (!to) {
          flash(testResult, 'Enter a number to send the test to.', 'critical');
          return;
        }

        testButton.disabled = true;
        testResult.textContent = 'Sending…';
        testResult.className = '';

        api
          .post<{ sent_to: string; provider_message_id: string }>('/settings/sms/test', { to })
          .then((result) => {
            flash(testResult, `Sent to ${result.sent_to} (${result.provider_message_id}).`);
          })
          .catch((err: unknown) => {
            if (err instanceof api.Unauthenticated) {
              location.reload();
              return;
            }
            flash(
              testResult,
              err instanceof api.ApiError ? err.full : String(err),
              'critical',
            );
          })
          .finally(() => {
            testButton.disabled = false;
          });
      },
    },
    'Send a test',
  );

  root.appendChild(
    fragment(
      pageHeader('Settings', 'Outside services this company uses'),
      section(
        'Text messages',
        fieldList(
          field('Status', current.is_enabled ? 'Sending' : 'Not sending'),
          field('Last changed', current.updated_at ? stamp(current.updated_at) : 'never'),
        ),
        labelled('Provider', providerPicker),
        body,
        h(
          'div',
          { class: 'checkbox-row' },
          enabled,
          h('label', { for: 'sms-enabled' }, 'Send text messages to customers'),
        ),
        error,
        h(
          'div',
          { class: 'actions' },
          run('Save', () => api.put('/settings/sms', payload()), 'primary'),
        ),
      ),
      section(
        'Test it',
        h(
          'p',
          { class: 'form-help' },
          'Sends one message through the saved credentials, whether or not '
            + 'sending is switched on. Save first — this tests what is stored, '
            + 'not what is typed above.',
        ),
        h(
          'div',
          { class: 'filter-bar' },
          labelled('Send a test to', testNumber),
          testButton,
        ),
        testResult,
      ),
    ),
  );
}
