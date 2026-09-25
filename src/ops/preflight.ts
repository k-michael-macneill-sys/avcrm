import path from 'node:path';
import { readFileSync } from 'node:fs';
import dotenv from 'dotenv';

/**
 * Reads the .env a deployment is about to run on and says what is wrong with
 * it, before `docker compose up` rather than after.
 *
 *   npm run preflight
 *
 * The application's own config (src/config) already refuses to boot on a
 * missing DATABASE_URL or a short JWT_SECRET. This is the other half: the
 * settings that are individually valid and still wrong for production — a
 * placeholder carried over from the example file, a staging valve left open
 * so no customer is ever written to, `MAIL_DRIVER=log` on a machine that is
 * supposed to be sending invoices.
 *
 * Nothing here connects to anything. It runs before the stack exists, so it
 * checks what can be checked from a file; the readiness endpoint covers the
 * half that needs the system running.
 */

type Level = 'error' | 'warning';

interface Finding {
  level: Level;
  setting: string;
  message: string;
}

/** Values shipped in deploy/env.example, which must not survive to production. */
const PLACEHOLDERS = [
  'crm.example.ca',
  'office@example.ca',
  'example.ca',
  'PASSWORD_FROM_ABOVE',
  'YOUR_PLACE_ID',
  'dev-password-only',
  'localhost',
];

const looksLikePlaceholder = (value: string): boolean =>
  PLACEHOLDERS.some((p) => value.includes(p));

/**
 * Rough entropy: a base64 secret of n characters carries about 6n bits, but a
 * passphrase someone typed carries far less per character. Counting distinct
 * characters separates "48 random bytes" from "averylongpasswordindeed".
 */
function looksWeak(value: string, minLength: number): boolean {
  if (value.length < minLength) return true;
  return new Set(value).size < 12;
}

