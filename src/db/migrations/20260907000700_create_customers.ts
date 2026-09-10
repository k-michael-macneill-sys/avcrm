import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('customers', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // Attribution: stops two branches selling the same person.
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    table.text('first_name').notNullable();
    table.text('last_name').notNullable();
    table.specificType('email', 'citext').nullable();
    table.text('phone').nullable();
    table.text('preferred_contact').notNullable().defaultTo('email');
    table.text('notes').nullable();
    table.text('status').notNullable().defaultTo('lead');
    // The rep who knocked it.
    table
      .uuid('created_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['branch_id'], 'customers_branch_id_index');
    table.index(['branch_id', 'status'], 'customers_branch_status_index');
    table.index(['created_by_user_id'], 'customers_created_by_index');
  });

  await knex.raw(`
    alter table customers add constraint customers_status_check
      check (status in ('lead', 'active', 'churned'))
  `);

  await knex.raw(`
    alter table customers add constraint customers_preferred_contact_check
      check (preferred_contact in ('email', 'sms', 'both'))
  `);

  // A contact method is needed for the channel the customer asked for.
  await knex.raw(`
    alter table customers add constraint customers_contactable_check
      check (
        (preferred_contact = 'email' and email is not null)
        or (preferred_contact = 'sms' and phone is not null)
        or (preferred_contact = 'both' and email is not null and phone is not null)
      )
  `);

  await knex.raw(`
    create trigger customers_set_updated_at before update on customers
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('customers');
}
