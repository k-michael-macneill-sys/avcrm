import type { Knex } from 'knex';

/**
 * Facebook Page and Instagram direct messages: one conversation per person
 * per platform, and every message in and out of it.
 *
 * Three things here go beyond a plain inbox:
 *
 *   - branch_id is nullable. A message from the internet says which Page it
 *     reached, not which branch should answer it, so a new conversation with
 *     nobody to route it to lands unassigned — corporate sees it and assigns
 *     it. With a single branch there is nobody to choose and it goes straight
 *     there.
 *   - Outbound rows are the queue, the same way message_log is: written as
 *     `queued` by the reply endpoint, claimed and sent by the message-queue
 *     worker. attempts, last_attempt_at, error and sent_at exist for that and
 *     mean what they mean in message_log.
 *   - external_message_id is unique. Meta redelivers webhooks as a matter of
 *     course, and the message id is the only thing that makes a redelivery
 *     recognisable.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('meta_conversations', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('branch_id')
      .nullable()
      .references('id')
      .inTable('branches')
      .onDelete('SET NULL');
    // Set by hand once somebody works out who this is; Meta's ids say nothing
    // about which customer is behind them.
    table
      .uuid('customer_id')
      .nullable()
      .references('id')
      .inTable('customers')
      .onDelete('SET NULL');
    table.text('platform').notNullable();
    // The page-scoped id (PSID) or Instagram-scoped id (IGSID). Scoped to our
    // Page, so it identifies the person only in conversation with us.
    table.text('external_user_id').notNullable();
    // Meta only lets a business reply within 24 hours of the person's last
    // message; this is what the reply endpoint checks against.
    table.timestamp('last_inbound_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.unique(['platform', 'external_user_id'], {
      indexName: 'meta_conversations_platform_user_unique',
    });
    table.index(['branch_id'], 'meta_conversations_branch_id_index');
    table.index(['customer_id'], 'meta_conversations_customer_id_index');
    // The inbox lists most recently active first.
    table.index(['updated_at'], 'meta_conversations_updated_at_index');
  });

  await knex.raw(`
    alter table meta_conversations add constraint meta_conversations_platform_check
      check (platform in ('facebook', 'instagram'))
  `);

  await knex.raw(`
    create trigger meta_conversations_set_updated_at before update on meta_conversations
      for each row execute function set_updated_at()
  `);

  await knex.schema.createTable('meta_messages', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('conversation_id')
      .notNullable()
      .references('id')
      .inTable('meta_conversations')
      .onDelete('CASCADE');
    table.text('direction').notNullable();
    table.text('message_text').notNullable();
    // Meta's mid. Null only while an outbound reply is still queued.
    table.text('external_message_id').nullable();
    table.text('status').notNullable();
    // Who wrote a reply from here. Null for inbound, and for a reply somebody
    // typed straight into Meta's own inbox (it reaches us as an echo).
    table
      .uuid('sent_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('sent_at', { useTz: true }).nullable();
    table.text('error').nullable();
    table.integer('attempts').notNullable().defaultTo(0);
    table.timestamp('last_attempt_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['conversation_id', 'created_at'], 'meta_messages_conversation_index');
  });

  await knex.raw(`
    alter table meta_messages add constraint meta_messages_direction_check
      check (direction in ('inbound', 'outbound'))
  `);

  // Inbound is only ever received; outbound moves through the queue.
  await knex.raw(`
    alter table meta_messages add constraint meta_messages_status_check
      check (
        (direction = 'inbound' and status = 'received')
        or (direction = 'outbound' and status in ('queued', 'sent', 'failed'))
      )
  `);

  await knex.raw(`
    alter table meta_messages add constraint meta_messages_sent_at_check
      check ((status = 'sent') = (sent_at is not null))
  `);

  await knex.raw(`
    create unique index meta_messages_external_id_unique
      on meta_messages (external_message_id)
      where external_message_id is not null
  `);

  // The worker's claim query rides this: oldest queued first.
  await knex.raw(`
    create index meta_messages_queue_index
      on meta_messages (created_at)
      where status = 'queued'
  `);

  await knex.raw(`
    create trigger meta_messages_set_updated_at before update on meta_messages
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('meta_messages');
  await knex.schema.dropTableIfExists('meta_conversations');
}
