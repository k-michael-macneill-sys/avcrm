import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { config } from '../config';
import { ApiError, badRequest } from '../utils/errors';
import { logger } from '../utils/logger';
import type {
  CardDetails,
  ChargeRequest,
  ChargeResult,
  CompletedSetup,
  CustomerIdentity,
  GatewayEvent,
  PaymentGateway,
  PortalConfig,
  SavedCard,
  SetupSession,
  SourceChargeRequest,
} from './gateway';

/**
 * Square, over its REST API.
 *
 * Square has no hosted "save a card" page. Instead there is the Web Payments
 * SDK: Square's own card form, drawn in an iframe on our page, which hands
 * back a single-use nonce. So the link a
 * customer is sent opens /pay/…, the card is typed into Square's frame, and
 * only the nonce reaches this server — which is then exchanged for a stored
 * card or a payment. No card number or CVV touches this code.
 *
 * Credentials come from either the settings screen or the environment — see
 * gateway.ts — so this is built per request from whichever supplied them.
 */

const SQUARE_VERSION = '2025-01-23';

const API_BASE = {
  production: 'https://connect.squareup.com',
  sandbox: 'https://connect.squareupsandbox.com',
} as const;

const SDK_URL = {
  production: 'https://web.squarecdn.com/v1/square.js',
  sandbox: 'https://sandbox.web.squarecdn.com/v1/square.js',
} as const;

/** How long a card link stays usable. A week covers a customer who is away. */
const SETUP_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** Square's own reasons, in words a customer can act on. */
const DECLINE_REASONS: Record<string, string> = {
  CARD_DECLINED: 'The card was declined',
  GENERIC_DECLINE: 'The card was declined',
  INSUFFICIENT_FUNDS: 'The card was declined for insufficient funds',
  CVV_FAILURE: 'The security code did not match',
  VERIFY_CVV_FAILURE: 'The security code did not match',
  ADDRESS_VERIFICATION_FAILURE: 'The postal code did not match the card',
  VERIFY_AVS_FAILURE: 'The postal code did not match the card',
  INVALID_EXPIRATION: 'The expiry date is not valid',
  CARD_EXPIRED: 'The card has expired',
  CARD_NOT_SUPPORTED: 'That card is not accepted',
  INVALID_CARD: 'The card number is not valid',
  TRANSACTION_LIMIT: 'The card’s limit was reached',
  PAN_FAILURE: 'The card number is not valid',
  CARD_DECLINED_VERIFICATION_REQUIRED: 'The card needs to be verified by the bank',
  CARD_DECLINED_CALL_ISSUER: 'The card was declined — the bank asks you to call them',
};

interface SquareError {
  category?: string;
  code?: string;
  detail?: string;
}

interface SquareReply {
  status: number;
  body: Record<string, unknown> & { errors?: SquareError[] };
}

interface SquarePayment {
  id: string;
  status: string;
  card_details?: { card?: { card_brand?: string; last_4?: string } };
}

/**
 * Square caps idempotency keys at 45 characters, and ours carry a uuid plus
 * context. A digest keeps them unique and short while staying deterministic,
 * which is the property that matters: the same attempt, the same key.
 */
function keyFor(raw: string): string {
  return createHash('sha256').update(raw).digest('base64url').slice(0, 40);
}

function cardOf(card: { card_brand?: string; last_4?: string } | undefined): CardDetails {
  return {
    last4: card?.last_4 && /^\d{4}$/.test(card.last_4) ? card.last_4 : null,
    brand: card?.card_brand ? card.card_brand.toLowerCase() : null,
  };
}

function paymentStatus(status: string): ChargeResult['status'] {
  if (status === 'COMPLETED') return 'succeeded';
  if (status === 'FAILED' || status === 'CANCELED') return 'failed';
  return 'pending';
}

function declineReason(errors: SquareError[]): string {
  const first = errors[0];
  return (first?.code && DECLINE_REASONS[first.code]) || first?.detail || 'The card was declined';
}

export class SquareGateway implements PaymentGateway {
  readonly name = 'square';
  readonly canCharge = true;
  readonly takesPortalPayments = true;
  readonly customerColumn = 'square_customer_id' as const;

  private readonly environment: 'production' | 'sandbox';

  constructor(private readonly values: Record<string, string>) {
    this.environment = values.environment === 'production' ? 'production' : 'sandbox';
  }

  private get baseUrl(): string {
    return config.payments.square.apiBase ?? API_BASE[this.environment];
  }

  private get locationId(): string {
    return this.values.location_id ?? '';
  }

