/*
 * What changes when the app runs in production on a public address: the
 * defaults that make a laptop convenient are the ones that would let a
 * stranger in, so each is refused there.
 *
 * The environment is set before anything imports the configuration, which is
 * read once at load. Node runs each test file in its own process, which is
 * what makes that safe.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { describe, it } from 'node:test';

process.env.NODE_ENV = 'production';
process.env.APP_BASE_URL = 'https://crm.example.test';
process.env.JWT_SECRET = 'a-secret-only-this-suite-has-seen-0123456789abcdef';
// The development default, which production must not accept.
process.env.BRANCH_SIGN_IN_PASSWORD = '1234';
process.env.SEED_PASSWORD = 'the-first-admins-own-password';

const { db } = await import('./helpers/database');
const { harness } = await import('./helpers/harness');
const { call } = await import('./helpers/server');
const { hashPassword, retirePublishedPassword, SEED_ADMIN_EMAIL } = await import('../src/services/auth');
const { config } = await import('../src/config');

describe('production on a public address', () => {
  const h = harness();

  it('is recognised as such', () => {
    assert.equal(config.isPublicProduction, true);
  });

  it('never signs anybody in with the published default password', async () => {
    // Every fixture account has it, corporate included.
    const admin = await call(h.server(), 'POST', '/auth/sign-in', {
      body: { choice: 'ADMIN', password: 'Password123!' },
    });
    assert.equal(admin.status, 403);
    assert.equal(admin.body.data, undefined);

    const byEmail = await call(h.server(), 'POST', '/auth/login', {
      body: { email: h.world().emails.corporate, password: 'Password123!' },
    });
    assert.equal(byEmail.status, 403);
  });

  it('switches branch sign-in off rather than accept a four-digit password', async () => {
    const reply = await call(h.server(), 'POST', '/auth/sign-in', {
      body: { choice: 'Kingston', password: '1234' },
    });
    assert.equal(reply.status, 403);
    assert.match(reply.body.error.message, /BRANCH_SIGN_IN_PASSWORD/);
  });

  it('replaces the published default on the first admin with SEED_PASSWORD', async () => {
    await db('users').insert({
      email: SEED_ADMIN_EMAIL,
      password_hash: await hashPassword('Password123!'),
      first_name: 'ADMIN',
      last_name: '',
      role: 'corporate',
      branch_id: null,
      onboarding_status: 'approved',
    });

    assert.equal(await retirePublishedPassword(db), true);
    // Only ever the published default: a second run finds nothing to do.
    assert.equal(await retirePublishedPassword(db), false);

    const reply = await call(h.server(), 'POST', '/auth/login', {
      body: { email: SEED_ADMIN_EMAIL, password: 'the-first-admins-own-password' },
    });
    assert.equal(reply.status, 200);
  });

  it('refuses to start with a JWT_SECRET published in this repository', () => {
    const run = spawnSync(process.execPath, ['--import', 'tsx', '-e', "require('./src/config')"], {
      cwd: process.cwd(),
      env: { ...process.env, JWT_SECRET: 'Awk8clQl5efZ00FW9OSwOgcki1Z4WjxT' },
      encoding: 'utf8',
    });
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /JWT_SECRET: is a value published in this repository/);

    // The same file run on localhost — the local compose stack — still starts.
    const local = spawnSync(process.execPath, ['--import', 'tsx', '-e', "require('./src/config')"], {
      cwd: process.cwd(),
      env: { ...process.env, JWT_SECRET: 'change-me-in-every-environment-at-least-32-chars', APP_BASE_URL: 'http://localhost:3000' },
      encoding: 'utf8',
    });
    assert.equal(local.status, 0, local.stderr);
  });
});
