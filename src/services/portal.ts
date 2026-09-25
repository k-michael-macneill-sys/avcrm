import { Readable } from 'node:stream';
import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { CardSetup, Invoice } from '../types/models';
import { ApiError, badRequest, conflict, notFound } from '../utils/errors';
import { logger } from '../utils/logger';
import { applyBranchScope } from '../utils/scope';
import { recordAudit } from './audit';
import { finishSetup, isSquareSession } from './cards';
import {
  activeGateway,
  fromMinorUnits,
  toMinorUnits,
  type PaymentGateway,
  type PortalConfig,
} from './gateway';
import { addMonths, ensurePortalToken, payUrl } from './invoices';
import { recordPayment } from './payments';
import { keyFor as storageKeyFor, ruleFor, storage } from './storage';

/**
 * The customer's side of billing: a link in their invoice email that shows
 * what they owe and lets them pay it, and the link that puts a card on file.
 *
 * The customer has no account and never will, so the random token in the
 * link is the capability — the same idea as the one-tap review link. It only
 * ever shows what the customer's own bill already says, and the one thing it
 * can do is pay that bill.
 *
 * The card is typed into the processor's own form, drawn in an iframe on the
 * page. What reaches this server is a single-use nonce, never a card number.
 */

/** Only a bill the customer has been sent can be paid from its link. */
const PORTAL_PAYABLE = ['sent', 'overdue'];

