import type { Knex } from 'knex';
import { db as defaultDb } from '../db/client';
import type { AuditActor } from './audit';
import { recordAudit } from './audit';
import type { BranchScope } from '../types/auth';
import { badRequest, conflict, forbidden, notFound } from '../utils/errors';
import { applyBranchScope } from '../utils/scope';

/**
 * Deleting a record and everything that hangs off it.
 *
 * The schema restricts deletes up the paperwork chain — payments hold their
 * invoice, invoices their contract, a contract its quote, address and
 * customer — so each delete here clears the chain beneath it first, in one
 * transaction: all of it goes, or none of it does.
 *
 * Because that takes invoices and payments with it, anything with a contract
 * underneath is corporate-only. The audit log is append-only and keeps the
 * record that the delete happened, and who did it.
 */

export interface Deleter {
  actor: AuditActor;
  isCorporate: boolean;
}

const OFFICE_ONLY =
  'has a signed contract, and deleting it removes that contract, its invoices and payments too. Only the office (a corporate account) can do that.';

/** Payments, then invoices, then the contracts themselves. */
async function purgeContracts(trx: Knex.Transaction, contractIds: string[]): Promise<number> {
  if (contractIds.length === 0) return 0;
  const invoiceIds = trx('invoices').whereIn('contract_id', contractIds).select('id');
  await trx('payments').whereIn('invoice_id', invoiceIds).del();
  await trx('invoices').whereIn('contract_id', contractIds).del();
  // Card setups, checklist ticks and visits (with their photos and review
  // requests) cascade from here.
  return trx('contracts').whereIn('id', contractIds).del();
}

async function contractsWhere(
  trx: Knex.Transaction,
  column: 'customer_id' | 'property_id' | 'quote_id',
  id: string,
): Promise<string[]> {
  return (await trx('contracts').where(column, id).pluck('id')) as string[];
}

function scopedCustomer(trx: Knex.Transaction, scope: BranchScope) {
  return applyBranchScope(trx('customers'), 'customers.branch_id', scope);
}

export async function deleteCustomer(
  id: string,
  scope: BranchScope,
  by: Deleter,
  db: Knex = defaultDb,
): Promise<void> {
  await db.transaction(async (trx) => {
    const customer = await scopedCustomer(trx, scope).andWhere('customers.id', id).first('customers.*');
    if (!customer) throw notFound('Customer not found');

    const contracts = await contractsWhere(trx, 'customer_id', id);
    if (contracts.length && !by.isCorporate) throw forbidden(`This customer ${OFFICE_ONLY}`);
    await purgeContracts(trx, contracts);
    // Any invoice not tied to one of those contracts still names the customer.
    const invoiceIds = trx('invoices').where('customer_id', id).select('id');
    await trx('payments').whereIn('invoice_id', invoiceIds).del();
    await trx('invoices').where('customer_id', id).del();
    // Addresses, quotes, signing links, card setups and review requests
    // cascade; lead pins and message history keep their row, unlinked.
    await trx('customers').where({ id }).del();

    await recordAudit(
      by.actor,
      {
        action: 'customer.deleted',
        entity_type: 'customer',
        entity_id: id,
        before: {
          name: `${customer.first_name} ${customer.last_name}`,
          email: customer.email,
          contracts_deleted: contracts.length,
        },
      },
      trx,
    );
  });
}

export async function deleteProperty(
  id: string,
  scope: BranchScope,
  by: Deleter,
  db: Knex = defaultDb,
): Promise<void> {
  await db.transaction(async (trx) => {
    const property = await applyBranchScope(
      trx('properties').join('customers', 'customers.id', 'properties.customer_id'),
      'customers.branch_id',
      scope,
    )
      .andWhere('properties.id', id)
      .first('properties.*');
    if (!property) throw notFound('Property not found');

    const contracts = await contractsWhere(trx, 'property_id', id);
    if (contracts.length && !by.isCorporate) throw forbidden(`This address ${OFFICE_ONLY}`);
    await purgeContracts(trx, contracts);
    await trx('properties').where({ id }).del();

    await recordAudit(
      by.actor,
      {
        action: 'property.deleted',
        entity_type: 'property',
        entity_id: id,
        before: { address_line1: property.address_line1, contracts_deleted: contracts.length },
      },
      trx,
    );
  });
}

