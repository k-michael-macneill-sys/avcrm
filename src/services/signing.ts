import { Readable } from 'node:stream';
import jwt from 'jsonwebtoken';
import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import { CURRENT_TERMS_VERSION, type SigningRequest } from '../types/models';
import { badRequest, conflict, notFound, unauthorized } from '../utils/errors';
import { applyBranchScope } from '../utils/scope';
import {
  CARD_ON_FILE,
  createContract,
  listChecklistRequirements,
  type ContractWithChecklist,
} from './contracts';
import { enqueueMessage } from './messages';
import { keyFor, ruleFor, storage } from './storage';

/**
 * Signing from somewhere the rep is not.
 *
 * A lead from an online ad has nobody to hand a phone to, so they are emailed
 * a link instead: one page with the agreement, a signature box, and the
 * processor's card form. What they sign is the same quote, and what comes out
 * is the same contract as the door-to-door flow produces — the signature just
 * arrives from their browser rather than the rep's.
 *
 * The link is a signed token, the way an upload target is. The row it names
 * is what makes it single-use: a token that is still in date is refused once
 * the quote behind it has been signed.
 */

const TOKEN_TYPE = 'signing-request';
/** Long enough to survive a weekend and an unread inbox, short enough to expire. */
const DEFAULT_TTL_DAYS = 14;

interface SigningTokenPayload {
  typ: typeof TOKEN_TYPE;
  request_id: string;
}

export interface SigningRequestResult {
  request: SigningRequest;
  url: string;
}

/** What the customer's own page needs. No ids they cannot act on, no money they are not being asked for. */
export interface SigningInvitation {
  request_id: string;
  customer_name: string;
  customer_first_name: string;
  branch_name: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  province: string;
  postal_code: string;
  billing_type: string;
  initial_price: string;
  discounted_price: string;
  recurring_price: string | null;
  season_start: string;
  season_end: string;
  addon_salt: boolean;
  addon_vehicle: boolean;
  addon_stairs: boolean;
  expires_at: Date;
  terms_version: string;
  /** What the customer confirms before signing. The card comes after. */
  checklist: { code: string; label: string; is_required: boolean }[];
}

interface QuoteRow {
  quote_id: string;
  quote_status: string;
  customer_id: string;
  branch_id: string;
  branch_name: string;
  email: string | null;
  first_name: string;
  last_name: string;
  address_line1: string;
  address_line2: string | null;
  city: string;
  province: string;
  postal_code: string;
  billing_type: string;
  initial_price: string;
  discounted_price: string;
  recurring_price: string | null;
  season_start: string;
  season_end: string;
  addon_salt: boolean;
  addon_vehicle: boolean;
  addon_stairs: boolean;
}

const QUOTE_COLUMNS = [
  'quotes.id as quote_id',
  'quotes.status as quote_status',
  'quotes.billing_type',
  'quotes.initial_price',
  'quotes.discounted_price',
  'quotes.recurring_price',
  'quotes.season_start',
  'quotes.season_end',
  'quotes.addon_salt',
  'quotes.addon_vehicle',
  'quotes.addon_stairs',
  'customers.id as customer_id',
  'customers.branch_id',
  'customers.email',
  'customers.first_name',
  'customers.last_name',
  'branches.name as branch_name',
  'properties.address_line1',
  'properties.address_line2',
  'properties.city',
  'properties.province',
  'properties.postal_code',
];

function quoteQuery(db: Knex): Knex.QueryBuilder {
  return db('quotes')
    .join('properties', 'properties.id', 'quotes.property_id')
    .join('customers', 'customers.id', 'properties.customer_id')
    .join('branches', 'branches.id', 'customers.branch_id');
}

/**
 * Emails the customer a link to sign. Returns the link too: a rep who is on
 * the phone to them would rather read it out than wait for a mail server.
 */
