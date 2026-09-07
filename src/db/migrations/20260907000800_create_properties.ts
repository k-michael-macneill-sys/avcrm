import type { Knex } from 'knex';

export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('properties', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('customer_id')
      .notNullable()
      .references('id')
      .inTable('customers')
      .onDelete('CASCADE');
    table.text('address_line1').notNullable();
    table.text('address_line2').nullable();
    table.text('city').notNullable();
    table.text('province').notNullable();
    table.text('postal_code').notNullable();
    // For the sales map and for validating service photo geotags.
    table.decimal('latitude', 9, 6).nullable();
    table.decimal('longitude', 9, 6).nullable();
    // Dropdown 1-6, where 6 means "6+".
    table.integer('driveway_size_cars').nullable();
    // Gate codes, where to pile snow, dog on property.
    table.text('access_notes').nullable();
    // Medical or mobility need: these get serviced first.
    table.boolean('priority_flag').notNullable().defaultTo(false);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    table.index(['customer_id'], 'properties_customer_id_index');
    table.index(['priority_flag'], 'properties_priority_flag_index');
  });

  await knex.raw(`
    alter table properties add constraint properties_driveway_size_check
      check (driveway_size_cars is null or driveway_size_cars between 1 and 6)
  `);

  await knex.raw(`
    alter table properties add constraint properties_latitude_check
      check (latitude is null or latitude between -90 and 90)
  `);

  await knex.raw(`
    alter table properties add constraint properties_longitude_check
      check (longitude is null or longitude between -180 and 180)
  `);

  // Duplicate guard across the whole book, not per branch: the point is to
  // catch a second rep signing an address another branch already sold.
  // Postal code is compared with case and spacing stripped; the street line
  // with case folded and internal whitespace collapsed.
  await knex.raw(`
    create unique index properties_normalized_address_unique on properties (
      upper(regexp_replace(postal_code, '\\s+', '', 'g')),
      lower(regexp_replace(btrim(address_line1), '\\s+', ' ', 'g'))
    )
  `);

  await knex.raw(`
    create trigger properties_set_updated_at before update on properties
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('properties');
}