/** For staff: the link to read out, text, or paste into an email. */
export async function payLinkFor(
  invoiceId: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<{ url: string; takes_payments: boolean }> {
  const invoice = (await applyBranchScope(db('invoices'), 'branch_id', scope)
    .andWhere({ id: invoiceId })
    .first()) as Invoice | undefined;
  if (!invoice) {
    throw notFound('Invoice not found');
  }
  if (invoice.status === 'draft' || invoice.status === 'void') {
    throw conflict(
      invoice.status === 'draft'
        ? 'Send this invoice before sharing a link to it'
        : 'This invoice is void, so there is nothing to pay',
    );
  }

  const token = await ensurePortalToken(invoice.id, db);
  const gateway = await activeGateway(db);
  return { url: payUrl(token), takes_payments: gateway.takesPortalPayments };
}

export interface PortalInvoice {
  status: string;
  branch_name: string;
  customer_first_name: string;
  address_line1: string;
  billing_period_start: string;
  billing_period_end: string;
  due_date: string;
  amount_due: string;
  amount_paid: string;
  amount_outstanding: string;
  currency: string;
  can_pay: boolean;
  /** What the page needs to draw the card form; null when it cannot take one. */
  payment: PortalConfig | null;
}

interface PortalInvoiceRow {
  id: string;
  status: string;
  branch_name: string;
  customer_first_name: string;
  square_customer_id: string | null;
  address_line1: string;
  billing_period_start: string;
  billing_period_end: string;
  due_date: string;
  amount_due: string;
  amount_paid: string;
}

async function invoiceByToken(token: string, db: Knex): Promise<PortalInvoiceRow> {
  const row = (await db('invoices')
    .join('customers', 'customers.id', 'invoices.customer_id')
    .join('contracts', 'contracts.id', 'invoices.contract_id')
    .join('properties', 'properties.id', 'contracts.property_id')
    .join('branches', 'branches.id', 'invoices.branch_id')
    .where('invoices.portal_token', token)
    // A draft never has a token, but a link must never outlive what it shows.
    .whereNot('invoices.status', 'draft')
    .first([
      'invoices.id',
      'invoices.status',
      'invoices.billing_period_start',
      'invoices.billing_period_end',
      'invoices.due_date',
      'invoices.amount_due',
      'invoices.amount_paid',
      'branches.name as branch_name',
      'customers.first_name as customer_first_name',
      'customers.square_customer_id',
      'properties.address_line1',
    ])) as PortalInvoiceRow | undefined;

  // The same answer for a wrong token and a missing invoice: saying which
  // would confirm which tokens exist.
  if (!row) {
    throw notFound('That link is not valid');
  }
  return row;
}

function outstandingOf(row: { amount_due: string; amount_paid: string }): number {
  return Math.max(0, Number(row.amount_due) - Number(row.amount_paid));
}

function presentInvoice(row: PortalInvoiceRow, gateway: PaymentGateway): PortalInvoice {
  const outstanding = outstandingOf(row);
  const payment = gateway.takesPortalPayments ? gateway.portalConfig() : null;
  return {
    status: row.status,
    branch_name: row.branch_name,
    customer_first_name: row.customer_first_name,
    address_line1: row.address_line1,
    billing_period_start: row.billing_period_start,
    billing_period_end: row.billing_period_end,
    due_date: row.due_date,
    amount_due: row.amount_due,
    amount_paid: row.amount_paid,
    amount_outstanding: outstanding.toFixed(2),
    currency: config.payments.currency.toUpperCase(),
    can_pay: Boolean(payment) && PORTAL_PAYABLE.includes(row.status) && outstanding > 0,
    payment,
  };
}

export async function getPortalInvoice(token: string, db: Knex = defaultDb): Promise<PortalInvoice> {
  const [row, gateway] = await Promise.all([invoiceByToken(token, db), activeGateway(db)]);
  return presentInvoice(row, gateway);
}

export interface PortalCardInput {
  source_id: string;
  verification_token: string | null;
}

export interface PortalReceipt {
  invoice: PortalInvoice;
  receipt: { amount: string; status: string; reference: string };
}

/**
 * Takes the balance, and only the balance: the amount is worked out here
 * from the invoice, never read from the page.
 *
 * The invoice row stays locked across the call to the processor, so two tabs
 * — or a double tap — cannot both pay it. The second waits, then finds
 * nothing owing.
 */
export async function payPortalInvoice(
  token: string,
  input: PortalCardInput,
  ipAddress: string | null,
  db: Knex = defaultDb,
): Promise<PortalReceipt> {
  const gateway = await activeGateway(db);
  if (!gateway.takesPortalPayments) {
    throw conflict('Online payment is not available. Please contact the office to pay.');
  }

  const charged = await db.transaction(async (trx) => {
    const locked = (await trx('invoices')
      .where({ portal_token: token })
      .whereNot({ status: 'draft' })
      .forUpdate()
      .first()) as Invoice | undefined;
    if (!locked) {
      throw notFound('That link is not valid');
    }

    const row = await invoiceByToken(token, trx);
    if (!PORTAL_PAYABLE.includes(row.status) || outstandingOf(row) <= 0) {
      throw conflict(
        row.status === 'void'
          ? 'This invoice has been cancelled, so there is nothing to pay'
          : 'This invoice is already paid',
      );
    }

    const amountMinor = toMinorUnits(outstandingOf(row));
    const result = await gateway.chargeSource({
      source_id: input.source_id,
      verification_token: input.verification_token,
      processor_customer_id: gateway.customerColumn === 'square_customer_id'
        ? row.square_customer_id
        : null,
      amount_minor: amountMinor,
      description: `Snow clearing — ${row.address_line1}`,
      // The nonce is single-use, so a retry of the same submission is the
      // same payment and a fresh card is a fresh attempt.
      idempotency_key: `portal:${row.id}:${amountMinor}:${input.source_id}`,
      reference_id: row.id,
    });

    // The customer is looking at the page; they are told there, and nothing
    // is booked. The office is not emailed about every mistyped card.
    if (result.status === 'failed') {
      logger.info(
        { invoice_id: row.id, reason: result.failure_reason },
        'Online payment declined',
      );
      throw new ApiError(402, 'card_declined', result.failure_reason ?? 'The card was declined');
    }

    const amount = fromMinorUnits(amountMinor);
    await recordPayment(
      row.id,
      { kind: 'all' },
      {
        amount: Number(amount),
        method: 'online',
        provider_transaction_id: result.transaction_id,
        provider: gateway.name,
        status: result.status,
        failure_reason: null,
      },
      // The customer, who has no user account: the audit log keeps the
      // address the payment came from.
      { user_id: null, ip_address: ipAddress },
      trx,
    );

    return { amount, status: result.status, reference: result.transaction_id };
  });

  return { invoice: await getPortalInvoice(token, db), receipt: charged };
}

/** How long a signed autopay authorization lasts. */
const AUTOPAY_MONTHS = 12;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export interface AutopayAgreement {
  /** Shown above the signature box, and stored verbatim once signed. */
  text: string;
  starts_on: string;
  ends_on: string;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * What the customer signs: the contract they already have, and permission to
 * charge the saved card for it for one year. Written out here rather than in
 * the page, so the words stored with the signature are exactly the words the
 * server showed.
 */
export function autopayAgreement(
  branchName: string,
  addressLine1: string,
  startsOn: string = todayIso(),
): AutopayAgreement {
  const endsOn = addMonths(startsOn, AUTOPAY_MONTHS);
  const text =
    `By signing below, I confirm my snow clearing service contract with ${branchName} ` +
    `for ${addressLine1}, and I authorize ${branchName} to charge the card I save on ` +
    `this page for each invoice under that contract as it comes due, from ${startsOn} ` +
    `until ${endsOn}. After ${endsOn} no automatic charges are made unless I sign again. ` +
    `I can cancel this authorization at any time by contacting ${branchName}; charges ` +
    'already made are not affected.';
  return { text, starts_on: startsOn, ends_on: endsOn };
}

export interface PortalCardSetup {
  status: string;
  expired: boolean;
  branch_name: string;
  customer_first_name: string;
  address_line1: string;
  card: { last4: string | null; brand: string | null } | null;
  /** Present while the link is open: what must be signed before a card is saved. */
  agreement: AutopayAgreement | null;
  payment: PortalConfig | null;
}

interface CardSetupRow extends CardSetup {
  branch_name: string;
  customer_first_name: string;
  square_customer_id: string | null;
  address_line1: string | null;
}

async function setupByToken(token: string, db: Knex, forUpdate = false): Promise<CardSetupRow> {
  if (!isSquareSession(token)) {
    throw notFound('That link is not valid');
  }

  const query = db('card_setups')
    .join('customers', 'customers.id', 'card_setups.customer_id')
    .join('branches', 'branches.id', 'card_setups.branch_id')
    .leftJoin('contracts', 'contracts.id', 'card_setups.contract_id')
    .leftJoin('properties', 'properties.id', 'contracts.property_id')
    .where('card_setups.provider_session_id', token);
  if (forUpdate) query.forUpdate('card_setups');

  const row = (await query.first([
    'card_setups.*',
    'branches.name as branch_name',
    'customers.first_name as customer_first_name',
    'customers.square_customer_id',
    'properties.address_line1',
  ])) as CardSetupRow | undefined;

  if (!row) {
    throw notFound('That link is not valid');
  }
  return row;
}

function presentSetup(row: CardSetupRow, gateway: PaymentGateway): PortalCardSetup {
  const expired = row.status === 'sent' && new Date(row.expires_at) < new Date();
  const open = row.status === 'sent' && !expired && gateway.name === 'square';
  return {
    status: expired ? 'expired' : row.status,
    expired,
    branch_name: row.branch_name,
    customer_first_name: row.customer_first_name,
    address_line1: row.address_line1 ?? '',
    card:
      row.status === 'completed'
        ? { last4: row.payment_method_last4, brand: row.payment_method_brand }
        : null,
    agreement: open ? autopayAgreement(row.branch_name, row.address_line1 ?? '') : null,
    payment: open ? gateway.portalConfig() : null,
  };
}

export async function getPortalCardSetup(
  token: string,
  db: Knex = defaultDb,
): Promise<PortalCardSetup> {
  const [row, gateway] = await Promise.all([setupByToken(token, db), activeGateway(db)]);
  return presentSetup(row, gateway);
}

export interface PortalCardSignedInput extends PortalCardInput {
  signer_name: string;
  /** The signature pad's PNG, as a data URL. */
  signature_png: string;
}

/** Turns the pad's data URL into bytes, refusing anything that is not a PNG. */
function signatureBytes(dataUrl: string): Buffer {
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  const bytes = match?.[1] ? Buffer.from(match[1], 'base64') : Buffer.alloc(0);
  if (bytes.length < PNG_MAGIC.length || !bytes.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    throw badRequest('The signature did not come through. Please sign again.');
  }
  if (bytes.length > ruleFor('signature').maxBytes) {
    throw badRequest('The signature image is too large');
  }
  return bytes;
}

/**
 * Signs the autopay agreement and exchanges the nonce from Square's form for
 * a card stored against the customer — both or neither. No signature, no
 * card: automatic charges without written consent are the thing to avoid.
 */
export async function saveCardFromPortal(
  token: string,
  input: PortalCardSignedInput,
  ipAddress: string | null,
  db: Knex = defaultDb,
): Promise<PortalCardSetup> {
  const gateway = await activeGateway(db);
  if (gateway.name !== 'square') {
    throw conflict('Adding a card online is not available. Please contact the office.');
  }
  const signature = signatureBytes(input.signature_png);

  await db.transaction(async (trx) => {
    const setup = await setupByToken(token, trx, true);
    if (setup.status === 'completed') {
      throw conflict('A card has already been saved from this link');
    }
    if (setup.status !== 'sent') {
      throw conflict('This link is no longer active. Please ask the office for a new one.');
    }
    if (new Date(setup.expires_at) < new Date()) {
      throw conflict('This link has expired. Please ask the office for a new one.');
    }
    if (!setup.contract_id) {
      throw conflict('This link is not attached to a contract. Please ask the office for a new one.');
    }
    if (!setup.square_customer_id) {
      // requestCard creates the customer before sending the link, so this is
      // a link made while a different processor was active.
      throw conflict('This link was made for a different payment provider. Please ask the office for a new one.');
    }

    // Worked out now, not taken from the page: the year runs from the day
    // they actually sign.
    const agreement = autopayAgreement(setup.branch_name, setup.address_line1 ?? '');

    const saved = await gateway.saveCard({
      processor_customer_id: setup.square_customer_id,
      source_id: input.source_id,
      verification_token: input.verification_token,
      idempotency_key: `card:${setup.id}:${input.source_id}`,
    });

    // Stored only once Square has accepted the card, so a declined card does
    // not leave a signature for an authorization that never happened.
    const key = storageKeyFor('signature', 'image/png');
    const stored = await storage.put(
      key,
      Readable.from(signature),
      'image/png',
      ruleFor('signature').maxBytes,
    );
    await trx('uploads').insert({
      key,
      purpose: 'signature',
      content_type: 'image/png',
      file_name: 'autopay-signature.png',
      byte_size: stored.byte_size,
      status: 'stored',
      uploaded_by_user_id: null,
      branch_id: setup.branch_id,
      stored_at: new Date(),
    });

    await finishSetup(setup, gateway.name, saved, trx, {
      autopay_signature_url: key,
      autopay_signer_name: input.signer_name,
      autopay_terms: agreement.text,
      autopay_signed_at: new Date(),
      autopay_signed_ip: ipAddress,
      autopay_expires_on: agreement.ends_on,
    });

    await recordAudit(
      { user_id: null, ip_address: ipAddress },
      {
        action: 'contract.autopay_authorized',
        entity_type: 'contract',
        entity_id: setup.contract_id,
        after: {
          signer_name: input.signer_name,
          expires_on: agreement.ends_on,
          last4: saved.card.last4,
          brand: saved.card.brand,
        },
      },
      trx,
    );
  });

  return getPortalCardSetup(token, db);
}
