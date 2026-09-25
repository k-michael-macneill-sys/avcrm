import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { Customer, Invoice, PaymentMethod, Property, Quote } from '../types/models';
import { badRequest, notFound } from '../utils/errors';
import { applyBranchScope } from '../utils/scope';
import type { AuditActor } from './audit';
import { createCustomer, type CustomerInput } from './customers';
import { sendInvoice } from './invoices';
import { linkPinToCustomer } from './leads';
import { recordPayment } from './payments';
import { createProperty, findDuplicateAddress, type PropertyInput } from './properties';
import { createQuote, type QuoteInput } from './quotes';

/**
 * Opening a deal: the three records a rep creates in one go at somebody's
 * front door, in one transaction.
 *
 * Customers, properties and quotes each have their own endpoint, and a rep
 * standing on a doorstep in the cold should not be paying for that: three
 * round trips where the second can fail and leave a customer with no address
 * attached, and no way to tell from the outside how far it got. This is the
 * one call the sales flow makes, and it either produces all three rows or
 * none of them.
 *
 * It deliberately does not sign anything. What comes back is a quote the
 * customer has not agreed to yet — signing it, in person or by emailed link,
 * is what creates the contract.
 */
export interface OpenDealInput {
  /** Omitted when the deal is being written against a lead already on file. */
  customer?: CustomerInput;
  /** The lead being converted, instead of a new customer. */
  customer_id?: string;
  property: PropertyInput;
  quote: Omit<QuoteInput, 'status'>;
  lead_pin_id?: string;
}

export interface OpenDealResult {
  customer: Customer;
  property: Property;
  quote: Quote;
}

export async function openDeal(
  /**
   * Where a new customer is filed. Null when converting a lead, whose branch
   * is already decided and is not the caller's to change.
   */
  branchId: string | null,
  createdByUserId: string,
  scope: BranchScope,
  input: OpenDealInput,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<OpenDealResult> {
  if (!input.customer && !input.customer_id) {
    throw badRequest('Either customer or customer_id is required');
  }
  if (input.customer && !branchId) {
    throw badRequest('branch_id is required: corporate users must name the branch');
  }

  return db.transaction(async (trx) => {
    const customer = input.customer_id
      ? await existingCustomer(input.customer_id, scope, trx)
      : // Both checked above: a new customer always has a branch by here.
        await createCustomer(branchId!, createdByUserId, input.customer!, trx);

    const property = await propertyFor(customer.id, scope, input.property, trx);

    // 'presented' rather than 'draft': the rep is standing there showing it,
    // and a draft cannot be signed.
    const quote = await createQuote(
      property.id,
      createdByUserId,
      scope,
      { ...input.quote, status: 'presented' },
      actor,
      trx,
    );

    if (input.lead_pin_id) {
      await linkPinToCustomer(input.lead_pin_id, customer.id, scope, trx);
    }

    return { customer, property, quote };
  });
}

/**
 * The cash or cheque the rep is holding when they walk back to the truck.
 *
 * A seasonal contract raises its invoice the moment it is signed, and that
 * invoice starts as a draft nobody has been asked to pay. When the money has
 * already changed hands there is nothing to ask for, so this sends it — which
 * is what gets the customer their copy — and records what was taken against
 * it.
 *
 * Not one transaction across all three steps on purpose: each is safe on its
 * own, and the worst case is an invoice that went out and still shows as
 * owing, which the office can settle by hand. Wrapping them would instead
 * risk swallowing a payment that was physically taken.
 */
export async function settleCollectedPayment(
  contractId: string,
  scope: BranchScope,
  method: Extract<PaymentMethod, 'cash' | 'cheque'>,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<Invoice> {
  const invoice = (await applyBranchScope(db('invoices'), 'branch_id', scope)
    .andWhere({ contract_id: contractId })
    .whereNot({ status: 'void' })
    .orderBy('billing_period_start', 'asc')
    .first('*')) as Invoice | undefined;

  if (!invoice) {
    throw notFound('That contract has no invoice to settle');
  }

  if (invoice.status === 'draft') {
    await sendInvoice(invoice.id, scope, db);
  }

  const outstanding = Number(invoice.amount_due) - Number(invoice.amount_paid);
  if (outstanding <= 0) {
    return invoice;
  }

  const settled = await recordPayment(
    invoice.id,
    scope,
    {
      amount: outstanding,
      method,
      provider_transaction_id: null,
      status: 'succeeded',
      failure_reason: null,
    },
    actor,
    db,
  );

  return settled;
}

/**
 * A lead often already has their house on file — dropped from the map, or
 * added when they were first logged. Signing them up uses that house rather
 * than tripping over it as a duplicate; anybody else's house at the same
 * address is still refused.
 */
async function propertyFor(
  customerId: string,
  scope: BranchScope,
  input: PropertyInput,
  db: Knex,
): Promise<Property> {
  const existing = await findDuplicateAddress(input.postal_code, input.address_line1, scope, db);
  if (existing?.customer_id !== customerId) {
    return createProperty(customerId, scope, input, db);
  }

  // What the rep filled in at sign-up is the latest word on the house.
  const patch: Record<string, unknown> = { address_line2: input.address_line2 };
  if (input.latitude !== null) patch.latitude = input.latitude.toFixed(6);
  if (input.longitude !== null) patch.longitude = input.longitude.toFixed(6);
  if (input.access_notes !== null) patch.access_notes = input.access_notes;

  const [updated] = await db('properties')
    .where({ id: existing.property_id })
    .update(patch)
    .returning('*');
  return updated as Property;
}

async function existingCustomer(
  customerId: string,
  scope: BranchScope,
  db: Knex,
): Promise<Customer> {
  const customer = await applyBranchScope(db('customers'), 'branch_id', scope)
    .andWhere({ id: customerId })
    .first('*');
  if (!customer) {
    throw badRequest('customer_id does not match a customer you can access');
  }
  return customer as Customer;
}
