import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { redactPath } from '../src/middleware/requestLogger';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeContract, makeCustomer, makeQuote, makeWorkOrder } from './helpers/fixtures';
import { call, login } from './helpers/server';

/** A one-pixel PNG, so the bytes going in are real image bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('who may say money arrived', () => {
  const h = harness();

  /** A bill a customer has been sent, as corporate makes one. */
  async function sentInvoice(): Promise<string> {
    const world = h.world();
    const contract = await makeContract(world.branches.kingston, world.users.sales);
    const corporate = await login(h.server(), world.emails.corporate);
    const created = await call(h.server(), 'POST', '/invoices', {
      token: corporate,
      body: {
        contract_id: contract.contract_id,
        billing_period_start: '2027-01-01',
        billing_period_end: '2027-01-31',
        amount_due: 109,
        due_date: '2027-01-15',
      },
    });
    await call(h.server(), 'POST', `/invoices/${created.body.data.id}/send`, { token: corporate });
    return created.body.data.id as string;
  }

  const cash = { amount: 109, method: 'cash', status: 'succeeded' };

  it('refuses crew, reps and the branch sign-in, who could otherwise mark any bill paid', async () => {
    const invoice = await sentInvoice();
    const world = h.world();
    const branch = await call(h.server(), 'POST', '/auth/sign-in', {
      body: { choice: 'Kingston', password: '1234' },
    });

    for (const token of [
      await login(h.server(), world.emails.operator),
      await login(h.server(), world.emails.sales),
      branch.body.data.token as string,
    ]) {
      const reply = await call(h.server(), 'POST', `/invoices/${invoice}/payments`, { token, body: cash });
      assert.equal(reply.status, 403);
    }

    const row = await db('invoices').where({ id: invoice }).first();
    assert.equal(row?.status, 'sent');
    assert.equal(Number(row?.amount_paid), 0);
  });

  it('still lets corporate book a cheque', async () => {
    const invoice = await sentInvoice();
    const corporate = await login(h.server(), h.world().emails.corporate);

    const reply = await call(h.server(), 'POST', `/invoices/${invoice}/payments`, {
      token: corporate,
      body: cash,
    });
    assert.equal(reply.status, 201);
    assert.equal(reply.body.data.status, 'paid');
  });
});

describe('changing a password', () => {
  const h = harness();
  const NEW = 'a-much-better-password';

  it('takes the current one, signs every other session out, and hands back a new one', async () => {
    const world = h.world();
    const old = await login(h.server(), world.emails.operator);
    // Tokens carry whole seconds: one issued in the same second as the
    // change would be indistinguishable from one issued after it.
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const reply = await call(h.server(), 'POST', '/auth/password', {
      token: old,
      body: { current_password: 'Password123!', new_password: NEW },
    });
    assert.equal(reply.status, 200);

    const stale = await call(h.server(), 'GET', '/auth/me', { token: old });
    assert.equal(stale.status, 401);

    const fresh = await call(h.server(), 'GET', '/auth/me', { token: reply.body.data.token });
    assert.equal(fresh.status, 200);

    assert.ok(await login(h.server(), world.emails.operator, NEW));
    const before = await call(h.server(), 'POST', '/auth/login', {
      body: { email: world.emails.operator, password: 'Password123!' },
    });
    assert.equal(before.status, 401);

    const audit = await db('audit_log').where({ action: 'user.password_changed' }).first();
    assert.equal(audit?.entity_id, world.users.operator);
  });

  it('refuses a wrong current password, and a short new one', async () => {
    const token = await login(h.server(), h.world().emails.sales);

    const wrong = await call(h.server(), 'POST', '/auth/password', {
      token,
      body: { current_password: 'not-my-password', new_password: NEW },
    });
    // Not 401, which the app reads as "signed out".
    assert.equal(wrong.status, 403);

    const short = await call(h.server(), 'POST', '/auth/password', {
      token,
      body: { current_password: 'Password123!', new_password: 'short' },
    });
    assert.equal(short.status, 400);
  });

  it('has nothing to change for a branch sign-in, whose password is the server’s', async () => {
    const branch = await call(h.server(), 'POST', '/auth/sign-in', {
      body: { choice: 'Kingston', password: '1234' },
    });
    const reply = await call(h.server(), 'POST', '/auth/password', {
      token: branch.body.data.token,
      body: { current_password: '1234', new_password: NEW },
    });
    assert.equal(reply.status, 403);
  });

  it('lets corporate set a temporary password for someone locked out, and records that it did', async () => {
    const world = h.world();
    const corporate = await login(h.server(), world.emails.corporate);
    const theirs = await login(h.server(), world.emails.operator);
    await new Promise((resolve) => setTimeout(resolve, 1100));

    const reply = await call(h.server(), 'PATCH', `/users/${world.users.operator}`, {
      token: corporate,
      body: { password: 'temporary-password-1' },
    });
    assert.equal(reply.status, 200);
    assert.equal(reply.body.data.password_hash, undefined);

    assert.ok(await login(h.server(), world.emails.operator, 'temporary-password-1'));
    assert.equal((await call(h.server(), 'GET', '/auth/me', { token: theirs })).status, 401);
    assert.ok(await db('audit_log').where({ action: 'user.password_reset', entity_id: world.users.operator }).first());
  });
});

