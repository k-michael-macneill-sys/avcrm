import type { Knex } from 'knex';

/**
 * Config table, not user data. Seeded per province so requirements can vary
 * without a code change. Rows are managed by seeds and corporate admin, and
 * referenced by operator_documents.requirement_code.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('document_requirements', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.text('code').notNullable();
    table.text('label').notNullable();
    // NULL province means the requirement applies everywhere.
    table.text('province').nullable();
    table.boolean('is_required').notNullable().defaultTo(true);
    table.boolean('expires').notNullable().defaultTo(false);
    table.integer('default_validity_days').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // operator_documents references code, so it must be unique on its own.
  await knex.raw('alter table document_requirements add constraint document_requirements_code_unique unique (code)');

  await knex.raw(`
    alter table document_requirements add constraint document_requirements_validity_check
      check (expires = false or default_validity_days is not null)
  `);

  await knex.raw(`
    create trigger document_requirements_set_updated_at before update on document_requirements
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('document_requirements');
}
