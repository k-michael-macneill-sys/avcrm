import type { ProviderField } from './smsProviders';

/**
 * The processors an administrator can connect from the settings screen,
 * described as data so the screen renders itself from this list.
 *
 * Square can also be configured through the environment instead — see
 * gateway.ts. A processor connected here takes precedence over that once it
 * is switched on.
 */

export interface PaymentProviderDefinition {
  id: string;
  label: string;
  help: string;
  fields: ProviderField[];
}

export const SQUARE: PaymentProviderDefinition = {
  id: 'square',
  label: 'Square',
  help:
    'In the Square Developer Console, open your application. The application ID ' +
    'and access token are under Credentials, and the location ID under Locations. ' +
    'Use the Sandbox values to try it out, then switch to Production.',
  fields: [
    {
      name: 'environment',
      label: 'Environment',
      required: true,
      options: [
        { value: 'sandbox', label: 'Sandbox (test cards, no real money)' },
        { value: 'production', label: 'Production' },
      ],
    },
    {
      name: 'application_id',
      label: 'Application ID',
      required: true,
      placeholder: 'sq0idp-… or sandbox-sq0idb-…',
      help: 'Public. The payment page uses it to show Square’s card form.',
    },
    { name: 'location_id', label: 'Location ID', required: true, placeholder: 'L…' },
    { name: 'access_token', label: 'Access token', required: true, secret: true },
    {
      name: 'webhook_signature_key',
      label: 'Webhook signature key',
      secret: true,
      help:
        'Optional, but without it a refund made in the Square Dashboard is never ' +
        'recorded here. Add a webhook subscription for payment.updated and ' +
        'refund.updated pointing at /webhooks/square on this site, then paste its ' +
        'signature key.',
    },
  ],
};

export const PAYMENT_PROVIDERS: PaymentProviderDefinition[] = [SQUARE];

export function paymentProvider(id: string): PaymentProviderDefinition | null {
  return PAYMENT_PROVIDERS.find((p) => p.id === id) ?? null;
}
