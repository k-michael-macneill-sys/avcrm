import { Readable } from 'node:stream';
import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { AuthenticatedUser, BranchScope } from '../types/auth';
import type { Upload, UploadPurpose } from '../types/models';
import { logger } from '../utils/logger';
import { notFound } from '../utils/errors';
import { getInvoice } from './invoices';
import { keyFor, storage, ruleFor } from './storage';
import { getWorkOrder } from './workOrders';
import {
  renderInvoice,
  renderServiceReport,
  type InvoiceDocument,
  type ServiceReportDocument,
} from './pdf/documents';

/**
 * Turning a row into something a customer can be handed.
 *
 * Rendered on request rather than on every change: most invoices are paid by
 * a card on file and never printed, and most visits are never asked about. A
 * document is generated the first time it is wanted and kept, then regenerated
 * when the thing it describes has moved on — a payment lands, a visit is
 * re-completed — so nobody is handed a PDF that disagrees with the screen.
 */

const PDF = 'application/pdf';

export interface GeneratedDocument {
  key: string;
  bytes: Buffer;
  /** The name a browser saves it under. */
  file_name: string;
}

/**
 * The stored copy, if there is one and it is still current. `freshAs` is the
 * row's own updated_at: anything rendered before that describes a version of
 * the record that no longer exists.
 */
async function cached(
  key: string | null,
  freshAs: Date,
  db: Knex,
): Promise<Upload | null> {
  if (!key) return null;

  const upload = await db('uploads').where({ key }).first();
  if (!upload || upload.status !== 'stored' || !upload.stored_at) return null;
  if (upload.stored_at < freshAs) return null;
  if (!(await storage.exists(key))) return null;

  return upload;
}

/**
 * Writes the bytes, points the record at them, and files the upload row.
 *
 * The order matters. Freshness is `stored_at` against the record's own
 * `updated_at`, and writing the key onto the record is itself an update —
 * so the upload row is inserted last, after that write has moved
 * `updated_at`. Filing it first would leave every document one second stale
 * on the moment it was made, and nothing would ever be served from store.
 */
async function store(
  purpose: UploadPurpose,
  fileName: string,
  bytes: Buffer,
  branchId: string,
  user: AuthenticatedUser,
  db: Knex,
  point: (key: string) => Promise<unknown>,
): Promise<string> {
  const key = keyFor(purpose, PDF);
  const stored = await storage.put(key, Readable.from(bytes), PDF, ruleFor(purpose).maxBytes);

  await point(key);

  await db('uploads').insert({
    key,
    purpose,
    content_type: PDF,
    file_name: fileName,
    byte_size: stored.byte_size,
    status: 'stored',
    uploaded_by_user_id: user.id,
    // The branch of the thing being described, not of whoever pressed the
    // button — a corporate user generating a Halifax invoice does not make
    // that document corporate's.
    branch_id: branchId,
    stored_at: new Date(),
  });

  return key;
}

export async function invoicePdf(
  invoiceId: string,
  scope: BranchScope,
  user: AuthenticatedUser,
  db: Knex = defaultDb,
): Promise<GeneratedDocument> {
  const invoice = await getInvoice(invoiceId, scope, db);
  const fileName = `invoice-${invoice.id.slice(0, 8)}.pdf`;

  const existing = await cached(invoice.pdf_url, invoice.updated_at, db);
  if (existing) {
    return { key: existing.key, bytes: await read(existing.key), file_name: fileName };
  }

  const context = (await db('contracts')
    .join('customers', 'customers.id', 'contracts.customer_id')
    .join('properties', 'properties.id', 'contracts.property_id')
    .join('quotes', 'quotes.id', 'contracts.quote_id')
    .join('branches', 'branches.id', 'customers.branch_id')
    .where('contracts.id', invoice.contract_id)
    .first([
      'customers.first_name',
      'customers.last_name',
      'customers.email',
      'customers.phone',
      'properties.address_line1',
      'properties.address_line2',
      'properties.city',
      'properties.province',
      'properties.postal_code',
      'branches.name as branch_name',
      'quotes.billing_type',
      'contracts.terms_version',
    ])) as Record<string, string | null> | undefined;

  if (!context) {
    throw notFound('The contract behind this invoice is missing');
  }

  const input: InvoiceDocument = {
    invoice,
    customer: {
      first_name: context.first_name ?? '',
      last_name: context.last_name ?? '',
      email: context.email ?? null,
      phone: context.phone ?? null,
    },
    property: {
      address_line1: context.address_line1 ?? '',
      address_line2: context.address_line2 ?? null,
      city: context.city ?? '',
      province: context.province ?? '',
      postal_code: context.postal_code ?? '',
    },
    branch: { name: context.branch_name ?? '' },
    contract: {
      billing_type: context.billing_type ?? '',
      terms_version: context.terms_version ?? '',
    },
    payments: invoice.payments,
  };

  const bytes = await renderInvoice(input);
  const key = await store('invoice_pdf', fileName, bytes, invoice.branch_id, user, db, (k) =>
    db('invoices').where({ id: invoice.id }).update({ pdf_url: k }),
  );

  logger.info({ invoice_id: invoice.id, key, bytes: bytes.length }, 'Invoice PDF rendered');
  return { key, bytes, file_name: fileName };
}

