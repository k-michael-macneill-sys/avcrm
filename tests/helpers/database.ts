import { after } from 'node:test';
import { db } from '../../src/db/client';

/**
 * The database a test run owns.
 *
 * Real Postgres, not a fake: every constraint, trigger and partial index in
 * this schema is load-bearing — the append-only audit trigger, the one active
 * contract per property, the one non-void invoice per period — and a test that
 * does not exercise them is testing something other than this system.
 *
 * The run points at its own database (DATABASE_URL in the test script), so it
 * can truncate freely without touching whatever is in the dev one.
 */

/** Every table that holds test data, children before parents. */
const TABLES = [
  'audit_log',
  'integration_settings',
  'card_setups',
  'payments',
  'invoices',
  'review_requests',
  'meta_messages',
  'meta_conversations',
  'message_log',
  'message_templates',
  'service_photos',
  'work_orders',
  'contract_checklist_items',
  'contracts',
  'quotes',
  'checklist_requirements',
  'pricing_guide',
  'uploads',
  'properties',
  'customers',
  'operator_documents',
  'document_requirements',
  'users',
  'branches',
];

/**
 * Back to empty between tests.
 *
 * TRUNCATE rather than DELETE because audit_log's trigger refuses a DELETE —
 * it is append-only by design, and TRUNCATE does not fire row triggers. One
 * statement across every table also avoids fighting foreign keys in order.
 */
export async function resetDatabase(): Promise<void> {
  await db.raw(`truncate table ${TABLES.map((t) => `"${t}"`).join(', ')} cascade`);
}

/*
 * Registered here rather than by each suite: a file may set up more than one
 * describe block, and the first one finishing must not pull the pool out from
 * under the second. Node runs each test file in its own process, so one
 * file-level hook is exactly the right scope.
 */
after(async () => {
  await db.destroy();
});

export { db };
