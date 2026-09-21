/**
 * The providers an administrator can pick from, described as data.
 *
 * Every SMS gateway is the same shape — POST a recipient, a sender and some
 * text to an HTTPS endpoint with a credential — and differs only in the URL,
 * the field names and where the message id turns up in the reply. So a
 * provider here is a description, not a class: the fields the admin has to
 * fill in, and how to turn those into one request.
 *
 * That is what makes "pick a provider later" a settings change rather than a
 * code change. `custom` covers a gateway that is not in this list, including
 * a regional carrier or an internal relay, without waiting for a release.
 */

export interface ProviderField {
  name: string;
  label: string;
  /** Encrypted at rest, never returned by the API, write-only in the UI. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  help?: string;
}

export interface OutboundSms {
  to: string;
  from: string;
  body: string;
}

export interface ProviderRequest {
  url: string;
  headers: Record<string, string>;
  body: string;
}

export interface ProviderDefinition {
  id: string;
  label: string;
  /** Where the admin finds the values below in the provider's own console. */
  help: string;
  fields: ProviderField[];
  build(values: Record<string, string>, message: OutboundSms): ProviderRequest;
  /** Pulls the provider's message id out of a successful reply. */
  messageId(payload: unknown): string | null;
  /**
   * Some gateways answer 200 and put the rejection in the body. Returning a
   * string here turns that into a failure instead of a silent success.
   */
  bodyError?(payload: unknown): string | null;
}