describe('a token is only what it was issued as', () => {
  const h = harness();

  it('will not take an upload link as a sign-in', async () => {
    const token = await login(h.server(), h.world().emails.operator);
    const target = await call(h.server(), 'POST', '/uploads', {
      token,
      body: { purpose: 'signature', content_type: 'image/png', file_name: 'x.png' },
    });
    const uploadToken = String(target.body.data.upload_url).replace('/uploads/', '');

    const reply = await call(h.server(), 'GET', '/auth/me', { token: uploadToken });
    assert.equal(reply.status, 401);
  });
});

describe('filing a file someone else uploaded', () => {
  const h = harness();

  /** Uploads bytes as the holder of `token`, and returns the key. */
  async function upload(token: string, purpose: string): Promise<string> {
    const target = await call(h.server(), 'POST', '/uploads', {
      token,
      body: { purpose, content_type: 'image/png', file_name: 'x.png' },
    });
    const put = await fetch(`${h.server().url}${target.body.data.upload_url}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    assert.equal(put.status, 201);
    return target.body.data.key as string;
  }

  it('refuses another branch’s file as a signature, since the agreement PDF would carry it', async () => {
    const world = h.world();
    const halifax = await login(h.server(), world.emails.halifaxSales);
    const theirs = await upload(halifax, 'signature');

    const made = await makeCustomer(world.branches.kingston, world.users.sales);
    const quote = await makeQuote(made.property_id, world.users.sales, { status: 'presented' });
    const kingston = await login(h.server(), world.emails.sales);

    const reply = await call(h.server(), 'POST', '/contracts', {
      token: kingston,
      body: { quote_id: quote, signature_image_url: theirs, terms_version: 'v1', checklist: [] },
    });
    assert.equal(reply.status, 403);
  });

  it('refuses a file uploaded as something else', async () => {
    const world = h.world();
    const kingston = await login(h.server(), world.emails.sales);
    const photo = await upload(kingston, 'service_photo');

    const made = await makeCustomer(world.branches.kingston, world.users.sales);
    const quote = await makeQuote(made.property_id, world.users.sales, { status: 'presented' });

    const reply = await call(h.server(), 'POST', '/contracts', {
      token: kingston,
      body: { quote_id: quote, signature_image_url: photo, terms_version: 'v1', checklist: [] },
    });
    assert.equal(reply.status, 400);
  });

  it('takes the signer’s own upload, as the door-to-door flow sends it', async () => {
    const world = h.world();
    const kingston = await login(h.server(), world.emails.sales);
    const mine = await upload(kingston, 'signature');

    const made = await makeCustomer(world.branches.kingston, world.users.sales);
    const quote = await makeQuote(made.property_id, world.users.sales, { status: 'presented' });

    const reply = await call(h.server(), 'POST', '/contracts', {
      token: kingston,
      body: { quote_id: quote, signature_image_url: mine, terms_version: 'v1', checklist: [] },
    });
    assert.equal(reply.status, 201);
  });

  it('refuses another branch’s photo on a visit, since the service report would carry it', async () => {
    const world = h.world();
    const halifax = await login(h.server(), world.emails.halifaxOperator);
    const theirs = await upload(halifax, 'service_photo');

    const contract = await makeContract(world.branches.kingston, world.users.operator);
    const visit = await makeWorkOrder(contract, world.branches.kingston, {
      assigned_user_id: world.users.operator,
      status: 'in_progress',
      started_at: new Date(),
    });
    const operator = await login(h.server(), world.emails.operator);

    const reply = await call(h.server(), 'POST', `/work-orders/${visit}/photos`, {
      token: operator,
      body: {
        photo_type: 'before',
        file_url: theirs,
        taken_at: new Date(Date.now() - 60_000).toISOString(),
        latitude: null,
        longitude: null,
      },
    });
    assert.equal(reply.status, 403);
  });
});

describe('what the browser is told', () => {
  const h = harness();

  it('forbids framing and sniffing on every response, and loading anything into JSON', async () => {
    const reply = await call(h.server(), 'GET', '/health');
    assert.equal(reply.headers.get('x-frame-options'), 'DENY');
    assert.equal(reply.headers.get('x-content-type-options'), 'nosniff');
    assert.match(reply.headers.get('content-security-policy') ?? '', /default-src 'none'/);
    assert.match(reply.headers.get('content-security-policy') ?? '', /frame-ancestors 'none'/);
  });

  it('lets the app run only its own scripts', async () => {
    const reply = await call(h.server(), 'GET', '/app/login');
    const policy = reply.headers.get('content-security-policy') ?? '';
    assert.match(policy, /script-src 'self'/);
    assert.doesNotMatch(policy, /'unsafe-inline'[^;]*;\s*style-src/);
    assert.match(policy, /frame-ancestors 'none'/);
  });

  it('serves a stored file sandboxed, so one that is really a page cannot run', async () => {
    const token = await login(h.server(), h.world().emails.operator);
    const target = await call(h.server(), 'POST', '/uploads', {
      token,
      body: { purpose: 'signature', content_type: 'image/png', file_name: 'x.png' },
    });
    await fetch(`${h.server().url}${target.body.data.upload_url}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });

    const reply = await call(h.server(), 'GET', `/files/${target.body.data.key}`, { token });
    assert.equal(reply.status, 200);
    assert.match(reply.headers.get('content-security-policy') ?? '', /sandbox/);
  });
});

