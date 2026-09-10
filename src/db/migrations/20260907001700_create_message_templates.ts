import type { Knex } from 'knex';

/**
 * Seeded config, like document_requirements and checklist_requirements. A row
 * with a branch_id overrides the global row for the same code and channel, so
 * Halifax can reword a message without forking the code.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('message_templates', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // NULL branch_id is the global default.
    table
      .uuid('branch_id')
      .nullable()
      .references('id')
      .inTable('branches')
      .onDelete('CASCADE');
    table.text('code').notNullable();
    table.text('channel').notNullable();
    // NULL for SMS, which has no subject line.
    table.text('subject').nullable();
    // Mustache-style {{customer_first_name}} tokens.
    table.text('body').notNullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['code', 'channel'], 'message_templates_code_channel_index');
  });

  await knex.raw(`
    alter table message_templates add constraint message_templates_channel_check
      check (channel in ('email', 'sms'))
  `);

  // An email without a subject is a bug; an SMS with one is a misunderstanding.
  await knex.raw(`
    alter table message_templates add constraint message_templates_subject_check
      check ((channel = 'email') = (subject is not null))
  `);

  // One template per code, channel and branch. Two partial indexes rather than
  // one constraint, because NULL never equals NULL in a unique index and the
  // global row has to be unique too.
  await knex.raw(`
    create unique index message_templates_global_unique
      on message_templates (code, channel)
      where branch_id is null
  `);

  await knex.raw(`
    create unique index message_templates_branch_unique
      on message_templates (code, channel, branch_id)
      where branch_id is not null
  `);

  await knex.raw(`
    create trigger message_templates_set_updated_at before update on message_templates
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('message_templates');
}