export async function requestSignature(
  quoteId: string,
  scope: BranchScope,
  actorId: string,
  db: Knex = defaultDb,
): Promise<SigningRequestResult> {
  const quote = (await applyBranchScope(
    quoteQuery(db),
    'customers.branch_id',
    scope,
  )
    .andWhere('quotes.id', quoteId)
    .first(QUOTE_COLUMNS)) as unknown as QuoteRow | undefined;

  if (!quote) {
    throw notFound('Quote not found');
  }
  if (quote.quote_status !== 'presented' && quote.quote_status !== 'accepted') {
    throw conflict(`This quote is ${quote.quote_status} and cannot be sent for signature`);
  }
  if (!quote.email) {
    throw badRequest('That customer has no email address to send the agreement to');
  }

  const signed = await db('contracts').where({ quote_id: quoteId }).first('id');
  if (signed) {
    throw conflict('This quote has already been signed');
  }

  const expiresAt = new Date(Date.now() + DEFAULT_TTL_DAYS * 86_400_000);

  return db.transaction(async (trx) => {
    // Any invitation still outstanding is replaced: two live links to sign
    // the same quote is two ways to end up with two contracts.
    await trx('signing_requests')
      .where({ quote_id: quoteId, status: 'sent' })
      .update({ status: 'cancelled' });

    const [request] = await trx('signing_requests')
      .insert({
        quote_id: quoteId,
        customer_id: quote.customer_id,
        branch_id: quote.branch_id,
        sent_to: quote.email,
        status: 'sent',
        requested_by_user_id: actorId,
        expires_at: expiresAt,
      })
      .returning('*');
    if (!request) {
      throw new Error('Insert returned no signing_request row');
    }

    const url = signingUrl(request.id, expiresAt);

    await enqueueMessage(
      {
        template_code: 'signing_request',
        channel: 'email',
        recipient: quote.email!,
        branch_id: quote.branch_id,
        customer_id: quote.customer_id,
        context: {
          customer_first_name: quote.first_name,
          address_line1: quote.address_line1,
          branch_name: quote.branch_name,
          signing_url: url,
        },
      },
      trx,
    );

    return { request, url };
  });
}

/** What the public page shows before anyone signs anything. */
export async function openInvitation(
  token: string,
  db: Knex = defaultDb,
): Promise<SigningInvitation> {
  const request = await verified(token, db);

  const quote = (await quoteQuery(db)
    .where('quotes.id', request.quote_id)
    .first(QUOTE_COLUMNS)) as QuoteRow | undefined;
  if (!quote) {
    throw notFound('The quote this link points at no longer exists');
  }

  return {
    request_id: request.id,
    customer_name: `${quote.first_name} ${quote.last_name}`,
    customer_first_name: quote.first_name,
    branch_name: quote.branch_name,
    address_line1: quote.address_line1,
    address_line2: quote.address_line2,
    city: quote.city,
    province: quote.province,
    postal_code: quote.postal_code,
    billing_type: quote.billing_type,
    initial_price: quote.initial_price,
    discounted_price: quote.discounted_price,
    recurring_price: quote.recurring_price,
    season_start: quote.season_start,
    season_end: quote.season_end,
    addon_salt: quote.addon_salt,
    addon_vehicle: quote.addon_vehicle,
    addon_stairs: quote.addon_stairs,
    expires_at: request.expires_at,
    terms_version: CURRENT_TERMS_VERSION,
    checklist: (await listChecklistRequirements(db))
      .filter((r) => r.code !== CARD_ON_FILE)
      .map((r) => ({ code: r.code, label: r.label, is_required: r.is_required })),
  };
}

export interface RemoteSignatureInput {
  /** The drawn signature, as the PNG data URL a canvas produces. */
  signature_png: string;
  /** The checklist items the customer confirmed on the page. */
  confirmed: string[];
}

/** A signature is a few kilobytes; anything near this is not one. */
const MAX_SIGNATURE_BYTES = 512 * 1024;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * The customer has signed. Produces exactly what the door-to-door flow
 * produces, with the signature recorded as having come from their own
 * browser: user_id is null on the audit entry and on the stored image,
 * because no member of staff touched either.
 */