describe('what goes in the log', () => {
  it('keeps the capability out of every customer link', () => {
    const token = 'AbCdEfGhIjKlMnOpQrStUvWx12';
    assert.equal(redactPath(`/pay/${token}`), '/pay/[redacted]');
    assert.equal(redactPath(`/pay/card/sqs_${token}`), '/pay/card/[redacted]');
    assert.equal(redactPath(`/portal/invoices/${token}/pay`), '/portal/invoices/[redacted]/pay');
    assert.equal(redactPath(`/portal/cards/${token}`), '/portal/cards/[redacted]');
    assert.equal(redactPath('/public/sign/eyJ.a.b'), '/public/sign/[redacted]');
    assert.equal(redactPath('/app/sign/eyJ.a.b'), '/app/sign/[redacted]');
    assert.equal(redactPath('/uploads/eyJ.a.b'), '/uploads/[redacted]');
    assert.equal(redactPath(`/public/unsubscribe/${token}`), '/public/unsubscribe/[redacted]');
    assert.equal(
      redactPath('/review-requests/7f0c2a52-0000-4000-8000-000000000000/rate?rating=5'),
      '/review-requests/[redacted]/rate?rating=5',
    );
    assert.equal(redactPath('/webhooks/meta?hub.verify_token=secret'), '/webhooks/meta?[redacted]');
    // Ordinary paths are left alone.
    assert.equal(redactPath('/customers?search=bell'), '/customers?search=bell');
  });
});
