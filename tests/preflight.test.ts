import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { inspect } from '../src/ops/preflight';
import { generateSecretValues } from '../src/ops/secrets';

/**
 * The preflight's value is entirely in what it refuses. A check that passes
 * everything is worse than no check, because someone will trust it.
 */

/** A .env that should pass cleanly, which each test then breaks one way. */
function goodEnv(): Record<string, string> {
  const { POSTGRES_PASSWORD, JWT_SECRET, SECRETS_KEY } = generateSecretValues();
  return {
    DOMAIN: 'crm.avalanche.ca',
    ACME_EMAIL: 'office@avalanche.ca',
    APP_BASE_URL: 'https://crm.avalanche.ca',
    POSTGRES_PASSWORD,
    JWT_SECRET,
    SECRETS_KEY,
    DATABASE_URL: `postgres://avcrm:${POSTGRES_PASSWORD}@postgres:5432/avcrm`,
    TRUST_PROXY: 'true',
    MAIL_DRIVER: 'smtp',
    MAIL_FROM: 'Avalanche <billing@avalanche.ca>',
    SMTP_HOST: 'smtp.postmarkapp.com',
    SMTP_USER: 'user',
    SMTP_PASSWORD: 'pass',
    SQUARE_ENVIRONMENT: 'production',
    SQUARE_APPLICATION_ID: 'sq0idp-realapp',
    SQUARE_LOCATION_ID: 'L_REAL',
    SQUARE_ACCESS_TOKEN: 'EAAAl_realtoken',
    BACKUP_OFFSITE_CMD: 'rclone copy "$1" remote:backups',
  };
}

const errors = (env: Record<string, string>) =>
  inspect(env)
    .filter((f) => f.level === 'error')
    .map((f) => f.setting);

const warnings = (env: Record<string, string>) =>
  inspect(env)
    .filter((f) => f.level === 'warning')
    .map((f) => f.setting);

describe('the deploy preflight', () => {
  it('passes an environment that is actually ready', () => {
    assert.deepEqual(inspect(goodEnv()), []);
  });

  it('refuses the example file as shipped', () => {
    // The case that matters: someone copies deploy/env.example and runs.
    const found = errors({
      DOMAIN: 'crm.example.ca',
      ACME_EMAIL: 'office@example.ca',
      APP_BASE_URL: 'https://crm.example.ca',
      POSTGRES_PASSWORD: '',
      JWT_SECRET: '',
      DATABASE_URL: 'postgres://avcrm:PASSWORD_FROM_ABOVE@postgres:5432/avcrm',
      MAIL_DRIVER: 'smtp',
      MAIL_FROM: 'Avalanche <billing@example.ca>',
    });

    for (const setting of [
      'POSTGRES_PASSWORD',
      'JWT_SECRET',
      'DOMAIN',
      'ACME_EMAIL',
      'APP_BASE_URL',
      'DATABASE_URL',
    ]) {
      assert.ok(found.includes(setting), `${setting} should have been flagged`);
    }
  });

  it('catches a staging valve left open, which silently writes to nobody', () => {
    assert.ok(errors({ ...goodEnv(), MAIL_REDIRECT_TO: 'staging@avalanche.ca' }).includes('MAIL_REDIRECT_TO'));
    assert.ok(errors({ ...goodEnv(), SMS_REDIRECT_TO: '+19025550123' }).includes('SMS_REDIRECT_TO'));
  });

  it('catches mail that would only ever reach the log', () => {
    assert.ok(errors({ ...goodEnv(), MAIL_DRIVER: 'log' }).includes('MAIL_DRIVER'));
  });

  it('catches smtp with no credentials behind it', () => {
    const found = errors({ ...goodEnv(), SMTP_USER: '', SMTP_PASSWORD: '' });
    assert.ok(found.includes('SMTP_USER'));
    assert.ok(found.includes('SMTP_PASSWORD'));
  });

  it('catches a customer-facing link that is not https', () => {
    assert.ok(errors({ ...goodEnv(), APP_BASE_URL: 'http://crm.avalanche.ca' }).includes('APP_BASE_URL'));
  });

  it('catches a database host that only resolves on a laptop', () => {
    const { POSTGRES_PASSWORD } = generateSecretValues();
    const env = { ...goodEnv(), POSTGRES_PASSWORD };
    assert.ok(
      errors({ ...env, DATABASE_URL: `postgres://avcrm:${POSTGRES_PASSWORD}@localhost:5432/avcrm` })
        .includes('DATABASE_URL'),
    );
  });

  it('catches sandbox Square credentials on a live deploy', () => {
    assert.ok(errors({ ...goodEnv(), SQUARE_ENVIRONMENT: 'sandbox' }).includes('SQUARE_ENVIRONMENT'));
  });

  it('catches a secret someone typed instead of generated', () => {
    // Long, but barely a dozen distinct characters — a passphrase, not entropy.
    assert.ok(errors({ ...goodEnv(), JWT_SECRET: 'aaaaaaaabbbbbbbbccccccccdddddddd' }).includes('JWT_SECRET'));
  });

  it('refuses one key doing both jobs', () => {
    const { JWT_SECRET } = generateSecretValues();
    const env = { ...goodEnv(), JWT_SECRET };
    assert.ok(errors({ ...env, SECRETS_KEY: JWT_SECRET }).includes('SECRETS_KEY'));
  });

  it('warns rather than blocks where the choice is legitimately the operator’s', () => {
    // An install with no SMS provider and no offsite copy is a deliberate
    // state, not a broken one — say so and let them decide.
    const { SECRETS_KEY: _drop, ...noKey } = goodEnv();
    assert.ok(warnings(noKey).includes('SECRETS_KEY'));
    assert.deepEqual(errors(noKey), []);

    const { BACKUP_OFFSITE_CMD: _drop2, ...noBackup } = goodEnv();
    assert.ok(warnings(noBackup).includes('BACKUP_OFFSITE_CMD'));
    assert.deepEqual(errors(noBackup), []);

    assert.ok(warnings({ ...goodEnv(), TRUST_PROXY: 'false' }).includes('TRUST_PROXY'));
    assert.ok(warnings({ ...goodEnv(), SQUARE_ACCESS_TOKEN: '' }).includes('SQUARE_ACCESS_TOKEN'));
  });
});
