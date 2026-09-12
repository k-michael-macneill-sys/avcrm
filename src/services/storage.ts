import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { config } from '../config';
import type { UploadPurpose } from '../types/models';
import { badRequest } from '../utils/errors';

/**
 * Where files live.
 *
 * The interface is shaped like an object store on purpose: a key, some bytes,
 * a content type. The driver below writes to disk, which is a real
 * implementation rather than a stand-in — it works offline, needs no
 * credentials, and is the right answer for a single server. A bucket driver
 * implements the same three methods and changes nothing above it.
 *
 * What a bucket driver would add is a presigned PUT: `issueTarget` in
 * services/uploads.ts would hand the client the bucket's own URL instead of
 * this API's, and the PUT endpoint would stop being used. The client flow is
 * identical either way, which is the point of routing it through a target.
 */

export interface StoredObject {
  byte_size: number;
  content_type: string;
}

export interface StorageDriver {
  /** Writes the bytes, returning what actually landed. */
  put(key: string, body: Readable, contentType: string, maxBytes: number): Promise<StoredObject>;
  read(key: string): Readable;
  exists(key: string): Promise<boolean>;
  remove(key: string): Promise<void>;
}

/** What each kind of file is allowed to be. */
interface PurposeRule {
  prefix: string;
  contentTypes: string[];
  maxBytes: number;
}

const RULES: Record<UploadPurpose, PurposeRule> = {
  // A signature is a small PNG off a canvas.
  signature: {
    prefix: 'signatures',
    contentTypes: ['image/png'],
    maxBytes: 2 * 1024 * 1024,
  },
  // A phone photo, which can be large.
  service_photo: {
    prefix: 'service-photos',
    contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    maxBytes: 12 * 1024 * 1024,
  },
  operator_document: {
    prefix: 'operator-docs',
    contentTypes: ['application/pdf', 'image/jpeg', 'image/png'],
    maxBytes: 10 * 1024 * 1024,
  },
  contract_pdf: {
    prefix: 'contracts',
    contentTypes: ['application/pdf'],
    maxBytes: 10 * 1024 * 1024,
  },
  invoice_pdf: {
    prefix: 'invoices',
    contentTypes: ['application/pdf'],
    maxBytes: 10 * 1024 * 1024,
  },
  // Bigger than the others because a report carries the visit's photos.
  service_report_pdf: {
    prefix: 'service-reports',
    contentTypes: ['application/pdf'],
    maxBytes: 25 * 1024 * 1024,
  },
};

const EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export function ruleFor(purpose: UploadPurpose): PurposeRule {
  return RULES[purpose];
}

/** Rejects a content type the purpose does not allow, by name. */
export function assertAllowed(purpose: UploadPurpose, contentType: string): void {
  const rule = RULES[purpose];
  if (!rule.contentTypes.includes(contentType)) {
    throw badRequest(
      `A ${purpose.replace(/_/g, ' ')} must be ${rule.contentTypes.join(' or ')}, not ${contentType}`,
    );
  }
}

/**
 * A fresh key. The uuid is the filename, so nothing a user typed ever reaches
 * the filesystem and two uploads can never collide.
 */
export function keyFor(purpose: UploadPurpose, contentType: string): string {
  const rule = RULES[purpose];
  const now = new Date();
  const month = `${now.getUTCFullYear()}/${String(now.getUTCMonth() + 1).padStart(2, '0')}`;
  const extension = EXTENSIONS[contentType] ?? 'bin';
  return `${rule.prefix}/${month}/${randomUUID()}.${extension}`;
}

/**
 * Keys are generated, never supplied, but they arrive back from clients and
 * the database, so they are checked before touching a path. No traversal, no
 * absolute paths, no surprises.
 */
const KEY_PATTERN = /^[a-z0-9][a-z0-9/_-]*\.[a-z0-9]{1,8}$/;

export function assertValidKey(key: string): void {
  if (!KEY_PATTERN.test(key) || key.includes('..') || key.includes('//')) {
    throw badRequest('That is not a valid file key');
  }
}

/** Raised when the body runs past the purpose's limit. */
export class TooLarge extends Error {}

class LocalDriver implements StorageDriver {
  constructor(private readonly root: string) {}

  private pathFor(key: string): string {
    assertValidKey(key);
    const full = path.resolve(this.root, key);
    // Belt and braces: the pattern already forbids traversal, but a path that
    // escaped the root would be the one bug worth catching twice.
    if (!full.startsWith(`${path.resolve(this.root)}${path.sep}`)) {
      throw badRequest('That is not a valid file key');
    }
    return full;
  }

  async put(
    key: string,
    body: Readable,
    contentType: string,
    maxBytes: number,
  ): Promise<StoredObject> {
    const target = this.pathFor(key);
    await mkdir(path.dirname(target), { recursive: true });

    let written = 0;
    body.on('data', (chunk: Buffer) => {
      written += chunk.length;
      if (written > maxBytes) {
        body.destroy(new TooLarge(`That file is larger than the ${maxBytes} byte limit`));
      }
    });

    try {
      await pipeline(body, createWriteStream(target));
    } catch (err) {
      // Never leave half a file behind for something to serve later.
      await rm(target, { force: true });
      throw err;
    }

    if (written === 0) {
      await rm(target, { force: true });
      throw badRequest('That upload was empty');
    }

    return { byte_size: written, content_type: contentType };
  }

  read(key: string): Readable {
    return createReadStream(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }
}

export const storage: StorageDriver = new LocalDriver(config.storage.localDir);
