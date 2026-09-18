import type { Knex } from 'knex';

/**
 * Proof the work was done. taken_at comes from the image EXIF, not from when
 * the file reached us — an operator with no signal finishes the street and
 * uploads from the truck an hour later, and the record has to say when the
 * driveway was actually cleared.
 *
 * The coordinates are checked against the property in the service, which is
 * where the distance and the sentence explaining it live.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('service_photos', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table
      .uuid('work_order_id')
      .notNullable()
      .references('id')
      .inTable('work_orders')
      .onDelete('CASCADE');
    table.text('photo_type').notNullable();
    // Object storage key in a private bucket, never a public URL.
    table.text('file_url').notNullable();
    table.timestamp('taken_at', { useTz: true }).notNullable();
    table.decimal('latitude', 9, 6).nullable();
    table.decimal('longitude', 9, 6).nullable();
    table
      .uuid('uploaded_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());

    // The completion gate counts before and after photos on this index.
    table.index(['work_order_id', 'photo_type'], 'service_photos_work_order_type_index');
  });

  await knex.raw(`
    alter table service_photos add constraint service_photos_photo_type_check
      check (photo_type in ('before', 'after', 'issue'))
  `);

  await knex.raw(`
    alter table service_photos add constraint service_photos_latitude_check
      check (latitude is null or latitude between -90 and 90)
  `);

  await knex.raw(`
    alter table service_photos add constraint service_photos_longitude_check
      check (longitude is null or longitude between -180 and 180)
  `);

  // A geotag is a pair or it is nothing.
  await knex.raw(`
    alter table service_photos add constraint service_photos_coordinate_pair_check
      check ((latitude is null) = (longitude is null))
  `);

  // The same file cannot be submitted twice for one visit.
  await knex.raw(`
    alter table service_photos add constraint service_photos_file_url_unique
      unique (work_order_id, file_url)
  `);

  await knex.raw(`
    create trigger service_photos_set_updated_at before update on service_photos
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('service_photos');
}
