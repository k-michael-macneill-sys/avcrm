import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('inspections', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('job_id')
      .notNullable()
      .references('id')
      .inTable('jobs')
      .onDelete('CASCADE');
    table.timestamp('timestamp', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.text('photo_url').nullable();
    table.text('notes').nullable();
    table
      .uuid('operator_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['job_id'], 'inspections_job_id_index');
    table.index(['operator_id'], 'inspections_operator_id_index');
  });
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('inspections');
}
