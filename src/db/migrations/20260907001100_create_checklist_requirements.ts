import type { Knex } from 'knex';

/**
 * The checkboxes a rep ticks at signature, seeded from config so a new one can
 * be added without a migration — the same shape as document_requirements.
 *
 * `is_required` is the gate: a contract cannot be submitted until every
 * required item is checked.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('checklist_requirements', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('code').notNullable();
    table.text('label').notNullable();
    table.boolean('is_required').notNullable().defaultTo(true);
    // Display order on the signature screen.
    table.integer('sort_order').notNullable().defaultTo(0);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // contract_checklist_items references code, so it must be unique on its own.
  await knex.raw(`
    alter table checklist_requirements add constraint checklist_requirements_code_unique
      unique (code)
  `);

  await knex.raw(`
    create trigger checklist_requirements_set_updated_at before update on checklist_requirements
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('checklist_requirements');
}
