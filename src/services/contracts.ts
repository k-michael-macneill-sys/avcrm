import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { BranchScope } from '../types/auth';
import type {
  ChecklistRequirement,
  Contract,
  ContractChecklistItem,
  ContractStatus,
  PublicContract,
} from '../types/models';
import { badRequest, conflict, notFound } from '../utils/errors';
import { offsetOf, paginated, type Paginated, type Pagination } from '../utils/pagination';
import { isPgError, pgConstraint, PG_UNIQUE_VIOLATION } from '../utils/pg';
import { applyBranchScope } from '../utils/scope';
import { recordAudit, type AuditActor } from './audit';
import { generateInvoicesForContract } from './invoices';
import { lock as lockQuote } from './quotes';

/** A quote is signable once it has been shown to the customer. */
const SIGNABLE_QUOTE_STATUSES = ['presented', 'accepted'];

const TRANSITIONS: Record<ContractStatus, ContractStatus[]> = {
  active: ['cancelled', 'completed'],
  cancelled: [],
  completed: [],
};

/**
 * The one checklist item with a rule attached: ticking it means a payment
 * token was captured, and capturing a token means it is ticked. Everything
 * else on the list is config the office can change without touching code.
 */
const CARD_ON_FILE = 'card_on_file';

/**
 * Everything except payment_method_token. Reads go through this so the token
 * cannot leave the process by accident; the internal `lock` below selects the
 * whole row because the coherence checks need it.
 */
const PUBLIC_CONTRACT_COLUMNS = [
  'contracts.id',
  'contracts.quote_id',
  'contracts.customer_id',
  'contracts.property_id',
  'contracts.signature_image_url',
  'contracts.signed_at',
  'contracts.signed_ip',
  'contracts.signed_lat',
  'contracts.signed_lng',
  'contracts.terms_version',
  'contracts.payment_method_last4',
  'contracts.payment_method_brand',
  'contracts.payment_method_provider',
  'contracts.autopay_signature_url',
  'contracts.autopay_signer_name',
  'contracts.autopay_terms',
  'contracts.autopay_signed_at',
  'contracts.autopay_signed_ip',
  'contracts.autopay_expires_on',
  'contracts.pdf_url',
  'contracts.status',
  'contracts.created_at',
  'contracts.updated_at',
] as const;

export async function listChecklistRequirements(
  db: Knex = defaultDb,
): Promise<ChecklistRequirement[]> {
  return db('checklist_requirements')
    .orderBy([{ column: 'sort_order', order: 'asc' }, { column: 'code', order: 'asc' }])
    .select('*');
}

export interface ContractFilters {
  status?: ContractStatus;
  customer_id?: string;
  property_id?: string;
  quote_id?: string;
}

export interface ChecklistInput {
  item_code: string;
  checked: boolean;
}

export interface ContractInput {
  signature_image_url: string;
  /** Defaults to now: the rep is standing there. */
  signed_at: Date | null;
  signed_lat: number | null;
  signed_lng: number | null;
  terms_version: string;
  payment_method_token: string | null;
  payment_method_last4: string | null;
  payment_method_brand: string | null;
  checklist: ChecklistInput[];
}

export interface ContractWithChecklist extends PublicContract {
  checklist: ContractChecklistItem[];
}

/** Contracts are scoped through their (denormalized) customer's branch. */
function scoped(db: Knex, scope: BranchScope) {
  return applyBranchScope(
    db('contracts').join('customers', 'customers.id', 'contracts.customer_id'),
    'customers.branch_id',
    scope,
  );
}

export async function listContracts(
  scope: BranchScope,
  filters: ContractFilters,
  pagination: Pagination,
  db: Knex = defaultDb,
): Promise<Paginated<PublicContract>> {
  const base = scoped(db, scope);

  if (filters.status) base.andWhere('contracts.status', filters.status);
  if (filters.customer_id) base.andWhere('contracts.customer_id', filters.customer_id);
  if (filters.property_id) base.andWhere('contracts.property_id', filters.property_id);
  if (filters.quote_id) base.andWhere('contracts.quote_id', filters.quote_id);

  const [rows, countRow] = await Promise.all([
    base
      .clone()
      .orderBy([
        { column: 'contracts.signed_at', order: 'desc' },
        { column: 'contracts.id', order: 'desc' },
      ])
      .limit(pagination.page_size)
      .offset(offsetOf(pagination))
      .select([...PUBLIC_CONTRACT_COLUMNS]),
    base.clone().count<{ count: string }[]>({ count: 'contracts.id' }).first(),
  ]);

  return paginated(rows as PublicContract[], Number(countRow?.count ?? 0), pagination);
}

