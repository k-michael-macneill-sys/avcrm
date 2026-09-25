import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import { badRequest } from '../utils/errors';
import { decryptSecret, encryptSecret } from '../utils/secrets';
import type { IntegrationSetting } from '../types/models';
import { paymentProvider } from './paymentProviders';
import { smsProvider, type ProviderField } from './smsProviders';

/**
 * Settings an administrator owns.
 *
 * Read straight from the table on every use rather than cached: a manager who
 * saves a credential and presses "send a test" should be testing what they
 * just typed, and a worker that started before the change should pick it up on
 * its next message. One primary-key lookup is not worth a staleness bug.
 */

export const SMS_KEY = 'sms';
export const PAYMENTS_KEY = 'payments';

export type IntegrationKey = typeof SMS_KEY | typeof PAYMENTS_KEY;

/** The catalogue an integration's providers come from. */
function definitionOf(
  key: string,
  provider: string,
): { label: string; fields: ProviderField[] } | null {
  return key === PAYMENTS_KEY ? paymentProvider(provider) : smsProvider(provider);
}

/** What the API is allowed to show: configuration, never credentials. */
export interface PublicIntegration {
  /** Null only for an integration nobody has ever saved. */
  id: string | null;
  key: string;
  provider: string;
  is_enabled: boolean;
  settings: Record<string, string>;
  /** Which secret fields have a value stored, so the UI can say so. */
  secrets_set: string[];
  updated_by_user_id: string | null;
  updated_at: Date | null;
}

function notConfigured(key: string): PublicIntegration {
  return {
    id: null,
    key,
    provider: 'none',
    is_enabled: false,
    settings: {},
    secrets_set: [],
    updated_by_user_id: null,
    updated_at: null,
  };
}

function secretFields(key: string, provider: string): ProviderField[] {
  return definitionOf(key, provider)?.fields.filter((f) => f.secret) ?? [];
}

export async function readIntegration(
  key: string,
  db: Knex = defaultDb,
): Promise<IntegrationSetting | null> {
  const row = (await db('integration_settings').where({ key }).first()) as
    | IntegrationSetting
    | undefined;
  return row ?? null;
}

/** A saved one always has its row, which is what the audit log references. */
export type SavedIntegration = PublicIntegration & { id: string };

/** For the read path, where "never configured" is a normal answer. */
export function publicView(key: string, row: IntegrationSetting | null): PublicIntegration {
  return row ? toPublic(row) : notConfigured(key);
}

export function toPublic(row: IntegrationSetting): SavedIntegration {
  const stored = row.secret_ciphertext ? readSecrets(row) : {};

  return {
    id: row.id,
    key: row.key,
    provider: row.provider,
    is_enabled: row.is_enabled,
    settings: row.settings ?? {},
    // The names only. Their values never leave this process.
    secrets_set: secretFields(row.key, row.provider)
      .map((f) => f.name)
      .filter((name) => Boolean(stored[name])),
    updated_by_user_id: row.updated_by_user_id,
    updated_at: row.updated_at,
  };
}

/** Decrypted credentials. Only the transport and a test send call this. */
export function readSecrets(row: IntegrationSetting): Record<string, string> {
  if (!row.secret_ciphertext) return {};
  return JSON.parse(decryptSecret(row.secret_ciphertext)) as Record<string, string>;
}

/** Configuration and credentials together, as the transport needs them. */
export function resolveValues(row: IntegrationSetting): Record<string, string> {
  return { ...(row.settings ?? {}), ...readSecrets(row) };
}

export interface SaveIntegration {
  provider: string;
  is_enabled: boolean;
  settings: Record<string, string>;
  /**
   * Only the ones being changed. A field left out keeps the stored value,
   * which is what lets the UI show "saved" instead of a credential.
   */
  secrets: Record<string, string>;
}

export async function saveIntegration(
  key: string,
  input: SaveIntegration,
  actorId: string,
  db: Knex = defaultDb,
): Promise<SavedIntegration> {
  const definition = input.provider === 'none' ? null : definitionOf(key, input.provider);
  if (input.provider !== 'none' && !definition) {
    throw badRequest(`Unknown provider '${input.provider}'`);
  }

  const existing = await readIntegration(key, db);
  // Switching provider abandons the old credentials rather than carrying them
  // across — a Twilio token is not a Telnyx key, and keeping it would leave a
  // secret nobody can see and nobody meant to keep.
  const carried = existing && existing.provider === input.provider ? readSecrets(existing) : {};
  const secrets = { ...carried, ...input.secrets };

  // Blanks mean "clear this", not "store an empty credential".
  for (const [name, value] of Object.entries(secrets)) {
    if (!value) delete secrets[name];
  }

  if (definition) {
    for (const field of definition.fields) {
      const value = input.settings[field.name];
      if (field.options && value && !field.options.some((o) => o.value === value)) {
        throw badRequest(
          `${field.label} must be one of ${field.options.map((o) => o.value).join(', ')}`,
        );
      }
    }

    const values = { ...input.settings, ...secrets };
    const missing = definition.fields
      .filter((f) => f.required && !values[f.name])
      .map((f) => f.label);
    // Only when it is being switched on: a half-filled draft can be saved.
    if (input.is_enabled && missing.length) {
      throw badRequest(
        `${definition.label} needs ${missing.join(', ')} before it can be switched on`,
      );
    }
  }

  const row = {
    key,
    provider: input.provider,
    is_enabled: input.is_enabled,
    settings: input.settings,
    secret_ciphertext: Object.keys(secrets).length
      ? encryptSecret(JSON.stringify(secrets))
      : null,
    updated_by_user_id: actorId,
  };

  const [saved] = await db('integration_settings')
    .insert(row)
    .onConflict('key')
    .merge(['provider', 'is_enabled', 'settings', 'secret_ciphertext', 'updated_by_user_id'])
    .returning('*');

  if (!saved) {
    throw new Error('Saving the integration returned no row');
  }
  return toPublic(saved);
}