export async function deleteQuote(
  id: string,
  scope: BranchScope,
  by: Deleter,
  db: Knex = defaultDb,
): Promise<void> {
  await db.transaction(async (trx) => {
    const quote = await applyBranchScope(
      trx('quotes')
        .join('properties', 'properties.id', 'quotes.property_id')
        .join('customers', 'customers.id', 'properties.customer_id'),
      'customers.branch_id',
      scope,
    )
      .andWhere('quotes.id', id)
      .first('quotes.*');
    if (!quote) throw notFound('Quote not found');

    const contracts = await contractsWhere(trx, 'quote_id', id);
    if (contracts.length && !by.isCorporate) throw forbidden(`This quote ${OFFICE_ONLY}`);
    await purgeContracts(trx, contracts);
    await trx('quotes').where({ id }).del();

    await recordAudit(
      by.actor,
      {
        action: 'quote.deleted',
        entity_type: 'quote',
        entity_id: id,
        before: { status: quote.status, contracts_deleted: contracts.length },
      },
      trx,
    );
  });
}

export async function deleteContract(
  id: string,
  scope: BranchScope,
  by: Deleter,
  db: Knex = defaultDb,
): Promise<void> {
  if (!by.isCorporate) throw forbidden('Only the office (a corporate account) can delete a contract');
  await db.transaction(async (trx) => {
    const contract = await applyBranchScope(
      trx('contracts').join('customers', 'customers.id', 'contracts.customer_id'),
      'customers.branch_id',
      scope,
    )
      .andWhere('contracts.id', id)
      .first('contracts.*');
    if (!contract) throw notFound('Contract not found');

    await purgeContracts(trx, [id]);
    // The quote goes back to where it was before it was signed, so the deal
    // can be signed again rather than stranded as "accepted" with nothing.
    await trx('quotes').where({ id: contract.quote_id }).update({ status: 'presented' });

    await recordAudit(
      by.actor,
      {
        action: 'contract.deleted',
        entity_type: 'contract',
        entity_id: id,
        before: { status: contract.status, customer_id: contract.customer_id },
      },
      trx,
    );
  });
}

export async function deleteInvoice(
  id: string,
  scope: BranchScope,
  by: Deleter,
  db: Knex = defaultDb,
): Promise<void> {
  if (!by.isCorporate) throw forbidden('Only the office (a corporate account) can delete an invoice');
  await db.transaction(async (trx) => {
    const invoice = await applyBranchScope(trx('invoices'), 'branch_id', scope).andWhere({ id }).first();
    if (!invoice) throw notFound('Invoice not found');

    await trx('payments').where({ invoice_id: id }).del();
    await trx('invoices').where({ id }).del();

    await recordAudit(
      by.actor,
      {
        action: 'invoice.deleted',
        entity_type: 'invoice',
        entity_id: id,
        before: { status: invoice.status, amount_due: invoice.amount_due, amount_paid: invoice.amount_paid },
      },
      trx,
    );
  });
}

export async function deleteWorkOrder(
  id: string,
  scope: BranchScope,
  by: Deleter,
  db: Knex = defaultDb,
): Promise<void> {
  if (!by.isCorporate) throw forbidden('Only the office (a corporate account) can delete a visit');
  await db.transaction(async (trx) => {
    const order = await applyBranchScope(trx('work_orders'), 'branch_id', scope).andWhere({ id }).first();
    if (!order) throw notFound('Visit not found');

    // Photos and review requests cascade; message history keeps its row.
    await trx('work_orders').where({ id }).del();

    await recordAudit(
      by.actor,
      {
        action: 'work_order.deleted',
        entity_type: 'work_order',
        entity_id: id,
        before: { status: order.status, scheduled_for: order.scheduled_for },
      },
      trx,
    );
  });
}

export async function deleteUser(id: string, by: Deleter, db: Knex = defaultDb): Promise<void> {
  if (!by.isCorporate) throw forbidden('Only the office (a corporate account) can delete an account');
  if (id === by.actor.user_id) throw badRequest('You cannot delete your own account');
  await db.transaction(async (trx) => {
    const user = await trx('users').where({ id }).forUpdate().first();
    if (!user) throw notFound('Account not found');
    if (user.role === 'corporate') {
      const others = await trx('users').where({ role: 'corporate' }).whereNot({ id }).first('id');
      if (!others) throw conflict('That is the last corporate account, so nobody could sign in to run the company');
    }

    // Their documents cascade; visits they were on go back to unassigned,
    // and everything they created or reviewed keeps its row, unattributed.
    await trx('users').where({ id }).del();

    await recordAudit(
      by.actor,
      {
        action: 'user.deleted',
        entity_type: 'user',
        entity_id: id,
        before: { email: user.email, role: user.role, name: `${user.first_name} ${user.last_name}` },
      },
      trx,
    );
  });
}
