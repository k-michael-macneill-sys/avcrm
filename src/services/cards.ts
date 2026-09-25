import type { Knex } from 'knex';
import { config } from '../config';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type { CardSetup, MessageChannel } from '../types/models';
import { badRequest, conflict, notFound } from '../utils/errors';
import { logger } from '../utils/logger';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { applyBranchScope } from '../utils/scope';
import { activeGateway, envGateway, type SavedCard } from './gateway';
import { enqueueMessage } from './messages';

/**
 * Getting a card on file without anyone reading a card number — or a CVV —
 * out loud on a doorstep.
 *
 * The rep asks for a card; the customer gets a link and types it into the
 * processor's own page on their own phone. No card data reaches this server,
 * this client, or the rep. What comes back is a payment method that can be
 * charged again next month with nobody present, which is exactly what a
 * seasonal contract needs.
 */

/** Ticking this proves a card is on file, so the two move together. */
const CARD_ON_FILE = 'card_on_file';

interface ContractRow {
  contract_id: string;
  contract_status: string;
  customer_id: string;
  branch_id: string;
  branch_name: string;
  first_name: string;
  last_name: string;
  email: string | null;
  phone: string | null;
  preferred_contact: string;
  stripe_customer_id: string | null;
  square_customer_id: string | null;
  address_line1: string;
}

async function contractFor(
  contractId: string,
  scope: BranchScope,
  db: Knex,
): Promise<ContractRow> {
  const row = (await applyBranchScope(
    db('contracts')
      .join('customers', 'customers.id', 'contracts.customer_id')
      .join('properties', 'properties.id', 'contracts.property_id')
      .join('branches', 'branches.id', 'customers.branch_id'),
    'customers.branch_id',
    scope,
  )
    .andWhere('contracts.id', contractId)
    .first([
      'contracts.id as contract_id',
      'contracts.status as contract_status',
      'customers.id as customer_id',
      'customers.branch_id',
      'customers.first_name',
      'customers.last_name',
      'customers.email',
      'customers.phone',
      'customers.preferred_contact',
      'customers.stripe_customer_id',
      'customers.square_customer_id',
      'branches.name as branch_name',
      'properties.address_line1',
    ])) as ContractRow | undefined;

  if (!row) {
    throw notFound('Contract not found');
  }
  return row;
}

export interface CardRequestResult {
  setup: CardSetup;
  /** Handed back so the rep can also show a QR or pass the phone over. */
  url: string;
  sent_to: string | null;
  channel: MessageChannel | null;
}

/**
 * Asks the customer for a card. Queues the link and returns it, because at
 * the door the fastest path is often handing the customer the phone rather
 * than waiting for an email to arrive.
 */
export async function requestCard(
  contractId: string,
  scope: BranchScope,
  actorId: string,
  db: Knex = defaultDb,
): Promise<CardRequestResult> {
  const contract = await contractFor(contractId, scope, db);

  if (contract.contract_status !== 'active') {
    throw conflict(
      `This contract is ${contract.contract_status}, so there is nothing to charge`,
    );
  }
  if (!contract.email && !contract.phone) {
    throw badRequest('That customer has no email or phone to send the link to');
  }

  const gateway = await activeGateway(db);
  const known = gateway.customerColumn ? contract[gateway.customerColumn] : null;
  const processorCustomerId = await gateway.ensureCustomer({
    processor_customer_id: known,
    email: contract.email,
    first_name: contract.first_name,
    last_name: contract.last_name,
    customer_id: contract.customer_id,
  });

  if (gateway.customerColumn && processorCustomerId !== known) {
    await db('customers')
      .where({ id: contract.customer_id })
      .update({ [gateway.customerColumn]: processorCustomerId });
  }

  const session = await gateway.createSetupSession({
    processor_customer_id: processorCustomerId,
    return_url: `${config.messaging.appBaseUrl}/card-complete`,
    metadata: {
      avcrm_contract_id: contract.contract_id,
      avcrm_customer_id: contract.customer_id,
    },
  });

  return db.transaction(async (trx) => {
    const [setup] = await trx('card_setups')
      .insert({
        customer_id: contract.customer_id,
        contract_id: contract.contract_id,
        branch_id: contract.branch_id,
        provider_session_id: session.session_id,
        url: session.url,
        status: 'sent',
        requested_by_user_id: actorId,
        expires_at: session.expires_at,
      })
      .returning('*');
    if (!setup) {
      throw new Error('Insert returned no card_setup row');
    }

    const channel: MessageChannel | null =
      contract.preferred_contact === 'sms' && contract.phone
        ? 'sms'
        : contract.email
          ? 'email'
          : contract.phone
            ? 'sms'
            : null;
    const recipient = channel === 'sms' ? contract.phone : contract.email;

    if (channel && recipient) {
      await enqueueMessage(
        {
          template_code: 'card_setup_request',
          channel,
          recipient,
          branch_id: contract.branch_id,
          customer_id: contract.customer_id,
          context: {
            customer_first_name: contract.first_name,
            address_line1: contract.address_line1,
            branch_name: contract.branch_name,
            card_url: session.url,
          },
        },
        trx,
      );
    }

    return { setup, url: session.url, sent_to: recipient, channel };
  });
}