export async function getContract(
  id: string,
  scope: BranchScope,
  db: Knex = defaultDb,
): Promise<ContractWithChecklist> {
  const contract = (await scoped(db, scope)
    .andWhere('contracts.id', id)
    .first([...PUBLIC_CONTRACT_COLUMNS])) as PublicContract | undefined;
  if (!contract) {
    throw notFound('Contract not found');
  }
  return { ...contract, checklist: await checklistOf(id, db) };
}

/**
 * Signature capture. Everything lands in one transaction: the contract, its
 * full checklist, and the quote moving to accepted. A contract without its
 * checklist is not a state this can produce.
 */
export async function createContract(
  quoteId: string,
  scope: BranchScope,
  input: ContractInput,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<ContractWithChecklist> {
  assertNotRawCard(input.payment_method_token);

  return db.transaction(async (trx) => {
    const quote = await lockQuote(quoteId, scope, trx);
    if (!SIGNABLE_QUOTE_STATUSES.includes(quote.status)) {
      throw conflict(
        quote.status === 'draft'
          ? 'Present the quote to the customer before signing it'
          : `This quote is ${quote.status} and cannot be signed`,
      );
    }

    const property = await trx('properties')
      .where({ id: quote.property_id })
      .first('id', 'customer_id');
    if (!property) {
      throw notFound('The property on this quote no longer exists');
    }

    const requirements = await listChecklistRequirements(trx);
    const checked = resolveChecklist(requirements, input.checklist);
    assertRequiredChecked(requirements, checked);
    assertCardCoherent(checked, input.payment_method_token);

    const signedAt = input.signed_at ?? new Date();

    let inserted: Contract | undefined;
    try {
      [inserted] = await trx('contracts')
        .insert({
          quote_id: quote.id,
          customer_id: property.customer_id,
          property_id: property.id,
          signature_image_url: input.signature_image_url,
          signed_at: signedAt,
          // Taken from the request, never the body: that is what makes it
          // evidence that the rep was there.
          signed_ip: actor.ip_address,
          signed_lat: input.signed_lat?.toFixed(6) ?? null,
          signed_lng: input.signed_lng?.toFixed(6) ?? null,
          terms_version: input.terms_version,
          payment_method_token: input.payment_method_token,
          payment_method_last4: input.payment_method_last4,
          payment_method_brand: input.payment_method_brand,
          status: 'active',
        })
        .returning('*');
    } catch (err) {
      throw translate(err);
    }
    if (!inserted) {
      throw new Error('Insert returned no contract row');
    }
    const contract = inserted;

    await trx('contract_checklist_items').insert(
      requirements.map((requirement) => ({
        contract_id: contract.id,
        item_code: requirement.code,
        checked: checked.get(requirement.code) === true,
        checked_at: checked.get(requirement.code) === true ? signedAt : null,
      })),
    );

    if (quote.status !== 'accepted') {
      await trx('quotes').where({ id: quote.id }).update({ status: 'accepted' });
      await recordAudit(
        actor,
        {
          action: 'quote.status_changed',
          entity_type: 'quote',
          entity_id: quote.id,
          before: { status: quote.status },
          after: { status: 'accepted' },
        },
        trx,
      );
    }

    await recordAudit(
      actor,
      {
        action: 'contract.created',
        entity_type: 'contract',
        entity_id: contract.id,
        after: redact(contract),
      },
      trx,
    );

    // A seasonal contract is billed the moment it is signed, per the spec.
    // A monthly one waits for the billing job to raise each period as it
    // starts, so this is a no-op for those.
    if (quote.billing_type === 'seasonal_upfront') {
      await generateInvoicesForContract(contract.id, undefined, trx);
    }

    return { ...redact(contract), checklist: await checklistOf(contract.id, trx) };
  });
}

export interface ContractUpdate {
  pdf_url?: string | null;
  payment_method_token?: string | null;
  payment_method_last4?: string | null;
  payment_method_brand?: string | null;
}

/** Re-carding a customer, and writing back the generated PDF. */
export async function updateContract(
  id: string,
  scope: BranchScope,
  input: ContractUpdate,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<ContractWithChecklist> {
  const patch: Record<string, unknown> = {};
  for (const key of [
    'pdf_url',
    'payment_method_token',
    'payment_method_last4',
    'payment_method_brand',
  ] as const) {
    if (input[key] !== undefined) patch[key] = input[key];
  }
  if (Object.keys(patch).length === 0) {
    throw badRequest('No updatable fields were provided');
  }

  const touchesPayment = Object.keys(patch).some((key) =>
    key.startsWith('payment_method_'),
  );
  if (input.payment_method_token !== undefined) {
    assertNotRawCard(input.payment_method_token);
  }

  return db.transaction(async (trx) => {
    const before = await lock(id, scope, trx);
    if (touchesPayment && before.status !== 'active') {
      throw conflict(
        `This contract is ${before.status}, so its payment method is frozen`,
      );
    }

    if (input.payment_method_token !== undefined) {
      const items = await checklistOf(id, trx);
      const card = items.find((item) => item.item_code === CARD_ON_FILE);
      if (card?.checked && input.payment_method_token === null) {
        throw badRequest(
          `Untick ${CARD_ON_FILE} before removing the payment method from this contract`,
        );
      }
      if (card && !card.checked && input.payment_method_token !== null) {
        throw badRequest(
          `Tick ${CARD_ON_FILE} on this contract before adding a payment method`,
        );
      }
    }

    let contract: Contract | undefined;
    try {
      [contract] = await trx('contracts').where({ id }).update(patch).returning('*');
    } catch (err) {
      throw translate(err);
    }
    if (!contract) {
      throw notFound('Contract not found');
    }

    await recordAudit(
      actor,
      {
        action: 'contract.updated',
        entity_type: 'contract',
        entity_id: id,
        before: redact(before),
        after: redact(contract),
      },
      trx,
    );

    return { ...redact(contract), checklist: await checklistOf(id, trx) };
  });
}

export async function changeContractStatus(
  id: string,
  scope: BranchScope,
  status: ContractStatus,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<ContractWithChecklist> {
  return db.transaction(async (trx) => {
    const before = await lock(id, scope, trx);
    if (before.status === status) {
      throw conflict(`The contract is already ${status}`);
    }
    const allowed = TRANSITIONS[before.status];
    if (!allowed.includes(status)) {
      throw conflict(
        allowed.length === 0
          ? `This contract is ${before.status}, which is final and cannot be changed`
          : `This contract is ${before.status}, so it can only move to ${allowed.join(' or ')}`,
      );
    }

    const [contract] = await trx('contracts').where({ id }).update({ status }).returning('*');
    if (!contract) {
      throw notFound('Contract not found');
    }

    await recordAudit(
      actor,
      {
        action: `contract.${status}`,
        entity_type: 'contract',
        entity_id: id,
        before: { status: before.status },
        after: { status: contract.status },
      },
      trx,
    );

    return { ...redact(contract), checklist: await checklistOf(id, trx) };
  });
}

/**
 * Ticking a box after the fact — the optional ones, like photos_taken, that a
 * rep may finish in the truck. A required item can never be unticked: it is
 * the gate the contract passed to exist.
 */
export async function setChecklistItem(
  contractId: string,
  itemCode: string,
  checked: boolean,
  scope: BranchScope,
  actor: AuditActor,
  db: Knex = defaultDb,
): Promise<ContractWithChecklist> {
  return db.transaction(async (trx) => {
    const contract = await lock(contractId, scope, trx);
    if (contract.status !== 'active') {
      throw conflict(
        `This contract is ${contract.status}, so its checklist is frozen`,
      );
    }

    const item = await trx('contract_checklist_items')
      .where({ contract_id: contractId, item_code: itemCode })
      .first();
    if (!item) {
      throw notFound('That checklist item is not on this contract');
    }

    const requirement = await trx('checklist_requirements')
      .where({ code: itemCode })
      .first('is_required');
    if (requirement?.is_required && !checked) {
      throw conflict(`${itemCode} is required and cannot be unticked`);
    }

    if (itemCode === CARD_ON_FILE) {
      if (checked && !contract.payment_method_token) {
        throw badRequest(
          `Add a payment method to this contract before ticking ${CARD_ON_FILE}`,
        );
      }
      if (!checked && contract.payment_method_token) {
        throw badRequest(
          `This contract still has a payment method on file, so ${CARD_ON_FILE} stays ticked`,
        );
      }
    }

    if (item.checked !== checked) {
      await trx('contract_checklist_items')
        .where({ id: item.id })
        .update({ checked, checked_at: checked ? new Date() : null });

      await recordAudit(
        actor,
        {
          action: 'contract.checklist_updated',
          entity_type: 'contract',
          entity_id: contractId,
          before: { item_code: itemCode, checked: item.checked },
          after: { item_code: itemCode, checked },
        },
        trx,
      );
    }

    return { ...redact(contract), checklist: await checklistOf(contractId, trx) };
  });
}

async function checklistOf(
  contractId: string,
  db: Knex,
): Promise<ContractChecklistItem[]> {
  return db('contract_checklist_items')
    .join(
      'checklist_requirements',
      'checklist_requirements.code',
      'contract_checklist_items.item_code',
    )
    .where('contract_checklist_items.contract_id', contractId)
    .orderBy([
      { column: 'checklist_requirements.sort_order', order: 'asc' },
      { column: 'contract_checklist_items.item_code', order: 'asc' },
    ])
    .select('contract_checklist_items.*') as Promise<ContractChecklistItem[]>;
}

async function lock(
  id: string,
  scope: BranchScope,
  trx: Knex.Transaction,
): Promise<Contract> {
  const contract = await scoped(trx, scope)
    .andWhere('contracts.id', id)
    .forUpdate('contracts')
    .first('contracts.*');
  if (!contract) {
    throw notFound('Contract not found');
  }
  return contract as Contract;
}

function resolveChecklist(
  requirements: ChecklistRequirement[],
  submitted: ChecklistInput[],
): Map<string, boolean> {
  const state = new Map<string, boolean>(requirements.map((r) => [r.code, false]));

  for (const item of submitted) {
    if (!state.has(item.item_code)) {
      throw badRequest(`Unknown checklist item: ${item.item_code}`);
    }
    state.set(item.item_code, item.checked);
  }

  return state;
}

/** The gate from the spec: no submission until every required box is ticked. */
function assertRequiredChecked(
  requirements: ChecklistRequirement[],
  state: Map<string, boolean>,
): void {
  const unchecked = requirements
    .filter((r) => r.is_required && state.get(r.code) !== true)
    .map((r) => r.code);

  if (unchecked.length > 0) {
    throw badRequest(
      'Every required checklist item must be ticked before a contract can be signed',
      unchecked.map((code) => ({ path: `checklist.${code}`, message: 'not ticked' })),
    );
  }
}

function assertCardCoherent(state: Map<string, boolean>, token: string | null): void {
  if (!state.has(CARD_ON_FILE)) return;

  if (state.get(CARD_ON_FILE) === true && !token) {
    throw badRequest(`${CARD_ON_FILE} is ticked, so payment_method_token is required`);
  }
  if (state.get(CARD_ON_FILE) !== true && token) {
    throw badRequest(`A payment method was supplied, so ${CARD_ON_FILE} must be ticked`);
  }
}

/**
 * Refuses anything shaped like a card number. The column has a check
 * constraint too, but this catches the spaced and dashed forms and says what
 * to send instead. Raw card data must never reach this database.
 */
export function assertNotRawCard(token: string | null): void {
  if (!token) return;
  if (/^[\d\s-]+$/.test(token) && token.replace(/\D/g, '').length >= 12) {
    throw badRequest(
      'payment_method_token looks like a card number. Send the processor token instead — raw card data is never stored.',
    );
  }
}

/** The token never goes into the audit log; last4 and brand are enough. */
function redact(contract: Contract): Omit<Contract, 'payment_method_token'> {
  const { payment_method_token: _token, ...rest } = contract;
  return rest;
}

function translate(err: unknown): unknown {
  if (isPgError(err, PG_UNIQUE_VIOLATION)) {
    const constraint = pgConstraint(err);
    if (constraint === 'contracts_one_active_per_property') {
      return conflict('That property already has an active contract');
    }
    if (constraint === 'contracts_quote_id_unique') {
      return conflict('That quote has already been signed');
    }
  }
  return err;
}
