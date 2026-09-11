import type { Knex } from 'knex';

/**
 * Every file the system has been asked to store.
 *
 * A row is written when an upload target is issued, not when the bytes
 * arrive, which gives three things the application needs:
 *
 *   1. read authorization for a key nothing references yet — a signature is
 *      uploaded before the contract that will point at it exists;
 *   2. a record of who uploaded what, which the object store does not keep;
 *   3. a way to find orphans later — issued, stored, and never referenced.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('uploads', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // The object key. Unique because a key names exactly one object.
    table.text('key').notNullable();
    // What it is for, which decides the prefix and the allowed types.
    table.text('purpose').notNullable();
    table.text('content_type').notNullable();
    table.text('file_name').nullable();
    // Null until the bytes land.
    table.integer('byte_size').nullable();
    table.text('status').notNullable().defaultTo('pending');
    table
      .uuid('uploaded_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    // Denormalized so a read can be branch-scoped without chasing the key
    // through every table that might reference it.
    table
      .uuid('branch_id')
      .nullable()
      .references('id')
      .inTable('branches')
      .onDelete('SET NULL');
    table.timestamp('stored_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['uploaded_by_user_id'], 'uploads_uploaded_by_index');
    table.index(['status'], 'uploads_status_index');
  });

  await knex.raw(`
    alter table uploads add constraint uploads_key_unique unique (key)
  `);

  await knex.raw(`
    alter table uploads add constraint uploads_status_check
      check (status in ('pending', 'stored'))
  `);

  await knex.raw(`
    alter table uploads add constraint uploads_stored_check
      check ((status = 'stored') = (stored_at is not null and byte_size is not null))
  `);

  await knex.raw(`
    alter table uploads add constraint uploads_byte_size_check
      check (byte_size is null or byte_size > 0)
  `);

  await knex.raw(`
    create trigger uploads_set_updated_at before update on uploads
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('uploads');
}
