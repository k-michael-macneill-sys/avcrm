import type { Knex } from 'knex';

/**
 * The state of each checkbox at signature. Rows are written with the contract,
 * inside the same transaction, so a contract can never exist without its
 * checklist.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('contract_checklist_items', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('contract_id')
      .notNullable()
      .references('id')
      .inTable('contracts')
      .onDelete('CASCADE');
    table
      .text('item_code')
      .notNullable()
      .references('code')
      .inTable('checklist_requirements')
      .onDelete('RESTRICT');
    table.boolean('checked').notNullable().defaultTo(false);
    table.timestamp('checked_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['contract_id'], 'contract_checklist_items_contract_id_index');
  });

  await knex.raw(`
    alter table contract_checklist_items add constraint contract_checklist_items_unique
      unique (contract_id, item_code)
  `);

  // A ticked box always carries the time it was ticked.
  await knex.raw(`
    alter table contract_checklist_items add constraint contract_checklist_items_checked_at_check
      check ((checked = false and checked_at is null) or (checked = true and checked_at is not null))
  `);

  await knex.raw(`
    create trigger contract_checklist_items_set_updated_at before update on contract_checklist_items
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('contract_checklist_items');
}