export function inspect(env: Record<string, string | undefined>): Finding[] {
  const found: Finding[] = [];
  const error = (setting: string, message: string) =>
    found.push({ level: 'error', setting, message });
  const warn = (setting: string, message: string) =>
    found.push({ level: 'warning', setting, message });

  const get = (name: string): string => (env[name] ?? '').trim();

  // --- secrets ------------------------------------------------------------
  for (const name of ['POSTGRES_PASSWORD', 'JWT_SECRET']) {
    const value = get(name);
    if (value === '') error(name, 'is empty — run `npm run secrets` to generate one');
    else if (looksWeak(value, name === 'JWT_SECRET' ? 32 : 16)) {
      error(name, 'is short or repetitive enough to guess — generate a random one');
    }
  }

  const jwt = get('JWT_SECRET');
  const secretsKey = get('SECRETS_KEY');
  if (secretsKey === '') {
    warn(
      'SECRETS_KEY',
      'is unset, so the key encrypting saved SMS credentials is derived from ' +
        'JWT_SECRET. That works, but rotating JWT_SECRET then makes those ' +
        'credentials unreadable.',
    );
  } else if (secretsKey === jwt) {
    error('SECRETS_KEY', 'is the same value as JWT_SECRET, which defeats keeping them apart');
  } else if (looksWeak(secretsKey, 32)) {
    error('SECRETS_KEY', 'is short or repetitive enough to guess — generate a random one');
  }

  // --- the machine --------------------------------------------------------
  const domain = get('DOMAIN');
  if (domain === '') error('DOMAIN', 'is empty — Caddy needs it to request a certificate');
  else if (looksLikePlaceholder(domain)) {
    error('DOMAIN', `is still the example value (${domain})`);
  }

  const acme = get('ACME_EMAIL');
  if (acme === '') error('ACME_EMAIL', 'is empty — Let’s Encrypt requires a contact address');
  else if (looksLikePlaceholder(acme)) error('ACME_EMAIL', `is still the example value (${acme})`);

  const baseUrl = get('APP_BASE_URL');
  if (baseUrl === '') {
    error('APP_BASE_URL', 'is empty — card-setup and review links are built from it');
  } else {
    if (!baseUrl.startsWith('https://')) {
      error(
        'APP_BASE_URL',
        'is not https. Customers open these links on their phones to enter a card.',
      );
    }
    if (looksLikePlaceholder(baseUrl)) {
      error('APP_BASE_URL', `is still the example value (${baseUrl})`);
    }
    if (domain !== '' && !baseUrl.includes(domain)) {
      warn('APP_BASE_URL', `does not contain DOMAIN (${domain}) — one of the two is wrong`);
    }
  }

  // --- database -----------------------------------------------------------
  const dbUrl = get('DATABASE_URL');
  if (dbUrl === '') error('DATABASE_URL', 'is empty');
  else {
    if (dbUrl.includes('PASSWORD_FROM_ABOVE')) {
      error('DATABASE_URL', 'still carries the example placeholder instead of the real password');
    }
    const password = get('POSTGRES_PASSWORD');
    if (password !== '' && !dbUrl.includes(encodeURIComponent(password))) {
      // Caught here rather than as a connection refusal at three in the morning.
      warn(
        'DATABASE_URL',
        'does not appear to contain POSTGRES_PASSWORD — the app and the database ' +
          'would disagree about the password',
      );
    }
    if (/@(localhost|127\.0\.0\.1)[:/]/.test(dbUrl)) {
      error(
        'DATABASE_URL',
        'points at localhost. Inside compose the host is `postgres`, the service name.',
      );
    }
  }

  // --- the proxy ----------------------------------------------------------
  // Both directions are wrong in their own way, so neither is a warning.
  const trustProxy = get('TRUST_PROXY');
  if (trustProxy === 'false' || trustProxy === '0') {
    warn(
      'TRUST_PROXY',
      'is off. Behind Caddy every contract will record the proxy’s address as ' +
        'the IP its signature came from, which is what makes signed_ip evidence.',
    );
  }

  // --- what actually reaches a customer -----------------------------------
  if (get('MAIL_DRIVER') !== 'smtp') {
    error(
      'MAIL_DRIVER',
      'is not smtp, so invoices, review requests and expiry warnings are written ' +
        'to the log instead of being sent.',
    );
  }
  if (get('MAIL_FROM') === '') error('MAIL_FROM', 'is empty — the app refuses to start without it');

  // The app refuses to boot without SMTP_HOST, but it starts happily without
  // credentials and then fails on the first invoice, which is a worse place
  // to find out.
  if (get('MAIL_DRIVER') === 'smtp') {
    for (const name of ['SMTP_HOST', 'SMTP_USER', 'SMTP_PASSWORD']) {
      if (get(name) === '') error(name, 'is empty, but MAIL_DRIVER is smtp');
    }
  }

  const mailRedirect = get('MAIL_REDIRECT_TO');
  if (mailRedirect !== '') {
    error(
      'MAIL_REDIRECT_TO',
      `is set (${mailRedirect}). That is the staging valve: every message goes ` +
        'there and no customer is ever written to.',
    );
  }
  const smsRedirect = get('SMS_REDIRECT_TO');
  if (smsRedirect !== '') {
    error('SMS_REDIRECT_TO', `is set (${smsRedirect}), so no customer is ever texted.`);
  }

  // --- money --------------------------------------------------------------
  const accessToken = get('SQUARE_ACCESS_TOKEN');
  if (accessToken === '') {
    warn(
      'SQUARE_ACCESS_TOKEN',
      'is unset. Unless Square is connected under Settings instead, saved cards ' +
        'cannot be charged and customers cannot pay from their invoice link.',
    );
  } else if (get('SQUARE_ENVIRONMENT') !== 'production') {
    error('SQUARE_ENVIRONMENT', 'is not production, so no real money will move');
  }

  // --- keeping the records ------------------------------------------------
  if (get('BACKUP_OFFSITE_CMD') === '') {
    warn(
      'BACKUP_OFFSITE_CMD',
      'is unset, so every backup lives on the same disk as the database it came ' +
        'from. That survives a bad migration, not a dead disk.',
    );
  }

  return found;
}

function main(): void {
  const envPath = path.resolve(__dirname, '..', '..', '.env');

  let raw: string;
  try {
    raw = readFileSync(envPath, 'utf8');
  } catch {
    process.stderr.write(
      `\nNo .env at ${envPath}\n\n  cp deploy/env.example .env && npm run secrets\n\n`,
    );
    process.exit(1);
  }

  const findings = inspect(dotenv.parse(raw));
  const errors = findings.filter((f) => f.level === 'error');
  const warnings = findings.filter((f) => f.level === 'warning');

  const show = (list: Finding[], label: string) => {
    if (list.length === 0) return;
    process.stdout.write(`\n${label}\n`);
    for (const f of list) process.stdout.write(`  ${f.setting} ${f.message}\n`);
  };

  show(errors, 'Must be fixed before deploying:');
  show(warnings, 'Worth a look:');

  if (errors.length === 0) {
    process.stdout.write(
      warnings.length === 0
        ? '\nNothing to flag. This .env is ready.\n\n'
        : '\nNothing blocking. Read the above and decide.\n\n',
    );
    return;
  }

  process.stdout.write(`\n${errors.length} must be fixed.\n\n`);
  process.exit(1);
}

if (require.main === module) {
  main();
}
