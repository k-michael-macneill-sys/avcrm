import type { Knex } from 'knex';

/**
 * Signing a contract without a rep in the room.
 *
 * Door to door, the customer signs on the rep's phone and the contract exists
 * before anyone walks away. A lead from an online ad has nobody to hand a
 * phone to, so instead they are emailed a link: one page showing the same
 * agreement, a signature box, and the processor's card form.
 *
 * The link itself is a signed token with an expiry, the way upload targets
 * already work — there is nothing secret in this table to leak. What the row
 * is for is the things a token cannot say: whether the customer has already
 * signed (so the link stops working), which contract came out of it, and who
 * on the sales side sent it.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('signing_requests', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // What they are being asked to sign. Cascades: a quote that is deleted
    // takes its unsent invitations with it.
    table
      .uuid('quote_id')
      .notNullable()
      .references('id')
      .inTable('quotes')
      .onDelete('CASCADE');
    table
      .uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('CASCADE');
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    // What comes out of it, once they sign.
    table
      .uuid('contract_id')
      .nullable()
      .references('id')
      .inTable('contracts')
      .onDelete('SET NULL');
    table.text('sent_to').notNullable();
    table.text('status').notNullable().defaultTo('sent');
    table
      .uuid('requested_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('expires_at', { useTz: true }).notNullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['quote_id'], 'signing_requests_quote_id_index');
    table.index(['customer_id'], 'signing_requests_customer_id_index');
    table.index(['branch_id', 'status'], 'signing_requests_branch_status_index');
  });

  await knex.raw(`
    alter table signing_requests add constraint signing_requests_status_check
      check (status in ('sent', 'completed', 'expired', 'cancelled'))
  `);

  // A completed request has both a time and the contract it produced; one
  // without the other is a half-written outcome nobody can act on.
  await knex.raw(`
    alter table signing_requests add constraint signing_requests_completed_check
      check ((status = 'completed') = (completed_at is not null and contract_id is not null))
  `);

  await knex.raw(`
    create trigger signing_requests_set_updated_at before update on signing_requests
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('signing_requests');
}
