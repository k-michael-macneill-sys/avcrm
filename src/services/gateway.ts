import type { Knex } from 'knex';
import Stripe from 'stripe';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import { badRequest, conflict } from '../utils/errors';
import { logger } from '../utils/logger';
import { PAYMENTS_KEY, readIntegration, resolveValues } from './integrations';
import { SquareGateway } from './squareGateway';

/**
 * Taking money.
 *
 * The interface is what this application needs, not what Stripe offers, so a
 * second processor is a second driver rather than a rewrite. `manual` is the
 * honest default for an install with no credentials: it records what someone
 * says happened and refuses to pretend it charged anything.
 *
 * Card data never reaches this server under any driver. The customer enters
 * their card on the processor's own page or form; we keep a payment method id.
 *
 * Stripe comes from the environment. Square is connected from the settings
 * screen, and once it is switched on there it is the gateway — see
 * activeGateway() at the bottom.
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

export type CustomerColumn = 'stripe_customer_id' | 'square_customer_id';

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

class StripeGateway implements PaymentGateway {
  readonly name = 'stripe';
  readonly canCharge = true;
  // Stripe customers pay through its own hosted pages; the in-page card form
  // the payment link uses is Square's.
  readonly takesPortalPayments = false;
  readonly customerColumn = 'stripe_customer_id' as const;
  private readonly stripe: Stripe;

  constructor() {
    const { stripe } = config.payments;
    this.stripe = new Stripe(stripe.secretKey, {
      // Only set when pointing at stripe-mock or the local stand-in.
      ...(stripe.host ? { host: stripe.host } : {}),
      ...(stripe.port ? { port: stripe.port } : {}),
      ...(stripe.host ? { protocol: stripe.protocol } : {}),
      // A dropped connection mid-charge is the case worth being careful
      // about; the idempotency key on charge() makes a retry safe.
      maxNetworkRetries: 2,
      timeout: 20_000,
    });
  }

  async ensureCustomer(input: CustomerIdentity): Promise<string> {
    if (input.processor_customer_id) return input.processor_customer_id;

    const created = await this.stripe.customers.create(
      {
        name: `${input.first_name} ${input.last_name}`,
        ...(input.email ? { email: input.email } : {}),
        metadata: { avcrm_customer_id: input.customer_id },
      },
      // Keyed on our own id, so a retry cannot create a second customer for
      // the same person.
      { idempotencyKey: `customer:${input.customer_id}` },
    );

    return created.id;
  }

  /**
   * A hosted page in setup mode: the customer types their card on Stripe's
   * form, on their own device. The card never touches this server, this
   * client, or the rep standing at the door.
   */
  async createSetupSession(input: {
    processor_customer_id: string;
    return_url: string;
    metadata: Record<string, string>;
  }): Promise<SetupSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'setup',
      customer: input.processor_customer_id,
      success_url: input.return_url,
      cancel_url: input.return_url,
      metadata: input.metadata,
      // Checkout in setup mode already creates the SetupIntent for
      // off-session use, which is the whole point: a card we can charge
      // again next month with nobody present.
      setup_intent_data: { metadata: input.metadata },
    });

    if (!session.url) {
      throw conflict('Stripe did not return a page for the customer to use');
    }

    return {
      session_id: session.id,
      url: session.url,
      expires_at: new Date((session.expires_at ?? Date.now() / 1000 + 86_400) * 1000),
    };
  }

  async readSetupSession(sessionId: string): Promise<CompletedSetup> {
    const session = await this.stripe.checkout.sessions.retrieve(sessionId, {
      expand: ['setup_intent'],
    });

    const setupIntent = session.setup_intent;
    const paymentMethodId =
      typeof setupIntent === 'string'
        ? null
        : ((typeof setupIntent?.payment_method === 'string'
            ? setupIntent.payment_method
            : (setupIntent?.payment_method?.id ?? null)) ?? null);

    if (!paymentMethodId) {
      return { complete: false, payment_method: null, card: { last4: null, brand: null } };
    }

    return {
      complete: true,
      payment_method: paymentMethodId,
      card: await this.cardOf(paymentMethodId),
    };
  }

  private async cardOf(paymentMethodId: string): Promise<CardDetails> {
    try {
      const method = await this.stripe.paymentMethods.retrieve(paymentMethodId);
      return {
        last4: method.card?.last4 ?? null,
        brand: method.card?.brand ?? null,
      };
    } catch (err) {
      // Display detail only — never worth failing a capture over.
      logger.warn({ err, paymentMethodId }, 'Could not read the card details');
      return { last4: null, brand: null };
    }
  }

  async charge(request: ChargeRequest): Promise<ChargeResult> {
    try {
      const intent = await this.stripe.paymentIntents.create(
        {
          amount: request.amount_minor,
          currency: config.payments.currency,
          customer: request.processor_customer_id,
          payment_method: request.payment_method,
          description: request.description,
          metadata: request.metadata,
          // Nobody is at the keyboard: this is the monthly charge on a card
          // saved months ago.
          off_session: true,
          confirm: true,
        },
        { idempotencyKey: request.idempotency_key },
      );

      return {
        status: intent.status === 'succeeded' ? 'succeeded' : 'pending',
        transaction_id: intent.id,
        failure_reason: null,
        card: await this.cardOf(request.payment_method),
      };
    } catch (err) {
      return this.declined(err, request);
    }
  }

  /**
   * A decline is an answer, not an outage. Stripe raises on a declined card,
   * so this turns the exception back into a recorded failed payment — which
   * is what fires the payment_failed notice.
   */
  private async declined(err: unknown, request: ChargeRequest): Promise<ChargeResult> {
    const error = err as {
      type?: string;
      code?: string;
      message?: string;
      raw?: { payment_intent?: { id?: string } };
      payment_intent?: { id?: string };
    };

    const isCardError = error.type === 'StripeCardError';
    if (!isCardError) throw err;

    return {
      status: 'failed',
      transaction_id:
        error.raw?.payment_intent?.id ??
        error.payment_intent?.id ??
        `failed:${request.idempotency_key}`,
      failure_reason: error.message ?? error.code ?? 'The card was declined',
      card: await this.cardOf(request.payment_method),
    };
  }

  async saveCard(): Promise<SavedCard> {
    throw badRequest('Stripe saves cards on its own hosted page, not from a card form here');
  }

  async chargeSource(): Promise<ChargeResult> {
    throw badRequest('Paying from the invoice link needs Square connected under Settings');
  }

  portalConfig(): PortalConfig | null {
    return null;
  }

  async refund(transactionId: string, amountMinor: number): Promise<string> {
    const refund = await this.stripe.refunds.create(
      { payment_intent: transactionId, amount: amountMinor },
      { idempotencyKey: `refund:${transactionId}` },
    );
    return refund.id;
  }

  /**
   * Webhooks are unauthenticated HTTP from the internet, so the signature is
   * the only thing making them trustworthy. An unverified body is discarded.
   */
  verifyWebhook(payload: Buffer, signature: string | undefined): GatewayEvent {
    if (!signature) {
      throw badRequest('That webhook carried no signature');
    }

    let event: Stripe.Event;
    try {
      event = Stripe.webhooks.constructEvent(
        payload,
        signature,
        config.payments.stripe.webhookSecret,
      );
    } catch (err) {
      logger.warn({ err }, 'Rejected a webhook with a bad signature');
      throw badRequest('That webhook signature did not check out');
    }

    return {
      id: event.id,
      type: event.type,
      data: event.data.object as unknown as Record<string, unknown>,
    };
  }
}

/**
 * The processor configured in the environment: Stripe, or nothing. Stripe's
 * webhook route always answers to this one, whatever the settings say, so a
 * payment taken through Stripe still reconciles after switching to Square.
 */
export const envGateway: PaymentGateway =
  config.payments.gateway === 'stripe' ? new StripeGateway() : new ManualGateway();

/**
 * Square from the settings screen, whether or not it is switched on. Its
 * webhooks and refunds keep working after it is switched off, because money
 * already taken through it still has to be reconciled.
 */
export async function squareGateway(db: Knex = defaultDb): Promise<SquareGateway | null> {
  const row = await readIntegration(PAYMENTS_KEY, db);
  if (!row || row.provider !== 'square') return null;
  return new SquareGateway(resolveValues(row));
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
