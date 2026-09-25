import type { Knex } from 'knex';
import { config } from '../../config';
import { hashPassword } from '../../services/auth';
import { installAppConfig } from '../appConfig';

/**
 * First-run install. Wipes the tables it owns and re-inserts a known set, so
 * it is safe to run repeatedly. Refuses to run against NODE_ENV=production
 * once there is a real account in the database.
 *
 * There is no sample business data here on purpose: branches, crew and
 * customers are the operator's own, created through the Company admin,
 * Operators and Customers screens after the first sign-in — not fake rows
 * to delete before the CRM is usable. The one thing a fresh install cannot
 * bootstrap through its own UI is the first login, so this creates exactly
 * one corporate account for that.
 */
export async function seed(knex: Knex): Promise<void> {
  // This seed wipes every table it owns, so in production it is allowed only
  // where there is nothing to lose: a database with no users in it. That is a
  // first deploy, and the alternative there is a login box nobody can get past.
  //
  // Render runs this on every build, so an existing install must be a quiet
  // no-op rather than an error: a throw here failed every deploy after the
  // first, and Render kept serving the old version with no visible sign.
  // installAppConfig only adds rows, so it still delivers new templates.
  if (config.isProduction) {
    const existingUser = await knex('users').first('id');
    if (existingUser) {
      await installAppConfig(knex);
      console.log('Production database already has users: installed new config only, wiped nothing.');
      return;
    }
  }

  // audit_log is append-only, and its trigger blocks DELETE. TRUNCATE does not
  // fire row triggers, which is exactly what a dev reset needs.
  await knex.raw('truncate table audit_log');
  // Reset to a fresh install: no outside service connected, and no stored
  // credential left over from whatever the last person was testing.
  await knex('integration_settings').del();
  await knex('payments').del();
  await knex('invoices').del();
  await knex('review_requests').del();
  await knex('message_log').del();
  await knex('message_templates').del();
  await knex('service_photos').del();
  await knex('work_orders').del();
  await knex('contract_checklist_items').del();
  await knex('contracts').del();
  await knex('quotes').del();
  await knex('checklist_requirements').del();
  await knex('pricing_guide').del();
  await knex('properties').del();
  await knex('customers').del();
  // The stored files themselves are left on disk: they are content-addressed
  // by a generated uuid, so a re-seed writes new ones rather than colliding.
  await knex('uploads').del();
  await knex('operator_documents').del();
  await knex('document_requirements').del();
  await knex.raw('update branches set manager_user_id = null');
  await knex('users').del();
  await knex('branches').del();

  // --- Configuration ------------------------------------------------------
  // Document requirements, checklist requirements and message templates: the
  // rules the app runs on, not sample data. See src/db/appConfig.ts.
  await installAppConfig(knex);

  // --- The first login ------------------------------------------------------
  // Corporate, so it needs no branch and can create the first one itself.
  const password_hash = await hashPassword(config.seed.password);

  await knex('users').insert({
    email: 'corporate@avcrm.test',
    password_hash,
    first_name: 'ADMIN',
    last_name: '',
    phone: null,
    role: 'corporate',
    branch_id: null,
    onboarding_status: 'approved',
  });
}
