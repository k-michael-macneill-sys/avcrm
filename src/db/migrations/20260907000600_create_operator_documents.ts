import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('operator_documents', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('user_id')
      .notNullable()
      .references('id')
      .inTable('users')
      .onDelete('CASCADE');
    table
      .text('requirement_code')
      .notNullable()
      .references('code')
      .inTable('document_requirements')
      .onDelete('RESTRICT');
    // Object storage key in a private bucket, never a public URL.
    table.text('file_url').notNullable();
    table.text('file_name').notNullable();
    table.text('mime_type').notNullable();
    table.integer('file_size').notNullable();
    table.date('issued_on').nullable();
    table.date('expires_on').nullable();
    table.text('status').notNullable().defaultTo('submitted');
    table
      .uuid('reviewed_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('reviewed_at', { useTz: true }).nullable();
    table.text('rejection_reason').nullable();
    // Smallest reminder window already emailed for this document (30, 14, 7),
    // so the nightly job does not send the same warning twice.
    table.integer('last_reminder_days').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['user_id'], 'operator_documents_user_id_index');
    table.index(['status'], 'operator_documents_status_index');
    // The nightly expiry job scans on this.
    table.index(['expires_on'], 'operator_documents_expires_on_index');
  });

  await knex.raw(`
    alter table operator_documents add constraint operator_documents_status_check
      check (status in ('submitted', 'approved', 'rejected', 'expired'))
  `);

  await knex.raw(`
    alter table operator_documents add constraint operator_documents_rejection_check
      check (status <> 'rejected' or rejection_reason is not null)
  `);

  await knex.raw(`
    alter table operator_documents add constraint operator_documents_size_check
      check (file_size > 0)
  `);

  // One live document per requirement per operator. Rejected and expired rows
  // are kept for the audit trail and do not block a fresh submission.
  await knex.raw(`
    create unique index operator_documents_active_unique
      on operator_documents (user_id, requirement_code)
      where status in ('submitted', 'approved')
  `);

  await knex.raw(`
    create trigger operator_documents_set_updated_at before update on operator_documents
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('operator_documents');
}
