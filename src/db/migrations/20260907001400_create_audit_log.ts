import type { Knex } from 'knex';

/**
 * Append-only record of writes worth disputing later: contracts, quote
 * pricing, and user roles. The spec asks for this the first time a rep
 * disputes a commission or a customer disputes a charge.
 *
 * There is no updated_at, because rows are never updated. The trigger below
 * enforces that at the database rather than trusting every future caller.
 * TRUNCATE does not fire row triggers, which is how the dev seed resets it.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('audit_log', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // SET NULL, not CASCADE: removing a user must not erase what they did.
    table
      .uuid('user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    // Dotted verb, e.g. contract.created, quote.status_changed.
    table.text('action').notNullable();
    table.text('entity_type').notNullable();
    table.uuid('entity_id').notNullable();
    table.jsonb('before_json').nullable();
    table.jsonb('after_json').nullable();
    table.text('ip_address').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['entity_type', 'entity_id'], 'audit_log_entity_index');
    table.index(['user_id'], 'audit_log_user_id_index');
    table.index(['created_at'], 'audit_log_created_at_index');
  });

  await knex.raw(`
    create or replace function reject_audit_log_change() returns trigger as $$
    begin
      raise exception 'audit_log is append-only';
    end;
    $$ language plpgsql
  `);

  await knex.raw(`
    create trigger audit_log_append_only before update or delete on audit_log
      for each row execute function reject_audit_log_change()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('audit_log');
  await knex.raw('drop function if exists reject_audit_log_change()');
}
