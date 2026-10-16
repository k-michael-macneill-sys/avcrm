import type { Knex } from 'knex';

/**
 * Each branch's own phone and email, printed on its agreements where the
 * template has "[Phone number]" and "[Email address]".
 *
 * Written out here rather than imported: a migration is history, and must
 * not change when the application's list does. A branch that already has
 * a contact keeps it.
 */
const CONTACTS = [
  { name: 'Regina', contact_phone: '(306) 570-5877', contact_email: 'Carter.o@drift-ps.com' },
  { name: 'Kingston', contact_phone: '(519) 221-6191', contact_email: 'm.macneill@drift-ps.com' },
  { name: 'Cranbrook', contact_phone: '(403) 915-0530', contact_email: 'benatwood02@gmail.com' },
  { name: 'Alberta', contact_phone: '(587) 257-9211', contact_email: 'm.macneill@drift-ps.com' },
];

export async function up(knex: Knex): Promise<void> {
  await knex.schema.alterTable('branches', (table) => {
    table.text('contact_phone').nullable();
    table.text('contact_email').nullable();
  });

  for (const { name, ...contact } of CONTACTS) {
    await knex('branches').whereRaw('lower(name) = lower(?)', [name]).update(contact);
  }
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.alterTable('branches', (table) => {
    table.dropColumn('contact_phone');
    table.dropColumn('contact_email');
  });
}
