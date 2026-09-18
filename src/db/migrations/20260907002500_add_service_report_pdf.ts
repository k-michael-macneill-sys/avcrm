import type { Knex } from 'knex';

/**
 * Where a completed visit's report lives once it has been rendered.
 *
 * Nullable and filled on demand: a report is generated the first time someone
 * asks for one, not on every completion, because most visits are never printed
 * and rendering a PDF nobody reads is work for nothing.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('work_orders', (table) => {
    table.text('report_pdf_url').nullable();
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('work_orders', (table) => {
    table.dropColumn('report_pdf_url');
  });
}
