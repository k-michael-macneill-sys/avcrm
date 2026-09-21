import { randomBytes } from 'node:crypto';

/**
 * Generates the secrets a deployment needs, ready to paste into .env.
 *
 * Exists because the alternative is someone inventing a password at the
 * keyboard. `openssl rand` is in the README and does the same job, but it is
 * three different invocations to remember and one of them is easy to get
 * wrong — and a weak JWT_SECRET is not a mistake anything later will catch.
 *
 *   npm run secrets
 */

export interface GeneratedSecrets {
  POSTGRES_PASSWORD: string;
  /** Distinct from SECRETS_KEY on purpose — see the note printed below. */
  JWT_SECRET: string;
  SECRETS_KEY: string;
}

const value = (bytes: number): string => randomBytes(bytes).toString('base64url');

export function generateSecretValues(): GeneratedSecrets {
  return {
    POSTGRES_PASSWORD: value(24),
    JWT_SECRET: value(48),
    SECRETS_KEY: value(48),
  };
}

/** The same values as lines ready to paste into .env. */
export function generateSecrets(secrets = generateSecretValues()): string[] {
  return Object.entries(secrets).map(([name, v]) => `${name}=${v}`);
}

function main(): void {
  const lines = generateSecrets();

  process.stdout.write('\n');
  for (const line of lines) process.stdout.write(`${line}\n`);
  process.stdout.write(
    [
      '',
      'Paste these into .env, then set DATABASE_URL to use the same password.',
      '',
      'SECRETS_KEY encrypts the SMS credentials an administrator saves in',
      'Settings. Keep it separate from JWT_SECRET so rotating one does not',
      'make the other unreadable, and back it up with the database — losing',
      'it cannot be undone by a redeploy.',
      '',
    ].join('\n'),
  );
}

if (require.main === module) {
  main();
}