  private async request(
    method: 'GET' | 'POST',
    path: string,
    body?: Record<string, unknown>,
  ): Promise<SquareReply> {
    const token = this.values.access_token;
    if (!token) {
      throw badRequest('Square has no access token saved. Add one under Settings.');
    }

    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'Square-Version': SQUARE_VERSION,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (err) {
      logger.error({ err, path }, 'Square could not be reached');
      throw new ApiError(502, 'processor_unreachable', 'Square could not be reached. Try again shortly.');
    }

    const text = await response.text();
    let parsed: SquareReply['body'] = {};
    try {
      parsed = text ? (JSON.parse(text) as SquareReply['body']) : {};
    } catch {
      parsed = {};
    }
    return { status: response.status, body: parsed };
  }

  /** Anything other than a card being refused: a credential, a bad field. */
  private failure(reply: SquareReply, what: string): ApiError {
    const errors = reply.body.errors ?? [];
    const detail = errors.map((e) => e.detail ?? e.code).filter(Boolean).join('; ');
    logger.warn({ status: reply.status, errors }, `Square refused to ${what}`);

    if (reply.status === 401 || reply.status === 403) {
      return new ApiError(
        502,
        'processor_rejected_credentials',
        `Square did not accept the access token for its ${this.environment} environment. ` +
          'A sandbox token only works with environment "sandbox" and a production token only ' +
          'with "production" (SQUARE_ENVIRONMENT on the server, or the Environment field in Settings).',
      );
    }
    return new ApiError(
      502,
      'processor_error',
      `Square could not ${what}${detail ? ` — ${detail}` : ''}`,
    );
  }

  async ensureCustomer(input: CustomerIdentity): Promise<string> {
    if (input.processor_customer_id) return input.processor_customer_id;

    const reply = await this.request('POST', '/v2/customers', {
      idempotency_key: keyFor(`customer:${input.customer_id}`),
      given_name: input.first_name,
      family_name: input.last_name,
      ...(input.email ? { email_address: input.email } : {}),
      reference_id: input.customer_id,
    });

    const customer = reply.body.customer as { id?: string } | undefined;
    if (reply.status >= 400 || !customer?.id) {
      throw this.failure(reply, 'create the customer');
    }
    return customer.id;
  }

  /**
   * Our own page, not Square's: the "session" is a random capability for the
   * link, and it completes when the customer's browser posts a nonce back.
   */
  async createSetupSession(): Promise<SetupSession> {
    const sessionId = `sqs_${randomBytes(24).toString('base64url')}`;
    return {
      session_id: sessionId,
      url: `${config.messaging.appBaseUrl}/pay/card/${sessionId}`,
      expires_at: new Date(Date.now() + SETUP_TTL_MS),
    };
  }

  /** Nothing to ask Square: a setup finishes when the nonce arrives. */
  async readSetupSession(): Promise<CompletedSetup> {
    return { complete: false, payment_method: null, card: { last4: null, brand: null } };
  }

  async saveCard(input: {
    processor_customer_id: string;
    source_id: string;
    verification_token: string | null;
    idempotency_key: string;
  }): Promise<SavedCard> {
    const reply = await this.request('POST', '/v2/cards', {
      idempotency_key: keyFor(input.idempotency_key),
      source_id: input.source_id,
      ...(input.verification_token ? { verification_token: input.verification_token } : {}),
      card: { customer_id: input.processor_customer_id },
    });

    const errors = reply.body.errors ?? [];
    if (errors.some((e) => e.category === 'PAYMENT_METHOD_ERROR')) {
      throw new ApiError(402, 'card_declined', declineReason(errors));
    }
    const card = reply.body.card as { id?: string; card_brand?: string; last_4?: string } | undefined;
    if (reply.status >= 400 || !card?.id) {
      throw this.failure(reply, 'save the card');
    }
    return { payment_method: card.id, card: cardOf(card) };
  }

  private async createPayment(body: Record<string, unknown>): Promise<ChargeResult> {
    const reply = await this.request('POST', '/v2/payments', {
      ...body,
      location_id: this.locationId,
      autocomplete: true,
    });

    const payment = reply.body.payment as SquarePayment | undefined;
    const errors = reply.body.errors ?? [];

    // A decline is an answer, not an outage: Square reports it as an error
    // with a payment attached, and it is recorded as a failed payment.
    if (errors.some((e) => e.category === 'PAYMENT_METHOD_ERROR')) {
      return {
        status: 'failed',
        transaction_id: payment?.id ?? `failed:${String(body.idempotency_key)}`,
        failure_reason: declineReason(errors),
        card: cardOf(payment?.card_details?.card),
      };
    }
    if (reply.status >= 400 || !payment?.id) {
      throw this.failure(reply, 'take the payment');
    }

    return {
      status: paymentStatus(payment.status),
      transaction_id: payment.id,
      failure_reason: paymentStatus(payment.status) === 'failed' ? 'The payment was not completed' : null,
      card: cardOf(payment.card_details?.card),
    };
  }