/** Square setups finish from the customer's page, not from a session lookup. */
export function isSquareSession(sessionId: string): boolean {
  return sessionId.startsWith('sqs_');
}

/**
 * Asks Stripe whether a hosted session has finished, and records it if so.
 *
 * Idempotent — the webhook and a manual refresh can both call it.
 */
export async function completeSetup(
  sessionId: string,
  db: Knex = defaultDb,
): Promise<CardSetup | null> {
  const existing = (await db('card_setups')
    .where({ provider_session_id: sessionId })
    .first()) as CardSetup | undefined;
  if (!existing) {
    logger.warn({ sessionId }, 'Card setup finished for a session we did not start');
    return null;
  }
  if (existing.status === 'completed' || isSquareSession(sessionId)) return existing;

  const result = await envGateway.readSetupSession(sessionId);
  if (!result.complete || !result.payment_method) {
    return existing;
  }

  return finishSetup(
    existing,
    envGateway.name,
    { payment_method: result.payment_method, card: result.card },
    db,
  );
}

/**
 * Records a finished capture: the card goes on the contract, and the
 * checklist item that claims there is one gets ticked in the same
 * transaction, because the contract service treats those two as one fact.
 */
export async function finishSetup(
  existing: CardSetup,
  provider: string,
  result: SavedCard,
  db: Knex = defaultDb,
  /** Anything else recorded on the contract with the card, like a signed authorization. */
  contractFields: Record<string, unknown> = {},
): Promise<CardSetup> {
  return db.transaction(async (trx) => {
    const [setup] = await trx('card_setups')
      .where({ id: existing.id })
      .update({
        status: 'completed',
        completed_at: new Date(),
        payment_method_last4: result.card.last4,
        payment_method_brand: result.card.brand,
      })
      .returning('*');

    if (existing.contract_id) {
      await trx('contracts').where({ id: existing.contract_id }).update({
        payment_method_token: result.payment_method,
        payment_method_provider: provider,
        ...contractFields,
        payment_method_last4: result.card.last4,
        payment_method_brand: result.card.brand,
      });

      // The contract's own rule: a token on file means the box is ticked.
      await trx('contract_checklist_items')
        .where({ contract_id: existing.contract_id, item_code: CARD_ON_FILE })
        .update({ checked: true, checked_at: new Date() });
    }

    logger.info(
      { card_setup_id: existing.id, contract_id: existing.contract_id },
      'Card saved against the contract',
    );

    return setup ?? existing;
  });
}

export interface CardSetupFilters {
  customer_id?: string;
  contract_id?: string;
  status?: string;
}

export async function listCardSetups(
  scope: BranchScope,
  filters: CardSetupFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<CardSetup>> {
  const base = applyBranchScope(db('card_setups'), 'branch_id', scope);

  if (filters.customer_id) base.andWhere({ customer_id: filters.customer_id });
  if (filters.contract_id) base.andWhere({ contract_id: filters.contract_id });
  if (filters.status) base.andWhere({ status: filters.status });

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'created_at', order: 'desc' },
        { column: 'id', order: 'desc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select('*'),
    base.clone().count<{ count: string }[]>({ count: '*' }).first(),
  ]);

  return paginated(rows, Number(countRow?.count ?? 0), pagination);
}

/**
 * One setup, branch-scoped. Separate from listCardSetups because a lookup by
 * id should be a lookup, not a scan of the first page of results.
 */
export async function getCardSetup(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<CardSetup> {
  const row = (await applyBranchScope(db('card_setups'), 'branch_id', scope)
    .andWhere({ id })
    .first('*')) as CardSetup | undefined;

  if (!row) {
    throw notFound('Card setup not found');
  }
  return row;
}
