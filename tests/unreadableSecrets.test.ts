/*
 * Credentials saved under Settings, after JWT_SECRET or SECRETS_KEY changed:
 * they can no longer be decrypted. The app has to keep working (taking no
 * cards) and Settings has to stay usable, because typing them in again is the
 * only way back.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { call, login } from './helpers/server';
import { encryptSecret } from '../src/utils/secrets';

/** Well-formed, but sealed with a key this server does not have. */
const FOREIGN_CIPHERTEXT = 'v1.AAAAAAAAAAAAAAAA.AAAAAAAAAAAAAAAAAAAAAA==.AAAAAAAA';

async function squareSavedUnderOldKey(userId: string): Promise<void> {
  await db('integration_settings').insert({
    key: 'payments',
    provider: 'square',
    is_enabled: true,
    settings: { environment: 'sandbox', application_id: 'sandbox-sq0idb-x', location_id: 'L1' },
    secret_ciphertext: FOREIGN_CIPHERTEXT,
    updated_by_user_id: userId,
  });
}

describe('credentials that can no longer be decrypted', () => {
  const h = harness();

  it('leave the public config answering, with cards off', async () => {
    await squareSavedUnderOldKey(h.world().users.corporate);
    const reply = await call(h.server(), 'GET', '/public/config');
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.card_capture, false);
  });

  it('show in Settings as needing to be entered again', async () => {
    await squareSavedUnderOldKey(h.world().users.corporate);
    const token = await login(h.server(), h.world().emails.corporate);
    const reply = await call(h.server(), 'GET', '/settings/payments', { token });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.secrets_unreadable, true);
    assert.deepEqual(reply.body.data.secrets_set, []);
  });

  it('can be replaced from Settings, and then work again', async () => {
    await squareSavedUnderOldKey(h.world().users.corporate);
    const token = await login(h.server(), h.world().emails.corporate);
    const body = {
      provider: 'square',
      is_enabled: true,
      settings: { environment: 'sandbox', application_id: 'sandbox-sq0idb-x', location_id: 'L1' },
      secrets: {},
      current_password: 'Password123!',
    };

    // Switching on with nothing typed: the token is asked for, not carried.
    const blank = await call(h.server(), 'PUT', '/settings/payments', { token, body });
    assert.equal(blank.status, 400);
    assert.match(blank.body.error.message, /Access token/);

    const saved = await call(h.server(), 'PUT', '/settings/payments', {
      token,
      body: { ...body, secrets: { access_token: 'EAAA-new-token' } },
    });
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.secrets_unreadable, false);
    assert.deepEqual(saved.body.data.secrets_set, ['access_token']);

    const config = await call(h.server(), 'GET', '/public/config');
    assert.equal(config.body.data.card_capture, true);
  });

  it('are told apart from credentials this server can read', () => {
    assert.match(encryptSecret('{}'), /^v1\./);
  });
});
