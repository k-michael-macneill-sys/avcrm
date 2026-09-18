import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeCustomer } from './helpers/fixtures';
import { call, login } from './helpers/server';

/** A one-pixel PNG, so the bytes going in are real image bytes. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('putting files somewhere and reading them back', () => {
  const h = harness();

  async function issueTarget(token: string, purpose = 'signature', type = 'image/png') {
    const reply = await call(h.server(), 'POST', '/uploads', {
      token,
      body: { purpose, content_type: type, file_name: 'test.png' },
    });
    return reply;
  }

  it('issues a target the client sends bytes to, then serves them back', async () => {
    const token = await login(h.server(), h.world().emails.operator);
    const target = await issueTarget(token);

    assert.equal(target.status, 201);
    assert.match(target.body.data.upload_url, /^\/uploads\//);
    assert.equal(target.body.data.method, 'PUT');

    // No session on the PUT, exactly as there would not be with a bucket.
    const put = await fetch(`${h.server().url}${target.body.data.upload_url}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    assert.equal(put.status, 201);

    const read = await fetch(`${h.server().url}/files/${target.body.data.key}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    assert.equal(read.status, 200);
    assert.equal(read.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await read.arrayBuffer()), PNG);
  });

  it('refuses a content type the purpose does not allow', async () => {
    const token = await login(h.server(), h.world().emails.operator);
    const reply = await issueTarget(token, 'signature', 'application/pdf');

    assert.equal(reply.status, 400);
    assert.match(reply.body.error.message, /image\/png/);
  });

  it('refuses bytes that do not match the type that was signed', async () => {
    const token = await login(h.server(), h.world().emails.operator);
    const target = await issueTarget(token);

    const put = await fetch(`${h.server().url}${target.body.data.upload_url}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: PNG,
    });
    assert.equal(put.status, 400);
  });

  it('refuses a made-up upload token', async () => {
    const put = await fetch(`${h.server().url}/uploads/not-a-real-token`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });
    assert.equal(put.status, 403);
  });

  it('will not serve a file to another branch', async () => {
    const world = h.world();
    const token = await login(h.server(), world.emails.operator);
    const target = await issueTarget(token);

    await fetch(`${h.server().url}${target.body.data.upload_url}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      body: PNG,
    });

    const otherBranch = await login(h.server(), world.emails.halifaxOperator);
    const reply = await call(h.server(), 'GET', `/files/${target.body.data.key}`, {
      token: otherBranch,
    });
    assert.equal(reply.status, 403);
  });

  it('keeps an operator document between that operator and corporate', async () => {
    const world = h.world();
    const owner = await login(h.server(), world.emails.operator);
    const target = await issueTarget(owner, 'operator_document', 'application/pdf');

    await fetch(`${h.server().url}${target.body.data.upload_url}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/pdf' },
      body: Buffer.from('%PDF-1.4 not really'),
    });

    // The same branch is not enough for someone else's licence.
    await makeCustomer(world.branches.kingston, world.users.operator);
    const colleague = await login(h.server(), world.emails.pending);
    const refused = await call(h.server(), 'GET', `/files/${target.body.data.key}`, {
      token: colleague,
    });
    assert.equal(refused.status, 403);

    const corporate = await login(h.server(), world.emails.corporate);
    const allowed = await call(h.server(), 'GET', `/files/${target.body.data.key}`, {
      token: corporate,
    });
    assert.equal(allowed.status, 200);
  });

  it('says no such file rather than confirming a key exists', async () => {
    const token = await login(h.server(), h.world().emails.operator);
    const target = await issueTarget(token);

    // Issued but never sent: the row is pending, so there is nothing to read.
    const reply = await call(h.server(), 'GET', `/files/${target.body.data.key}`, { token });
    assert.equal(reply.status, 404);

    const row = await db('uploads').where({ key: target.body.data.key }).first();
    assert.equal(row?.status, 'pending');
  });

  it('refuses a key that tries to climb out of the store', async () => {
    const token = await login(h.server(), h.world().emails.operator);
    const reply = await call(h.server(), 'GET', '/files/../../etc/passwd', { token });
    assert.ok(reply.status === 400 || reply.status === 404, `got ${reply.status}`);
  });
});
