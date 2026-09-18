import type { Knex } from 'knex';

/**
 * The outbound queue and its history, in one table. A row is written as
 * `queued` by whatever wanted to say something, and the worker
 * (npm run job:message-queue) picks it up, sends it, and stamps the result.
 *
 * subject and body are stored rendered, which is one column pair more than
 * the spec lists. Two reasons: the render context is gone by the time the
 * worker runs, and a message log whose rows cannot show what was actually
 * sent is not much of a log — editing a template later must not rewrite
 * history.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('message_log', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Denormalized so the queue can be listed per branch without a join.
    table
      .uuid('branch_id')
      .nullable()
      .references('id')
      .inTable('branches')
      .onDelete('SET NULL');
    table
      .uuid('customer_id')
      .nullable()
      .references('id')
      .inTable('customers')
      .onDelete('SET NULL');
    table
      .uuid('work_order_id')
      .nullable()
      .references('id')
      .inTable('work_orders')
      .onDelete('SET NULL');
    // Not a foreign key: a template can be retired without erasing the record
    // of what was sent under it.
    table.text('template_code').notNullable();
    table.text('channel').notNullable();
    table.text('recipient').notNullable();
    table.text('subject').nullable();
    table.text('body').notNullable();
    table.text('status').notNullable().defaultTo('queued');
    table.text('provider_message_id').nullable();
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.text('error').nullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.timestamp('last_attempt_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['customer_id'], 'message_log_customer_id_index');
    table.index(['work_order_id'], 'message_log_work_order_id_index');
    table.index(['branch_id'], 'message_log_branch_id_index');
  });

  await knex.raw(`
    alter table message_log add constraint message_log_channel_check
      check (channel in ('email', 'sms'))
  `);

  await knex.raw(`
    alter table message_log add constraint message_log_status_check
      check (status in ('queued', 'sent', 'failed', 'bounced'))
  `);

  await knex.raw(`
    alter table message_log add constraint message_log_sent_at_check
      check ((status = 'sent') = (sent_at is not null))
  `);

  // The worker's claim query rides this: oldest queued first.
  await knex.raw(`
    create index message_log_queue_index
      on message_log (created_at)
      where status = 'queued'
  `);

  await knex.raw(`
    create trigger message_log_set_updated_at before update on message_log
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('message_log');
}
