import path from 'node:path';
import { readFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import type { Knex } from 'knex';
import { PDFDocument, PDFCheckBox, PDFName, PDFRadioGroup, PDFTextField } from 'pdf-lib';
import {
  AGREEMENT_FIELDS,
  EDITABLE_AGREEMENT_FIELDS,
  agreementDate,
  type AgreementValues,
} from '../types/agreement';
import type { Customer, Property, Quote } from '../types/models';
import { badRequest } from '../utils/errors';
import { logger } from '../utils/logger';
import { keyFor, ruleFor, storage } from './storage';

/**
 * The company's own agreement, as the contract.
 *
 * The rep fills the PDF's fields in on screen; those values are both what the
 * CRM stores (customer, address, price, season) and what is printed back
 * into the PDF, signature on the signature line, when it is signed.
 */

/** Resolved from this file, so it works from src/ under tsx and dist/ after a build. */
export const AGREEMENT_TEMPLATE = path.resolve(
  __dirname,
  '..',
  '..',
  'assets',
  'contracts',
  'snow-removal-agreement.pdf',
);

let template: Buffer | null = null;
function templateBytes(): Buffer {
  template ??= readFileSync(AGREEMENT_TEMPLATE);
  return template;
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
const yearOk = (v: string): boolean => /^\d{2}$/.test(v);
const priceOf = (v: string): number | null => {
  const n = Number(v.replace(/[$,\s]/g, ''));
  return v !== '' && Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : null;
};

/**
 * Only the fields a person fills in, trimmed, with everything the page could
 * not have meant dropped. Signatures and dates are the server's to fill.
 */
export function cleanAgreement(raw: unknown): AgreementValues {
  const input = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const out: AgreementValues = {};
  for (const field of EDITABLE_AGREEMENT_FIELDS) {
    const value = input[field.name];
    if (field.kind === 'check') out[field.name] = value === true;
    else out[field.name] = text(value).slice(0, field.kind === 'notes' ? 2000 : 200);
  }
  return out;
}

/** Refuses an agreement that cannot become a customer and a price, naming every gap at once. */
export function assertAgreementComplete(values: AgreementValues): void {
  const problems: { path: string; message: string }[] = [];
  const need = (name: string, message: string) => problems.push({ path: `agreement.${name}`, message });
  const v = (name: string) => text(values[name]);

  if (v('customer_name').split(/\s+/).filter(Boolean).length < 2) {
    need('customer_name', 'Enter the customer’s first and last name');
  }
  for (const [name, label] of [
    ['customer_street', 'street address'],
    ['customer_city', 'city'],
    ['customer_province', 'province'],
    ['customer_postal', 'postal code'],
  ] as const) {
    if (!v(name)) need(name, `Enter the ${label}`);
  }
  if (!v('customer_email') && !v('customer_phone')) need('customer_email', 'Enter an email or a phone number');
  if (v('customer_email') && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v('customer_email'))) {
    need('customer_email', 'That email address does not look right');
  }
  if (!yearOk(v('start_year'))) need('start_year', 'Enter the start year as two digits, e.g. 26');
  if (!yearOk(v('end_year'))) need('end_year', 'Enter the end year as two digits, e.g. 27');
  if (yearOk(v('start_year')) && yearOk(v('end_year')) && Number(v('end_year')) <= Number(v('start_year'))) {
    need('end_year', 'The season has to end after it starts');
  }
  const pkg = v('package');
  if (pkg !== 'Basic' && pkg !== 'Premium') need('package', 'Choose the Basic or Premium package');
  else if (priceOf(v(pkg === 'Basic' ? 'price_basic' : 'price_premium')) === null) {
    need(pkg === 'Basic' ? 'price_basic' : 'price_premium', `Enter the ${pkg} price per month`);
  }

  if (problems.length) {
    throw badRequest(problems.map((p) => p.message).join('. ') + '.', problems);
  }
}

export interface AgreementDeal {
  customer: {
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
    preferred_contact: 'email' | 'sms';
  };
  property: {
    address_line1: string;
    city: string;
    province: string;
    postal_code: string;
    access_notes: string | null;
  };
  quote: {
    billing_type: 'monthly';
    initial_price: number;
    discounted_price: number;
    recurring_price: number;
    season_start: string;
    season_end: string;
    package: 'basic' | 'premium';
    addons: string[];
    agreement_fields: AgreementValues;
  };
}

/** What the CRM keeps from a completed agreement. The agreement is monthly, November to March. */
export function dealFromAgreement(values: AgreementValues): AgreementDeal {
  assertAgreementComplete(values);
  const v = (name: string) => text(values[name]);
  const names = v('customer_name').split(/\s+/);
  const premium = v('package') === 'Premium';
  const price = priceOf(v(premium ? 'price_premium' : 'price_basic'))!;
  const email = v('customer_email') || null;

  return {
    customer: {
      first_name: names.slice(0, -1).join(' '),
      last_name: names[names.length - 1]!,
      email,
      phone: v('customer_phone') || null,
      preferred_contact: email ? 'email' : 'sms',
    },
    property: {
      address_line1: v('customer_street'),
      city: v('customer_city'),
      province: v('customer_province'),
      postal_code: v('customer_postal'),
      access_notes: v('customer_notes') || null,
    },
    quote: {
      billing_type: 'monthly',
      initial_price: price,
      discounted_price: price,
      recurring_price: price,
      season_start: `20${v('start_year')}-11-01`,
      season_end: `20${v('end_year')}-03-31`,
      package: premium ? 'premium' : 'basic',
      addons: AGREEMENT_FIELDS.filter((f) => f.name.startsWith('addon_') && values[f.name] === true).map((f) =>
        f.name.slice('addon_'.length),
      ),
      agreement_fields: values,
    },
  };
}

/**
 * The agreement as far as a deal from before the PDF sign-up can say, for
 * showing that customer the same document when they sign by emailed link.
 */
export function agreementFromDeal(
  customer: Pick<Customer, 'first_name' | 'last_name' | 'email' | 'phone'>,
  property: Pick<Property, 'address_line1' | 'city' | 'province' | 'postal_code' | 'access_notes'>,
  quote: Pick<Quote, 'season_start' | 'season_end' | 'recurring_price' | 'discounted_price'> & {
    agreement_fields?: AgreementValues | null;
  },
): AgreementValues {
  if (quote.agreement_fields) return quote.agreement_fields;
  const year = (d: unknown) => String(new Date(String(d)).getUTCFullYear() % 100).padStart(2, '0');
  return cleanAgreement({
    customer_name: `${customer.first_name} ${customer.last_name}`,
    customer_street: property.address_line1,
    customer_city: property.city,
    customer_province: property.province,
    customer_postal: property.postal_code,
    customer_phone: customer.phone ?? '',
    customer_email: customer.email ?? '',
    start_year: year(quote.season_start),
    end_year: year(quote.season_end),
    package: 'Basic',
    price_basic: String(quote.recurring_price ?? quote.discounted_price),
    customer_notes: property.access_notes ?? '',
  });
}

/** The standard PDF fonts only cover Latin-1; anything else would stop the fill. */
function printable(value: string): string {
  return value.replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\xff\n]/g, '');
}

