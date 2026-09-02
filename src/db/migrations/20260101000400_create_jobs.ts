import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('jobs', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
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
    table.text('status').notNullable().defaultTo('scheduled');
    table.timestamp('scheduled_date', { useTz: true }).nullable();
    table.timestamp('completed_date', { useTz: true }).nullable();
    table.text('notes').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['branch_id', 'status'], 'jobs_branch_status_index');
    table.index(['customer_id'], 'jobs_customer_id_index');
    table.index(['scheduled_date'], 'jobs_scheduled_date_index');
  });

  await knex.raw(`
    alter table jobs add constraint jobs_status_check
      check (status in ('scheduled', 'dispatched', 'in_progress', 'completed', 'cancelled'))
  `);

  // A completed job must say when it completed, and nothing else may claim to.
  await knex.raw(`
    alter table jobs add constraint jobs_completed_date_check
      check (
        (status = 'completed' and completed_date is not null)
        or (status <> 'completed' and completed_date is null)
      )
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('jobs');
}