const basic = (user: string, pass: string): string =>
  `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;

const form = (fields: Record<string, string>): ProviderRequest['body'] =>
  new URLSearchParams(fields).toString();

const FORM = 'application/x-www-form-urlencoded';
const JSON_TYPE = 'application/json';

/** Reads `data.id` or `messages.0.message-id` out of a parsed reply. */
function at(payload: unknown, path: string): string | null {
  let value: unknown = payload;
  for (const step of path.split('.')) {
    if (value === null || typeof value !== 'object') return null;
    value = (value as Record<string, unknown>)[step];
  }
  return typeof value === 'string' || typeof value === 'number' ? String(value) : null;
}

const TWILIO: ProviderDefinition = {
  id: 'twilio',
  label: 'Twilio',
  help: 'Account SID and Auth Token are on the Twilio console dashboard. The '
    + 'sending number must be one you have bought or verified there.',
  fields: [
    { name: 'account_sid', label: 'Account SID', required: true, placeholder: 'AC…' },
    { name: 'auth_token', label: 'Auth token', required: true, secret: true },
    { name: 'from', label: 'Send from', required: true, placeholder: '+19025550123' },
  ],
  build: (v, m) => ({
    url: `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(v.account_sid ?? '')}/Messages.json`,
    headers: {
      Authorization: basic(v.account_sid ?? '', v.auth_token ?? ''),
      'Content-Type': FORM,
    },
    body: form({ To: m.to, From: m.from, Body: m.body }),
  }),
  messageId: (payload) => at(payload, 'sid'),
};

const TELNYX: ProviderDefinition = {
  id: 'telnyx',
  label: 'Telnyx',
  help: 'The API key is under API Keys in the Telnyx portal. The sending '
    + 'number has to belong to a messaging profile.',
  fields: [
    { name: 'api_key', label: 'API key', required: true, secret: true, placeholder: 'KEY…' },
    { name: 'from', label: 'Send from', required: true, placeholder: '+19025550123' },
  ],
  build: (v, m) => ({
    url: 'https://api.telnyx.com/v2/messages',
    headers: { Authorization: `Bearer ${v.api_key ?? ''}`, 'Content-Type': JSON_TYPE },
    body: JSON.stringify({ from: m.from, to: m.to, text: m.body }),
  }),
  messageId: (payload) => at(payload, 'data.id'),
};

const MESSAGEBIRD: ProviderDefinition = {
  id: 'messagebird',
  label: 'MessageBird (Bird)',
  help: 'The live access key is under Developers → API access. "Send from" may '
    + 'be a number or, where the country allows it, a short alphanumeric name.',
  fields: [
    { name: 'access_key', label: 'Access key', required: true, secret: true },
    { name: 'from', label: 'Send from', required: true, placeholder: 'Drift' },
  ],
  build: (v, m) => ({
    url: 'https://rest.messagebird.com/messages',
    headers: {
      Authorization: `AccessKey ${v.access_key ?? ''}`,
      'Content-Type': JSON_TYPE,
    },
    body: JSON.stringify({ originator: m.from, recipients: [m.to], body: m.body }),
  }),
  messageId: (payload) => at(payload, 'id'),
};

const VONAGE: ProviderDefinition = {
  id: 'vonage',
  label: 'Vonage (Nexmo)',
  help: 'API key and secret are on the Vonage dashboard home page.',
  fields: [
    { name: 'api_key', label: 'API key', required: true },
    { name: 'api_secret', label: 'API secret', required: true, secret: true },
    { name: 'from', label: 'Send from', required: true, placeholder: 'Drift' },
  ],
  build: (v, m) => ({
    url: 'https://rest.nexmo.com/sms/json',
    headers: { 'Content-Type': JSON_TYPE },
    body: JSON.stringify({
      api_key: v.api_key ?? '',
      api_secret: v.api_secret ?? '',
      from: m.from,
      to: m.to,
      text: m.body,
    }),
  }),
  messageId: (payload) => at(payload, 'messages.0.message-id'),
  // Vonage answers 200 even when it refused, with the reason inside.
  bodyError: (payload) => {
    const status = at(payload, 'messages.0.status');
    if (status === null || status === '0') return null;
    return at(payload, 'messages.0.error-text') ?? `Vonage rejected the message (status ${status})`;
  },
};

const CUSTOM: ProviderDefinition = {
  id: 'custom',
  label: 'Anything else (HTTP)',
  help: 'For a gateway not in this list. Use {{to}}, {{from}} and {{body}} in '
    + 'the request template — they are filled in per message and URL-encoded '
    + 'when the content type is form.',
  fields: [
    {
      name: 'url',
      label: 'Endpoint URL',
      required: true,
      placeholder: 'https://sms.example.com/v1/send',
    },
    {
      name: 'content_type',
      label: 'Content type',
      required: true,
      placeholder: 'json',
      help: 'json or form',
    },
    {
      name: 'auth_header_name',
      label: 'Auth header name',
      placeholder: 'Authorization',
    },
    {
      name: 'auth_header_value',
      label: 'Auth header value',
      secret: true,
      placeholder: 'Bearer …',
    },
    {
      name: 'from',
      label: 'Send from',
      required: true,
      placeholder: '+19025550123',
    },
    {
      name: 'body_template',
      label: 'Request body',
      required: true,
      placeholder: '{"to":"{{to}}","from":"{{from}}","text":"{{body}}"}',
    },
    {
      name: 'message_id_path',
      label: 'Message id in the reply',
      placeholder: 'data.id',
      help: 'Dotted path. Leave blank if the reply has no id.',
    },
  ],
  build: (v, m) => {
    const isForm = (v.content_type ?? 'json').toLowerCase() === 'form';
    // JSON bodies are escaped so a quote or a newline in the message text
    // cannot break out of the string it sits in and rewrite the request.
    const escape = (raw: string): string =>
      isForm ? encodeURIComponent(raw) : JSON.stringify(raw).slice(1, -1);

    const body = (v.body_template ?? '')
      .replace(/\{\{\s*to\s*\}\}/g, escape(m.to))
      .replace(/\{\{\s*from\s*\}\}/g, escape(m.from))
      .replace(/\{\{\s*body\s*\}\}/g, escape(m.body));

    return {
      url: v.url ?? '',
      headers: {
        'Content-Type': isForm ? FORM : JSON_TYPE,
        ...(v.auth_header_name && v.auth_header_value
          ? { [v.auth_header_name]: v.auth_header_value }
          : {}),
      },
      body,
    };
  },
  // The reply shape is whatever the gateway does, so the path is configured.
  messageId: () => null,
};

export const SMS_PROVIDERS: ProviderDefinition[] = [
  TWILIO,
  TELNYX,
  MESSAGEBIRD,
  VONAGE,
  CUSTOM,
];

export const SMS_PROVIDER_IDS = SMS_PROVIDERS.map((p) => p.id);

export function smsProvider(id: string): ProviderDefinition | null {
  return SMS_PROVIDERS.find((p) => p.id === id) ?? null;
}

/** The custom provider's id path is configured rather than fixed. */
export function readMessageId(
  provider: ProviderDefinition,
  values: Record<string, string>,
  payload: unknown,
): string | null {
  if (provider.id === 'custom') {
    const path = values.message_id_path;
    return path ? at(payload, path) : null;
  }
  return provider.messageId(payload);
}
