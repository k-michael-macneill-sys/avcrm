import type { Knex } from 'knex';

/**
 * Settings an administrator changes, rather than a deployment does.
 *
 * Which SMS provider this company uses is not a property of the server — it
 * is a business decision that will be made after this is running, possibly
 * more than once. Putting it in .env would mean a redeploy to change it, and
 * a manager who cannot. So it lives here, edited from the admin screen.
 *
 * Credentials are the reason this is two columns rather than one. Everything
 * an admin needs to see again — the provider, the number messages come from —
 * is readable JSON. The auth token is encrypted before it is written and is
 * never returned by the API, only used at the moment of sending.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.schema.createTable('integration_settings', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    // One row per integration, named by what it is: 'sms' today. The uuid
    // above is the identity — audit_log references entities by one, and a
    // settings change is exactly the kind of thing it exists to record.
    table.text('key').notNullable().unique();
    table.text('provider').notNullable().defaultTo('none');
    table.boolean('is_enabled').notNullable().defaultTo(false);
    // Non-secret configuration. Shown back to the admin as they typed it.
    table.jsonb('settings').notNullable().defaultTo('{}');
    // AES-256-GCM over the secret fields. Null until credentials are saved.
    table.text('secret_ciphertext').nullable();
    table
      .uuid('updated_by_user_id')
      .nullable()
      .references('id')
      .inTable('users')
      .onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  });

  // An integration cannot be switched on without a provider behind it — that
  // combination would silently drop every message it claimed to send.
  await knex.raw(`
    alter table integration_settings add constraint integration_settings_enabled_check
      check (is_enabled = false or provider <> 'none')
  `);

  await knex.raw(`
    create trigger integration_settings_set_updated_at before update on integration_settings
      for each row execute function set_updated_at()
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('integration_settings');
}
