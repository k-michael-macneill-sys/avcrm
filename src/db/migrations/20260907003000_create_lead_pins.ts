import type { Knex } from 'knex';

/**
 * The door-knocking map: one pin per house a rep has been to, and how it
 * went.
 *
 * A pin is a place first and an address second. It is dropped where the rep
 * tapped, and the address is whatever the map could work out for that spot —
 * which is usually right and occasionally missing, so every address column
 * is nullable rather than the pin being refused.
 *
 * Signed customers are not pinned here. They are drawn from their property,
 * which is where their address lives once they are real; a pin that became a
 * customer keeps its customer_id and drops off the map when they sign.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('lead_pins', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('branch_id')
      .notNullable()
      .references('id')
      .inTable('branches')
      .onDelete('RESTRICT');
    table.decimal('latitude', 9, 6).notNullable();
    table.decimal('longitude', 9, 6).notNullable();
    table.text('address_line1').nullable();
    table.text('city').nullable();
    table.text('province').nullable();
    table.text('postal_code').nullable();
    table.text('status').notNullable();
    table.text('notes').nullable();
    // Set once the house becomes a lead with a name, or goes into sign-up.
    table
      .uuid('customer_id')
      .nullable()
      .references('id')
      .inTable('customers')
      .onDelete('SET NULL');
    // How many times somebody has knocked, and when the last time was — "not
    // home" three evenings running is worth knowing before a fourth.
    table.integer('knock_count').notNullable().defaultTo(1);
    table.timestamp('last_knocked_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table
      .uuid('created_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table
      .uuid('updated_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['branch_id'], 'lead_pins_branch_id_index');
    // The map asks for what is on screen, a box of latitude and longitude.
    table.index(['latitude', 'longitude'], 'lead_pins_position_index');
    table.index(['customer_id'], 'lead_pins_customer_id_index');
  });

  await knex.raw(`
    alter table lead_pins add constraint lead_pins_status_check
      check (status in ('not_home', 'not_interested', 'lead'))
  `);

  await knex.raw(`
    alter table lead_pins add constraint lead_pins_position_check
      check (latitude between -90 and 90 and longitude between -180 and 180)
  `);

  await knex.raw(`
    create trigger lead_pins_set_updated_at before update on lead_pins
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('lead_pins');
}
