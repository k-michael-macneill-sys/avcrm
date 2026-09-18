import type { Knex } from 'knex';
import { closeConnection, db as defaultDb } from '../db/client';
import { gateway } from '../services/gateway';
import {
  generateInvoicesForContract,
  markOverdue,
  sendInvoice,
  today,
} from '../services/invoices';
import { chargeInvoice } from '../services/payments';
import { logger } from '../utils/logger';

/**
 * The daily billing pass, in two phases:
 *
 *   1. Raise and send any invoice a live contract owes by today. Monthly
 *      contracts get one per period as the period starts; seasonal ones were
 *      already billed at signature.
 *   2. Charge every outstanding invoice that has a card on file, which is
 *      what capturing a reusable payment method was for.
 *   3. Mark anything still sent, past its date and short as overdue, which
 *      queues the reminder.
 *
 *   npm run job:billing
 *
 * Safe to run twice in a night: a period already invoiced is skipped, and a
 * partial unique index backs that up if two runs race.
 */
export interface BillingSummary {
  ran_for: string;
  contracts_considered: number;
  invoices_raised: number;
  invoices_sent: number;
  /** Charged against a saved card. */
  charged: number;
  /** The card said no. The customer and the branch manager have been told. */
  declined: number;
  marked_overdue: number;
}

export async function runBilling(
  asOf: string = today(),
  db: Knex = defaultDb,
): Promise<BillingSummary> {
  const summary: BillingSummary = {
    ran_for: asOf,
    contracts_considered: 0,
    invoices_raised: 0,
    invoices_sent: 0,
    charged: 0,
    declined: 0,
    marked_overdue: 0,
  };

  // Only live contracts whose season has started. A cancelled contract stops
  // being billed simply by not appearing here.
  const contracts = await db('contracts')
    .join('quotes', 'quotes.id', 'contracts.quote_id')
    .where('contracts.status', 'active')
    .andWhere('quotes.season_start', '<=', asOf)
    .pluck('contracts.id');

  summary.contracts_considered = contracts.length;

  for (const contractId of contracts) {
    const raised = await generateInvoicesForContract(contractId, asOf, db);
    summary.invoices_raised += raised.length;

    for (const invoice of raised) {
      // Corporate scope: this is the company's own scheduled work, not a
      // request from a branch.
      await sendInvoice(invoice.id, { kind: 'all' }, db);
      summary.invoices_sent += 1;
    }
  }

  // Take the money before deciding what is late: an invoice the card pays
  // today should never be called overdue in the same run.
  if (gateway.canCharge) {
    const chargeable = (await db('invoices')
      .join('contracts', 'contracts.id', 'invoices.contract_id')
      .whereIn('invoices.status', ['sent', 'overdue'])
      .andWhereRaw('invoices.amount_paid < invoices.amount_due')
      .whereNotNull('contracts.payment_method_token')
      .pluck('invoices.id')) as string[];

    for (const invoiceId of chargeable) {
      try {
        const invoice = await chargeInvoice(
          invoiceId,
          { kind: 'all' },
          // The company charging its own customers on a schedule: no person
          // to attribute it to, which the audit log records as such.
          { user_id: null, ip_address: null },
          db,
        );
        if (invoice.status === 'paid') summary.charged += 1;
        else summary.declined += 1;
      } catch (err) {
        // One bad card must not stop the rest of the run.
        summary.declined += 1;
        logger.error({ err, invoice_id: invoiceId }, 'Could not charge the card on file');
      }
    }
  }

  const overdue = await markOverdue(asOf, db);
  summary.marked_overdue = overdue.marked;

  logger.info(summary, 'Billing run complete');
  return summary;
}

// Entry point when run as a script rather than imported.
if (require.main === module) {
  // An optional date argument runs the pass as if it were that day, which is
  // how you exercise a season that has not started yet, or backfill a night
  // the scheduler missed:  npm run job:billing -- 2027-01-20
  const asOf = process.argv[2];
  if (asOf && !/^\d{4}-\d{2}-\d{2}$/.test(asOf)) {
    logger.error({ asOf }, 'Expected a YYYY-MM-DD date');
    process.exit(1);
  }

  runBilling(asOf || undefined)
    .then(async (summary) => {
      await closeConnection();
      logger.info(summary, 'Done');
      process.exit(0);
    })
    .catch(async (err) => {
      logger.error({ err }, 'Billing run failed');
      await closeConnection();
      process.exit(1);
    });
}
