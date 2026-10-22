import type { Knex } from 'knex';

/**
 * Service now starts at 5 cm of snow, not 3. Agreements not signed yet are
 * moved to the new depth, so the copy the customer signs says 5 cm. A signed
 * contract keeps the depth on the agreement the customer signed.
 */
const unsigned = (knex: Knex) =>
  knex('quotes')
    .whereIn('status', ['draft', 'presented'])
    .whereNotExists(knex('contracts').whereRaw('contracts.quote_id = quotes.id').select(knex.raw('1')));

export async function up(knex: Knex): Promise<void> {
  await unsigned(knex).where({ trigger_cm: '3.0' }).update({ trigger_cm: '5.0' });
}

export async function down(knex: Knex): Promise<void> {
  await unsigned(knex).where({ trigger_cm: '5.0' }).update({ trigger_cm: '3.0' });
}
