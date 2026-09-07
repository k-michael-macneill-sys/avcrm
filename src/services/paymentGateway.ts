import crypto from 'node:crypto';
import { logger } from '../utils/logger';

/**
 * MOCK. Stands in for Stripe/Square until a real integration lands.
 * Keep the shape of this module stable — swap the body, not the signature.
 */
export interface ChargeRequest {
  amount: number;
  currency: string;
  customer_id: string;
  description?: string;
}

export interface ChargeResult {
  id: string;
  status: 'succeeded' | 'failed';
  amount: number;
  currency: string;
  failure_reason?: string;
}

export async function createCharge(request: ChargeRequest): Promise<ChargeResult> {
  const id = `mock_ch_${crypto.randomBytes(12).toString('hex')}`;

  logger.info(
    { mock: true, charge_id: id, amount: request.amount, customer_id: request.customer_id },
    'Mock payment gateway charge',
  );

  return {
    id,
    status: 'succeeded',
    amount: request.amount,
    currency: request.currency,
  };
}

export async function refundCharge(chargeId: string): Promise<{ id: string; status: 'refunded' }> {
  logger.info({ mock: true, charge_id: chargeId }, 'Mock payment gateway refund');
  return { id: `mock_re_${crypto.randomBytes(12).toString('hex')}`, status: 'refunded' };
}