export interface AgreementSignatures {
  customer?: Buffer | null;
  provider?: Buffer | null;
  signedAt?: Date;
}

/** The agreement filled in, signatures on their lines, and flattened so it cannot be edited after. */
export async function renderAgreement(values: AgreementValues, signatures: AgreementSignatures = {}): Promise<Buffer> {
  const doc = await PDFDocument.load(templateBytes());
  const form = doc.getForm();
  const when = agreementDate(signatures.signedAt ?? new Date());

  // The tinted boxes are a hint for someone filling it in on a computer; on
  // the signed copy they would read as highlighting, and cover the ink.
  for (const field of form.getFields()) {
    for (const widget of field.acroField.getWidgets()) {
      widget.getAppearanceCharacteristics()?.dict.delete(PDFName.of('BG'));
    }
  }

  // Where the signatures go, noted before flattening removes the fields.
  const lines = new Map<string, { page: ReturnType<PDFDocument['getPage']>; box: { x: number; y: number; width: number; height: number } }>();
  for (const name of ['customer_signature', 'provider_signature']) {
    const widget = form.getFieldMaybe(name)?.acroField.getWidgets()[0];
    if (!widget) continue;
    const page = doc.getPages().find((p) => p.ref === widget.P()) ?? doc.getPage(0);
    lines.set(name, { page, box: widget.getRectangle() });
  }

  for (const spec of AGREEMENT_FIELDS) {
    const field = form.getFieldMaybe(spec.name);
    if (!field) {
      logger.warn({ field: spec.name }, 'The agreement PDF has no field by that name');
      continue;
    }
    if (field instanceof PDFCheckBox) {
      if (values[spec.name] === true) field.check();
      else field.uncheck();
    } else if (field instanceof PDFRadioGroup) {
      const choice = text(values[spec.name]);
      if (field.getOptions().includes(choice)) field.select(choice);
    } else if (field instanceof PDFTextField) {
      let value = '';
      if (spec.kind === 'date') {
        const signer = spec.name.startsWith('customer') ? signatures.customer : signatures.provider;
        value = signer ? when : '';
      } else if (spec.kind !== 'signature') {
        value = text(values[spec.name]);
        if (spec.kind === 'money' && value) value = value.replace(/^\$/, '');
      }
      if (spec.kind === 'notes') field.enableMultiline();
      field.setText(printable(value));
    }
  }

  form.flatten();

  // After flattening, so nothing the form draws can cover the ink.
  for (const [name, png] of [
    ['customer_signature', signatures.customer],
    ['provider_signature', signatures.provider],
  ] as const) {
    const line = lines.get(name);
    if (!png || !line) continue;
    const image = await doc.embedPng(png);
    // Sits on the line and rises a little above it, the way ink does.
    const { box } = line;
    const scale = Math.min(box.width / image.width, (box.height * 1.7) / image.height);
    const w = image.width * scale;
    const h = image.height * scale;
    line.page.drawImage(image, { x: box.x + (box.width - w) / 2, y: box.y - 1, width: w, height: h });
  }

  return Buffer.from(await doc.save());
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

/**
 * Produces the signed agreement for a contract that was signed against a
 * filled-in PDF, stores it, and points the contract at it. Runs inside the
 * signing transaction, so a contract never exists without its document.
 */
export async function attachSignedAgreement(
  trx: Knex.Transaction,
  input: {
    contractId: string;
    branchId: string;
    values: AgreementValues;
    customerSignatureKey: string;
    providerSignatureKey: string | null;
    signedAt: Date;
  },
): Promise<string> {
  const customer = await readAll(storage.read(input.customerSignatureKey));
  const provider = input.providerSignatureKey ? await readAll(storage.read(input.providerSignatureKey)) : null;
  const bytes = await renderAgreement(input.values, { customer, provider, signedAt: input.signedAt });

  const key = keyFor('contract_pdf', 'application/pdf');
  const stored = await storage.put(key, Readable.from(bytes), 'application/pdf', ruleFor('contract_pdf').maxBytes);
  await trx('uploads').insert({
    key,
    purpose: 'contract_pdf',
    content_type: 'application/pdf',
    file_name: 'signed-agreement.pdf',
    byte_size: stored.byte_size,
    status: 'stored',
    uploaded_by_user_id: null,
    branch_id: input.branchId,
    stored_at: new Date(),
  });
  await trx('contracts').where({ id: input.contractId }).update({ pdf_url: key });
  return key;
}
