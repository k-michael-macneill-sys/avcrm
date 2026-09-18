import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';
import { config } from '../config';

/**
 * Encrypting the credentials an admin types into the settings screen.
 *
 * A provider's auth token is a bearer credential: anyone holding it can send
 * messages and run up a bill in this company's name. Storing it as plain text
 * in a column means it is in every backup, every replica, and every `select *`
 * a support query ever runs. So it is encrypted before it is written, and the
 * plaintext exists only between reading the row and making the HTTP call.
 *
 * AES-256-GCM, so the ciphertext is authenticated as well as hidden — a row
 * edited in the database fails to decrypt rather than decrypting to something
 * else.
 *
 * This is not a substitute for a KMS. It defends against a leaked dump, not
 * against an attacker who already has the application's environment. The
 * upgrade path is to replace the two functions below.
 */

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const VERSION = 'v1';

/**
 * Derived rather than configured, so an existing install gains this without a
 * new required variable. The info string keeps it a different key from the one
 * that signs tokens, so neither use can be attacked through the other.
 *
 * Set SECRETS_KEY to decouple the two — then rotating JWT_SECRET signs out
 * every session without also making the stored credentials unreadable.
 */
function key(): Buffer {
  const material = config.secretsKey ?? config.auth.jwtSecret;
  return Buffer.from(hkdfSync('sha256', material, '', 'avcrm/settings-encryption', 32));
}

/** Self-describing: version, iv, tag and ciphertext, so v2 can decrypt v1. */
export function encryptSecret(plaintext: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key(), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return [
    VERSION,
    iv.toString('base64'),
    cipher.getAuthTag().toString('base64'),
    body.toString('base64'),
  ].join('.');
}

export class SecretUnreadable extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SecretUnreadable';
  }
}

export function decryptSecret(stored: string): string {
  const [version, iv, tag, body] = stored.split('.');
  if (version !== VERSION || !iv || !tag || !body) {
    throw new SecretUnreadable('Stored credential is not in a format this version can read');
  }

  try {
    const decipher = createDecipheriv(ALGORITHM, key(), Buffer.from(iv, 'base64'));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([
      decipher.update(Buffer.from(body, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Almost always the key changed — JWT_SECRET rotated with no SECRETS_KEY
    // set. Say so, because "bad decrypt" sends people hunting for a bug.
    throw new SecretUnreadable(
      'Stored credential could not be decrypted. If JWT_SECRET or SECRETS_KEY '
        + 'changed, the credential has to be entered again.',
    );
  }
}
