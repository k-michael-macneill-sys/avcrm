import type { Knex } from 'knex';

/**
 * Takes the sample company back out of a database the old seed filled.
 *
 * The first deploys seeded a whole pretend business — the Kingston and
 * Halifax branches, three managers and operators, Harold Bell and four other
 * customers, and every quote, contract, visit and invoice hung off them. The
 * seed stopped doing that, but a seed only runs on an empty database, so an
 * install made before the change still has all of it, and there is no shell
 * on the host to clear it by hand. This runs once, on the next boot.
 *
 * It removes exactly what the old seed wrote and nothing else. Rows are found
 * by the addresses and names the seed used — @avcrm.test staff, @example.test
 * customers, and the one seeded customer with no email, matched on name and
 * phone together. A branch is only removed if nothing real has been attached
 * to it since; one somebody has started using is left alone.
 *
 * On a database that never had the sample data — every install from now on,
 * and the test suite — every query here matches nothing.
 */

const DEMO_STAFF_EMAILS = [
  'kingston.manager@avcrm.test',
  'halifax.manager@avcrm.test',
  'otto@avcrm.test',
  'nina@avcrm.test',
  'pat@avcrm.test',
];

const DEMO_CUSTOMER_EMAILS = [
  'harold.bell@example.test',
  'priya.raman@example.test',
  'elaine.fortier@example.test',
  'sam.toussaint@example.test',
];

const DEMO_BRANCH_NAMES = ['Kingston', 'Halifax'];

export async function up(knex: Knex): Promise<void> {
  const customerIds: string[] = await knex('customers')
    .whereIn('email', DEMO_CUSTOMER_EMAILS)
    .orWhere((q) =>
      q
        .where({ first_name: 'Doug', last_name: 'Whitaker', phone: '613-555-0203' })
        .whereNull('email'),
    )
    .pluck('id');

  const staffIds: string[] = await knex('users')
    .whereIn('email', DEMO_STAFF_EMAILS)
    .pluck('id');

  if (customerIds.length > 0) {
    const contractIds: string[] = await knex('contracts')
      .whereIn('customer_id', customerIds)
      .pluck('id');

    const invoiceIds: string[] = await knex('invoices')
      .whereIn('customer_id', customerIds)
      .orWhereIn('contract_id', contractIds)
      .pluck('id');

    // Money first: payments and invoices refuse to let their parents go.
    await knex('payments').whereIn('invoice_id', invoiceIds).del();
    await knex('invoices').whereIn('id', invoiceIds).del();
    await knex('message_log').whereIn('customer_id', customerIds).del();
    // Takes checklist items, visits, their photos and review requests with it.
    await knex('contracts').whereIn('id', contractIds).del();
    // Takes properties, quotes, card setups and signing links with it.
    await knex('customers').whereIn('id', customerIds).del();
  }

  if (staffIds.length > 0) {
    // The audit log is append-only, and deleting a user nulls their id on
    // every row they wrote — an update, which it refuses. What these five
    // pretend people "did" is not history anybody needs, so their rows go.
    // Disabling the trigger is scoped to this transaction.
    await knex.raw('alter table audit_log disable trigger audit_log_append_only');
    await knex('audit_log').whereIn('user_id', staffIds).del();
    await knex.raw('alter table audit_log enable trigger audit_log_append_only');

    await knex('uploads').whereIn('uploaded_by_user_id', staffIds).del();
    // Takes their document vault with it.
    await knex('users').whereIn('id', staffIds).del();
  }

  const branches: { id: string }[] = await knex('branches')
    .whereIn('name', DEMO_BRANCH_NAMES)
    .select('id');

  for (const { id } of branches) {
    const stillUsed = await Promise.all(
      [
        'users',
        'customers',
        'work_orders',
        'invoices',
        'review_requests',
        'card_setups',
        'signing_requests',
      ].map((table) => knex(table).where({ branch_id: id }).first('branch_id')),
    );
    if (stillUsed.some(Boolean)) continue;

    // Takes the sample rate cards and the Halifax template override with it.
    await knex('branches').where({ id }).del();
  }

  // The admin account keeps its login; only the sample person's name goes.
  // Left alone if somebody has already renamed it.
  await knex('users')
    .where({ email: 'corporate@avcrm.test', first_name: 'Ada', last_name: 'Corporate' })
    .update({ first_name: 'ADMIN', last_name: '' });
}

export async function down(): Promise<void> {
  // Nothing to put back: this removed sample data, on purpose.
}