export async function serviceReportPdf(
  workOrderId: string,
  scope: BranchScope,
  user: AuthenticatedUser,
  db: Knex = defaultDb,
): Promise<GeneratedDocument> {
  const workOrder = await getWorkOrder(workOrderId, scope, db);
  const fileName = `service-report-${workOrder.id.slice(0, 8)}.pdf`;

  const existing = await cached(workOrder.report_pdf_url, workOrder.updated_at, db);
  if (existing) {
    return { key: existing.key, bytes: await read(existing.key), file_name: fileName };
  }

  // Starts at work_orders because the property comes off the visit, not off
  // the contract — a join cannot reference a table it has not reached yet.
  const context = (await db('work_orders')
    .join('contracts', 'contracts.id', 'work_orders.contract_id')
    .join('customers', 'customers.id', 'contracts.customer_id')
    .join('properties', 'properties.id', 'work_orders.property_id')
    .join('branches', 'branches.id', 'customers.branch_id')
    .where('work_orders.id', workOrder.id)
    .first([
      'customers.first_name',
      'customers.last_name',
      'properties.address_line1',
      'properties.address_line2',
      'properties.city',
      'properties.province',
      'properties.postal_code',
      'properties.priority_flag',
      'properties.access_notes',
      'branches.name as branch_name',
    ])) as Record<string, string | boolean | null> | undefined;

  if (!context) {
    throw notFound('The contract behind this work order is missing');
  }

  const operator = workOrder.assigned_user_id
    ? ((await db('users')
        .where({ id: workOrder.assigned_user_id })
        .first(['first_name', 'last_name'])) as { first_name: string; last_name: string } | undefined)
    : undefined;

  const photos = await Promise.all(
    workOrder.photos.map(async (photo) => ({
      photo_type: photo.photo_type,
      taken_at: photo.taken_at,
      latitude: photo.latitude,
      longitude: photo.longitude,
      image: await imageFor(photo.file_url),
    })),
  );

  const input: ServiceReportDocument = {
    workOrder,
    customer: {
      first_name: String(context.first_name ?? ''),
      last_name: String(context.last_name ?? ''),
    },
    property: {
      address_line1: String(context.address_line1 ?? ''),
      address_line2: context.address_line2 ? String(context.address_line2) : null,
      city: String(context.city ?? ''),
      province: String(context.province ?? ''),
      postal_code: String(context.postal_code ?? ''),
      priority_flag: Boolean(context.priority_flag),
      access_notes: context.access_notes ? String(context.access_notes) : null,
    },
    branch: { name: String(context.branch_name ?? '') },
    operator: operator ?? null,
    photos,
  };

  const bytes = await renderServiceReport(input);
  const key = await store(
    'service_report_pdf',
    fileName,
    bytes,
    workOrder.branch_id,
    user,
    db,
    (k) => db('work_orders').where({ id: workOrder.id }).update({ report_pdf_url: k }),
  );

  logger.info(
    { work_order_id: workOrder.id, key, bytes: bytes.length, photos: photos.length },
    'Service report rendered',
  );
  return { key, bytes, file_name: fileName };
}

function read(key: string): Promise<Buffer> {
  return collect(storage.read(key));
}

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * A photo's bytes, or null.
 *
 * A missing object is not an error here. Seeded rows point at keys that were
 * never uploaded, storage can lose a file, and pdfkit only embeds JPEG and
 * PNG — a WebP from a newer phone is a real case. Any of those produce a
 * report that says the photo could not be included, which is better than no
 * report at all.
 */
async function imageFor(key: string): Promise<Buffer | null> {
  try {
    if (!(await storage.exists(key))) return null;
    const bytes = await collect(storage.read(key));
    // pdfkit throws on anything that is not JPEG or PNG, so check the magic
    // number rather than trusting the extension.
    const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
    const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
    return isJpeg || isPng ? bytes : null;
  } catch (err) {
    logger.warn({ err, key }, 'A service photo could not be read for the report');
    return null;
  }
}