export async function completeInvitation(
  token: string,
  input: RemoteSignatureInput,
  ipAddress: string | null,
  db: Knex = defaultDb,
): Promise<{ contract: ContractWithChecklist; branch_id: string }> {
  const request = await verified(token, db);
  const bytes = decodeSignature(input.signature_png);

  // Stored before the contract, the same order the rep's phone uses. A
  // failure after this leaves an unreferenced image, never a contract
  // pointing at nothing.
  const key = keyFor('signature', 'image/png');
  const stored = await storage.put(
    key,
    Readable.from(bytes),
    'image/png',
    ruleFor('signature').maxBytes,
  );
  await db('uploads').insert({
    key,
    purpose: 'signature',
    content_type: 'image/png',
    file_name: 'signature.png',
    byte_size: stored.byte_size,
    status: 'stored',
    uploaded_by_user_id: null,
    branch_id: request.branch_id,
    stored_at: new Date(),
  });

  const requirements = await listChecklistRequirements(db);
  const confirmed = new Set(input.confirmed);

  return db.transaction(async (trx) => {
    // Locked so two submits of the same link cannot both get past here. The
    // unique index on contracts.quote_id would stop the second contract
    // anyway; this makes the second one a clean "already signed".
    const current = (await trx('signing_requests')
      .where({ id: request.id })
      .forUpdate()
      .first('status')) as { status: string } | undefined;
    if (current?.status !== 'sent') {
      throw conflict('This agreement has already been signed');
    }

    const contract = await createContract(
      request.quote_id,
      { kind: 'branch', branchId: request.branch_id },
      {
        signature_image_url: key,
        // Signed just now, from wherever they are: no rep location to
        // record, and no back-dating.
        signed_at: null,
        signed_lat: null,
        signed_lng: null,
        terms_version: CURRENT_TERMS_VERSION,
        checklist: requirements
          // The card is captured after this, on the processor's own page,
          // which ticks card_on_file itself when it lands.
          .filter((r) => r.code !== CARD_ON_FILE)
          .map((r) => ({ item_code: r.code, checked: confirmed.has(r.code) })),
        payment_method_token: null,
        payment_method_last4: null,
        payment_method_brand: null,
      },
      { user_id: null, ip_address: ipAddress },
      trx,
    );

    await trx('signing_requests').where({ id: request.id }).update({
      status: 'completed',
      completed_at: new Date(),
      contract_id: contract.id,
    });

    return { contract, branch_id: request.branch_id };
  });
}

function decodeSignature(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match?.[1]) {
    throw badRequest('signature_png must be a PNG data URL');
  }
  const bytes = Buffer.from(match[1], 'base64');
  if (bytes.length > MAX_SIGNATURE_BYTES) {
    throw badRequest('That signature image is too large');
  }
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, 8).equals(PNG_MAGIC)) {
    throw badRequest('signature_png is not a PNG');
  }
  return bytes;
}

/** Verifies the token, then the row it names. Both have to still be good. */
async function verified(token: string, db: Knex): Promise<SigningRequest> {
  let payload: SigningTokenPayload;
  try {
    payload = jwt.verify(token, config.auth.jwtSecret) as SigningTokenPayload;
  } catch {
    throw unauthorized('That signing link is not valid or has expired');
  }
  if (payload.typ !== TOKEN_TYPE || !payload.request_id) {
    throw unauthorized('That signing link is not valid');
  }

  const request = (await db('signing_requests')
    .where({ id: payload.request_id })
    .first('*')) as SigningRequest | undefined;

  if (!request) {
    throw unauthorized('That signing link is not valid');
  }
  if (request.status === 'completed') {
    throw conflict('This agreement has already been signed');
  }
  if (request.status !== 'sent') {
    throw unauthorized('That signing link is no longer active');
  }
  if (request.expires_at.getTime() <= Date.now()) {
    await db('signing_requests').where({ id: request.id }).update({ status: 'expired' });
    throw unauthorized('That signing link has expired');
  }

  return request;
}

function signingUrl(requestId: string, expiresAt: Date): string {
  const payload: SigningTokenPayload = { typ: TOKEN_TYPE, request_id: requestId };
  const token = jwt.sign(payload, config.auth.jwtSecret, {
    expiresIn: Math.max(1, Math.floor((expiresAt.getTime() - Date.now()) / 1000)),
  });
  return `${config.messaging.appBaseUrl}/app/sign/${token}`;
}