  private money(amountMinor: number): { amount: number; currency: string } {
    return { amount: amountMinor, currency: config.payments.currency.toUpperCase() };
  }

  /** The card on file, with nobody present: the monthly charge. */
  async charge(request: ChargeRequest): Promise<ChargeResult> {
    return this.createPayment({
      idempotency_key: keyFor(request.idempotency_key),
      source_id: request.payment_method,
      customer_id: request.processor_customer_id,
      amount_money: this.money(request.amount_minor),
      reference_id: request.metadata.avcrm_invoice_id,
      note: request.description.slice(0, 500),
    });
  }

  /** A customer paying from their invoice link, card typed into Square's form. */
  async chargeSource(request: SourceChargeRequest): Promise<ChargeResult> {
    return this.createPayment({
      idempotency_key: keyFor(request.idempotency_key),
      source_id: request.source_id,
      ...(request.verification_token ? { verification_token: request.verification_token } : {}),
      ...(request.processor_customer_id ? { customer_id: request.processor_customer_id } : {}),
      amount_money: this.money(request.amount_minor),
      reference_id: request.reference_id,
      note: request.description.slice(0, 500),
    });
  }

  portalConfig(): PortalConfig | null {
    if (!this.values.application_id || !this.locationId) return null;
    return {
      provider: this.name,
      application_id: this.values.application_id,
      location_id: this.locationId,
      sdk_url: SDK_URL[this.environment],
    };
  }

  async refund(transactionId: string, amountMinor: number): Promise<string> {
    const reply = await this.request('POST', '/v2/refunds', {
      idempotency_key: keyFor(`refund:${transactionId}:${amountMinor}`),
      payment_id: transactionId,
      amount_money: this.money(amountMinor),
      reason: 'Refunded from Avalanche CRM',
    });
    const refund = reply.body.refund as { id?: string } | undefined;
    if (reply.status >= 400 || !refund?.id) {
      throw this.failure(reply, 'refund the payment');
    }
    return refund.id;
  }

  /**
   * Proves the saved credentials work, and that the location takes the
   * currency this install bills in — a mismatch would fail every payment.
   */
  async checkConnection(): Promise<{ location_name: string; currency: string; environment: string }> {
    if (!this.locationId) {
      throw badRequest('Square has no location ID saved');
    }
    const reply = await this.request('GET', `/v2/locations/${encodeURIComponent(this.locationId)}`);
    const location = reply.body.location as
      | { name?: string; currency?: string; status?: string }
      | undefined;
    if (reply.status >= 400 || !location) {
      throw this.failure(reply, 'find that location');
    }

    const currency = (location.currency ?? '').toUpperCase();
    const billing = config.payments.currency.toUpperCase();
    if (currency && currency !== billing) {
      throw badRequest(
        `That Square location takes ${currency}, but this install bills in ${billing} ` +
          '(PAYMENT_CURRENCY). Every payment would be refused.',
      );
    }
    if (location.status && location.status !== 'ACTIVE') {
      throw badRequest('That Square location is not active');
    }

    return {
      location_name: location.name ?? this.locationId,
      currency: currency || billing,
      environment: this.environment,
    };
  }

  /**
   * Square signs the notification URL followed by the raw body, with the
   * subscription's signature key. The URL is part of what is signed, so it has
   * to be the public one Square was given — APP_BASE_URL.
   */
  verifyWebhook(payload: Buffer, signature: string | undefined): GatewayEvent {
    const key = this.values.webhook_signature_key;
    if (!key) {
      throw badRequest('No Square webhook signature key is saved, so webhooks cannot be checked');
    }
    if (!signature) {
      throw badRequest('That webhook carried no signature');
    }

    const url = `${config.messaging.appBaseUrl}/webhooks/square`;
    const expected = createHmac('sha256', key)
      .update(url + payload.toString('utf8'))
      .digest();
    const given = Buffer.from(signature, 'base64');
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
      logger.warn('Rejected a Square webhook with a bad signature');
      throw badRequest('That webhook signature did not check out');
    }

    let event: { event_id?: string; type?: string; data?: { object?: Record<string, unknown> } };
    try {
      event = JSON.parse(payload.toString('utf8'));
    } catch {
      throw badRequest('That webhook was not JSON');
    }

    return {
      id: String(event.event_id ?? ''),
      type: String(event.type ?? ''),
      data: event.data?.object ?? {},
    };
  }
}
