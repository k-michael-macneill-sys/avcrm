import type { Knex } from 'knex';

/**
 * One visit to one property. branch_id is denormalized off the contract so
 * dispatch and the crew lists scope without a three table join; property_id
 * likewise, because every screen that shows a work order shows the address.
 *
 * The operator on assigned_user_id must be approved — assertOperatorAssignable
 * is the gate, enforced in the service rather than here, because the reason
 * for a refusal ("their abstract expired") only exists in the application.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('work_orders', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('contract_id')
      .notNullable()
      .references('id')
      .inTable('contracts')
      .onDelete('CASCADE');
    table
      .uuid('property_id')
      .notNullable()
      .references('id')
      .inTable('properties')
      .onDelete('CASCADE');
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    // Nullable so a job can be scheduled before the branch knows who is free,
    // and so an operator can be deactivated without erasing the run sheet.
    table
      .uuid('assigned_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('scheduled_for', { useTz: true }).notNullable();
    table.text('service_type').notNullable();
    table.text('status').notNullable().defaultTo('scheduled');
    table.text('skip_reason').nullable();
    table.timestamp('started_at', { useTz: true }).nullable();
    table.timestamp('completed_at', { useTz: true }).nullable();
    table.text('operator_notes').nullable();
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['contract_id'], 'work_orders_contract_id_index');
    table.index(['property_id'], 'work_orders_property_id_index');
    // The dispatch board: one branch, one day.
    table.index(['branch_id', 'scheduled_for'], 'work_orders_branch_scheduled_index');
    // An operator's own run sheet.
    table.index(['assigned_user_id', 'scheduled_for'], 'work_orders_assigned_scheduled_index');
    table.index(['status'], 'work_orders_status_index');
  });

  await knex.raw(`
    alter table work_orders add constraint work_orders_service_type_check
      check (service_type in ('snow_clearing', 'salting', 'ice_removal', 'inspection'))
  `);

  await knex.raw(`
    alter table work_orders add constraint work_orders_status_check
      check (status in ('scheduled', 'en_route', 'in_progress', 'completed', 'skipped'))
  `);

  // A skip is only a record if it says why.
  await knex.raw(`
    alter table work_orders add constraint work_orders_skip_reason_check
      check (status <> 'skipped' or skip_reason is not null)
  `);

  await knex.raw(`
    alter table work_orders add constraint work_orders_completed_at_check
      check ((status = 'completed') = (completed_at is not null))
  `);

  await knex.raw(`
    alter table work_orders add constraint work_orders_started_at_check
      check (completed_at is null or started_at is not null)
  `);

  await knex.raw(`
    create trigger work_orders_set_updated_at before update on work_orders
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('work_orders');
}
