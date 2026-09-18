import Stripe from 'stripe';
import { config } from '../config';
import { badRequest, conflict } from '../utils/errors';
import { logger } from '../utils/logger';

/**
 * Taking money.
 *
 * The interface is what this application needs, not what Stripe offers, so a
 * second processor is a second driver rather than a rewrite. `manual` is the
 * honest default for an install with no credentials: it records what someone
 * says happened and refuses to pretend it charged anything.
 *
 * Card data never reaches this server under either driver. The customer
 * enters their card on Stripe's own page; we keep a payment method id.
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

export interface ChargeRequest {
  stripe_customer_id: string;
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

export interface GatewayEvent {
  id: string;
  type: string;
  data: Record<string, unknown>;
}

export interface PaymentGateway {
  readonly name: string;
  /** True when this driver can actually move money. */
  readonly canCharge: boolean;

  ensureCustomer(input: {
    stripe_customer_id: string | null;
    email: string | null;
    name: string;
    customer_id: string;
  }): Promise<string>;

  createSetupSession(input: {
    stripe_customer_id: string;
    return_url: string;
    metadata: Record<string, string>;
  }): Promise<SetupSession>;

  readSetupSession(sessionId: string): Promise<CompletedSetup>;
  charge(request: ChargeRequest): Promise<ChargeResult>;
  refund(transactionId: string, amountMinor: number): Promise<string>;
  verifyWebhook(payload: Buffer, signature: string | undefined): GatewayEvent;
}

/** Money is numeric(10,2) here and an integer of cents at the processor. */
export function toMinorUnits(amount: string | number): number {
  return Math.round(Number(amount) * 100);
}

export function fromMinorUnits(minor: number): string {
  return (minor / 100).toFixed(2);
}

const NOT_CONFIGURED =
  'No payment gateway is configured. Set PAYMENT_GATEWAY=stripe with its keys, or record the payment by hand.';

/**
 * What an install without credentials does: nothing, loudly. Payments can
 * still be recorded by hand — that path never went through a gateway — but
 * nothing here pretends to have charged a card.
 */
class ManualGateway implements PaymentGateway {
  readonly name = 'manual';
  readonly canCharge = false;

  async ensureCustomer(): Promise<string> {
    throw badRequest(NOT_CONFIGURED);
  }
  async createSetupSession(): Promise<SetupSession> {
    throw badRequest(NOT_CONFIGURED);
  }
  async readSetupSession(): Promise<CompletedSetup> {
    throw badRequest(NOT_CONFIGURED);
  }
  async charge(): Promise<ChargeResult> {
    throw badRequest(NOT_CONFIGURED);
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

  async ensureCustomer(input: {
    stripe_customer_id: string | null;
    email: string | null;
    name: string;
    customer_id: string;
  }): Promise<string> {
    if (input.stripe_customer_id) return input.stripe_customer_id;

    const created = await this.stripe.customers.create(
      {
        name: input.name,
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
    stripe_customer_id: string;
    return_url: string;
    metadata: Record<string, string>;
  }): Promise<SetupSession> {
    const session = await this.stripe.checkout.sessions.create({
      mode: 'setup',
      customer: input.stripe_customer_id,
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
          customer: request.stripe_customer_id,
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

export const gateway: PaymentGateway =
  config.payments.gateway === 'stripe' ? new StripeGateway() : new ManualGateway();
