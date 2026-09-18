import type { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { AuthenticatedUser } from '../types/auth';
import type { Upload, UploadPurpose } from '../types/models';
import { badRequest, forbidden, notFound } from '../utils/errors';
import { logger } from '../utils/logger';
import {
  assertAllowed,
  assertValidKey,
  keyFor,
  ruleFor,
  storage,
  TooLarge,
} from './storage';

/**
 * Uploading is two steps, the way an object store does it: ask for a target,
 * then send the bytes to it.
 *
 * The target carries a short-lived signed token, so the URL itself is the
 * permission — the same shape as a presigned PUT. Swapping the local driver
 * for a bucket means handing back the bucket's URL here and nothing else
 * changing, on either side.
 */

/** Marks the token as an upload grant, so a login JWT cannot stand in for one. */
const TOKEN_TYPE = 'upload';

interface UploadTokenPayload {
  typ: string;
  upload_id: string;
  key: string;
  content_type: string;
  max_bytes: number;
}

export interface UploadTarget {
  upload_id: string;
  key: string;
  /** Where to send the bytes. Relative here; absolute for a bucket. */
  upload_url: string;
  method: 'PUT';
  content_type: string;
  max_bytes: number;
  expires_at: string;
}

export interface IssueInput {
  purpose: UploadPurpose;
  content_type: string;
  file_name: string | null;
}

export async function issueTarget(
  input: IssueInput,
  user: AuthenticatedUser,
  db: Knex = defaultDb,
): Promise<UploadTarget> {
  assertAllowed(input.purpose, input.content_type);

  const rule = ruleFor(input.purpose);
  const key = keyFor(input.purpose, input.content_type);

  const [upload] = await db('uploads')
    .insert({
      key,
      purpose: input.purpose,
      content_type: input.content_type,
      file_name: input.file_name,
      status: 'pending',
      uploaded_by_user_id: user.id,
      branch_id: user.branch_id,
    })
    .returning('*');
  if (!upload) {
    throw new Error('Insert returned no upload row');
  }

  const payload: UploadTokenPayload = {
    typ: TOKEN_TYPE,
    upload_id: upload.id,
    key,
    content_type: input.content_type,
    max_bytes: rule.maxBytes,
  };

  const token = jwt.sign(payload, config.auth.jwtSecret, {
    expiresIn: config.storage.uploadTtlSeconds,
  });

  return {
    upload_id: upload.id,
    key,
    upload_url: `/uploads/${token}`,
    method: 'PUT',
    content_type: input.content_type,
    max_bytes: rule.maxBytes,
    expires_at: new Date(
      Date.now() + config.storage.uploadTtlSeconds * 1000,
    ).toISOString(),
  };
}

/**
 * Takes the bytes. Authorized by the token alone — there is no session here,
 * exactly as there would not be when a browser PUTs to a bucket.
 */
export async function acceptBytes(
  token: string,
  headerContentType: string | undefined,
  contentLength: string | undefined,
  body: Readable,
  db: Knex = defaultDb,
): Promise<Upload> {
  let payload: UploadTokenPayload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret) as UploadTokenPayload;
  } catch {
    throw forbidden('That upload link has expired or is not valid');
  }
  if (payload.typ !== TOKEN_TYPE) {
    throw forbidden('That is not an upload token');
  }

  // The declared type is part of what was signed, so it cannot be swapped for
  // something the purpose does not allow.
  const declared = (headerContentType ?? '').split(';')[0]?.trim();
  if (declared && declared !== payload.content_type) {
    throw badRequest(
      `This target is for ${payload.content_type}, not ${declared}`,
    );
  }

  // Refuse on the declared length before reading a byte: the client gets a
  // clear answer instead of a reset connection, and nothing crosses the wire
  // for nothing. The streaming cap below still backstops a client that lies
  // or sends chunked.
  const declaredLength = Number(contentLength);
  if (Number.isFinite(declaredLength) && declaredLength > payload.max_bytes) {
    throw badRequest(
      `That file is ${declaredLength} bytes; the limit here is ${payload.max_bytes}`,
    );
  }

  const upload = await db('uploads').where({ id: payload.upload_id }).first();
  if (!upload) {
    throw notFound('That upload is not on file');
  }
  if (upload.status === 'stored') {
    throw badRequest('Those bytes have already been uploaded');
  }

  let stored;
  try {
    stored = await storage.put(payload.key, body, payload.content_type, payload.max_bytes);
  } catch (err) {
    if (err instanceof TooLarge) {
      throw badRequest(err.message);
    }
    throw err;
  }

  const [updated] = await db('uploads')
    .where({ id: payload.upload_id })
    .update({
      status: 'stored',
      byte_size: stored.byte_size,
      stored_at: new Date(),
    })
    .returning('*');
  if (!updated) {
    throw notFound('That upload is not on file');
  }

  logger.info(
    { key: payload.key, bytes: stored.byte_size, purpose: updated.purpose },
    'Upload stored',
  );
  return updated;
}

/**
 * Who may read a file.
 *
 * An operator's documents are their own business: only they and corporate
 * see those, matching the rule on /operators/:id/documents. Everything else
 * is readable by the branch it belongs to, because a photo of a driveway is
 * the branch's record of the work.
 */
export async function authorizeRead(
  key: string,
  user: AuthenticatedUser,
  db: Knex = defaultDb,
): Promise<Upload> {
  assertValidKey(key);

  const upload = await db('uploads').where({ key }).first();
  if (!upload || upload.status !== 'stored') {
    // A key with no bytes behind it is a miss, not a permission problem —
    // saying otherwise would confirm which keys exist.
    throw notFound('No such file');
  }

  if (user.role === 'corporate') return upload;
  if (upload.uploaded_by_user_id === user.id) return upload;

  if (upload.purpose === 'operator_document') {
    throw forbidden('Those documents are between that operator and corporate');
  }
  if (upload.branch_id && upload.branch_id === user.branch_id) return upload;

  throw forbidden('That file belongs to another branch');
}

export function readStream(key: string): Readable {
  return storage.read(key);
}
