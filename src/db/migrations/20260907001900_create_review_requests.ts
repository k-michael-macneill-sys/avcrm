import type { Knex } from 'knex';

/**
 * The one-tap rating sent a day after a finished visit, and what the customer
 * answered.
 *
 * The row id is the capability in the emailed link: it is a random v4 uuid,
 * the rating endpoint is public because a customer has no account, and
 * answering twice is refused. There is no separate token column because the
 * id already is one.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('review_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('CASCADE');
    // The visit that triggered it.
    table
      .uuid('work_order_id')
      .notNullable()
      .references('id')
      .inTable('work_orders')
      .onDelete('CASCADE');
    // Denormalized so the branch manager's feedback list scopes without a join.
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    table.timestamp('sent_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('channel').notNullable();
    table.integer('rating_response').nullable();
    table.text('routed_to').nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // The 90 day cap per customer reads this.
    table.index(['customer_id', 'sent_at'], 'review_requests_customer_sent_index');
    table.index(['branch_id', 'routed_to'], 'review_requests_branch_routed_index');
  });

  // One ask per visit. Asking the same customer twice about one driveway is
  // how a list gets burned out over a winter.
  await knex.raw(`
    alter table review_requests add constraint review_requests_work_order_unique
      unique (work_order_id)
  `);

  await knex.raw(`
    alter table review_requests add constraint review_requests_channel_check
      check (channel in ('email', 'sms'))
  `);

  await knex.raw(`
    alter table review_requests add constraint review_requests_rating_check
      check (rating_response is null or rating_response between 1 and 5)
  `);

  await knex.raw(`
    alter table review_requests add constraint review_requests_routed_to_check
      check (routed_to is null or routed_to in ('google_review', 'internal_feedback'))
  `);

  // An answer is a rating, a route and a time, or it is none of them.
  await knex.raw(`
    alter table review_requests add constraint review_requests_answer_check
      check (
        (rating_response is null and routed_to is null and completed_at is null)
        or (rating_response is not null and routed_to is not null and completed_at is not null)
      )
  `);

  await knex.raw(`
    create trigger review_requests_set_updated_at before update on review_requests
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('review_requests');
}
