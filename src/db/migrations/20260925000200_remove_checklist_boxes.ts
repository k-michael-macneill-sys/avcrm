import type { Knex } from 'knex';

/**
 * The signature-screen checkboxes are gone: no contract, at the door or by
 * emailed link, collects them any more. Emptying the list in appConfig only
 * stops new installs getting them — a database seeded earlier keeps its rows
 * and keeps rendering the boxes — so they are removed here.
 *
 * The ticks already recorded against contracts go with them; they reference
 * the requirement rows, and a record of boxes that no longer exist would only
 * render as a half-empty checklist on old contracts.
 */
export async function up(knex: Knex): Promise<void> {
  await knex('contract_checklist_items').del();
  await knex('checklist_requirements').del();
}

/** Deleted rows are not restored; there is no list left to restore them from. */
export async function down(): Promise<void> {}
