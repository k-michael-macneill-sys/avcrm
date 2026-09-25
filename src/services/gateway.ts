import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import { badRequest } from '../utils/errors';
import { PAYMENTS_KEY, readIntegration, resolveValues } from './integrations';
import { SquareGateway } from './squareGateway';

/**
 * Taking money, through Square.
 *
 * `manual` is the honest default for an install with no credentials: it
 * records what someone says happened and refuses to pretend it charged
 * anything.
 *
 * Card data never reaches this server under any driver. The customer enters
 * their card on Square's own form; we keep a payment method id.
 *
 * Square can come from the environment — a default processor with nothing to
 * click through first — or from the settings screen, which a corporate user
 * fills in once it is switched on there. Settings takes precedence over the
 * environment; see activeGateway() at the bottom.
 */

export interface CardDetails {
  last4: string | null;
  brand: string | null;
}

export interface SetupSession {
  session_id: string;
  /** Where to send the customer to enter their card. */
  url: string;
  expires_at: Date;
}

export interface CompletedSetup {
  complete: boolean;
  payment_method: string | null;
  card: CardDetails;
}

export interface SavedCard {
  payment_method: string;
  card: CardDetails;
}

export interface ChargeRequest {
  processor_customer_id: string;
  payment_method: string;
  /** Minor units, because that is what a processor speaks. */
  amount_minor: number;
  description: string;
  /** Makes a retry of the same charge a no-op rather than a second charge. */
  idempotency_key: string;
  metadata: Record<string, string>;
}

export interface ChargeResult {
  status: 'succeeded' | 'failed' | 'pending';
  transaction_id: string;
  failure_reason: string | null;
  card: CardDetails;
}

/**
 * A one-off payment from a token the processor's own card form produced in
 * the customer's browser. The card number went from their keyboard to the
 * processor; what reaches us is a single-use nonce.
 */
export interface SourceChargeRequest {
  source_id: string;
  verification_token: string | null;
  processor_customer_id: string | null;
  amount_minor: number;
  description: string;
  idempotency_key: string;
  /** Our invoice id, so the payment can be found from the processor's side. */
  reference_id: string;
}

/** What the customer's browser needs to draw the processor's card form. */
export interface PortalConfig {
  provider: string;
  application_id: string;
  location_id: string;
  sdk_url: string;
}

export type CustomerColumn = 'square_customer_id';

export interface GatewayEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface PaymentGateway {
  readonly name: string;
  /** True when this driver can actually move money. */
  readonly canCharge: boolean;
  /** True when a customer can pay an invoice from the link they are sent. */
  readonly takesPortalPayments: boolean;
  /** Where this processor's customer id is kept on our customers row. */
  readonly customerColumn: CustomerColumn | null;

  ensureCustomer(input: CustomerIdentity): Promise<string>;

  createSetupSession(input: {
    processor_customer_id: string;
    return_url: string;
    metadata: Record<string, string>;
  }): Promise<SetupSession>;

  readSetupSession(sessionId: string): Promise<CompletedSetup>;
  /** Stores a card from a nonce the processor's form produced. */
  saveCard(input: {
    processor_customer_id: string;
    source_id: string;
    verification_token: string | null;
    idempotency_key: string;
  }): Promise<SavedCard>;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  chargeSource(request: SourceChargeRequest): Promise<ChargeResult>;
  portalConfig(): PortalConfig | null;
  refund(transactionId: string, amountMinor: number): Promise<string>;
  verifyWebhook(payload: Buffer, signature: string | undefined): GatewayEvent;
}

export interface CustomerIdentity {
  processor_customer_id: string | null;
  email: string | null;
  first_name: string;
  last_name: string;
  customer_id: string;
}

/** Money is numeric(10,2) here and an integer of cents at the processor. */
export function toMinorUnits(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

export function fromMinorUnits(minor: number): string {
  return (minor / 100).toFixed(2);
}

const NOT_CONFIGURED =
  'No payment processor is connected. Connect Square under Settings, or record the payment by hand.';

/**
 * What an install without credentials does: nothing, loudly. Payments can
 * still be recorded by hand — that path never went through a gateway — but
 * nothing here pretends to have charged a card.
 */
class ManualGateway implements PaymentGateway {
  readonly name = 'manual';
  readonly canCharge = false;
  readonly takesPortalPayments = false;
  readonly customerColumn = null;

  async ensureCustomer(): Promise<string> {
    throw badRequest(NOT_CONFIGURED);
  }
  async createSetupSession(): Promise<SetupSession> {
    throw badRequest(NOT_CONFIGURED);
  }
  async readSetupSession(): Promise<CompletedSetup> {
    throw badRequest(NOT_CONFIGURED);
  }
  async saveCard(): Promise<SavedCard> {
    throw badRequest(NOT_CONFIGURED);
  }
  async charge(): Promise<ChargeResult> {
    throw badRequest(NOT_CONFIGURED);
  }
  async chargeSource(): Promise<ChargeResult> {
    throw badRequest(NOT_CONFIGURED);
  }
  portalConfig(): PortalConfig | null {
    return null;
  }
  async refund(): Promise<string> {
    throw badRequest(NOT_CONFIGURED);
  }
  verifyWebhook(): GatewayEvent {
    throw badRequest(NOT_CONFIGURED);
  }
}

/**
 * The processor configured in the environment: Square, if a token is set, or
 * nothing. This is what a single-branch install charges through by default,
 * with no Settings screen to click through first. A corporate account
 * managing several branches overrides it there instead — see activeGateway()
 * below. Square's webhook route always answers to this one when the
 * settings row has nothing configured, so a payment taken through it still
 * reconciles either way.
 */
export const envGateway: PaymentGateway = config.payments.square.accessToken
  ? new SquareGateway({
      environment: config.payments.square.environment,
      application_id: config.payments.square.applicationId,
      location_id: config.payments.square.locationId,
      access_token: config.payments.square.accessToken,
      webhook_signature_key: config.payments.square.webhookSignatureKey,
    })
  : new ManualGateway();

/**
 * Square, however it is configured: from the settings screen if a row is
 * there, whether or not it is switched on — its webhooks and refunds keep
 * working after it is switched off, because money already taken through it
 * still has to be reconciled — otherwise from the environment.
 */
export async function squareGateway(db: Knex = defaultDb): Promise<SquareGateway | null> {
  const row = await readIntegration(PAYMENTS_KEY, db);
  if (row && row.provider === 'square') {
    return new SquareGateway(resolveValues(row));
  }
  return envGateway instanceof SquareGateway ? envGateway : null;
}

/**
 * The processor that takes new money right now. Read from the table on every
 * call rather than cached, for the same reason the SMS settings are: an admin
 * who switches Square on expects the next charge to go through it.
 */
export async function activeGateway(db: Knex = defaultDb): Promise<PaymentGateway> {
  const row = await readIntegration(PAYMENTS_KEY, db);
  if (row?.is_enabled && row.provider === 'square') {
    return new SquareGateway(resolveValues(row));
  }
  return envGateway;
}

/** The processor a past charge went through, for refunding it. */
export async function gatewayNamed(
  name: string,
  db: Knex = defaultDb,
): Promise<PaymentGateway | null> {
  if (name === 'square') return squareGateway(db);
  return envGateway.name === name ? envGateway : null;
}
