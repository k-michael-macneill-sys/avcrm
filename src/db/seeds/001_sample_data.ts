import type { Knex } from 'knex';
import { config } from '../../config';
import { hashPassword } from '../../services/auth';
import { addDays } from '../../services/operators';

/**
 * Development data. Wipes the tables it owns and re-inserts a known set, so it
 * is safe to run repeatedly. Refuses to run against NODE_ENV=production.
 *
 * The operators are deliberately spread across onboarding states so the
 * compliance view and the expiry job have something real to chew on.
 */
export async function seed(knex: Knex): Promise<void> {
  if (config.isProduction) {
    throw new Error('Refusing to run seeds with NODE_ENV=production');
  }

  await knex('properties').del();
  await knex('customers').del();
  await knex('operator_documents').del();
  await knex('document_requirements').del();
  await knex.raw('update branches set manager_user_id = null');
  await knex('users').del();
  await knex('branches').del();

  const today = new Date().toISOString().slice(0, 10);

  // --- Branches -----------------------------------------------------------
  const branches = await knex('branches')
    .insert([
      { name: 'Kingston', province: 'ON', timezone: 'America/Toronto' },
      { name: 'Halifax', province: 'NS', timezone: 'America/Halifax' },
    ])
    .returning(['id', 'name']);

  const kingston = branches.find((b) => b.name === 'Kingston');
  const halifax = branches.find((b) => b.name === 'Halifax');
  if (!kingston || !halifax) throw new Error('Branch seed failed');

  // --- Users --------------------------------------------------------------
  const password_hash = await hashPassword(config.seed.password);

  const users = await knex('users')
    .insert([
      {
        email: 'corporate@avcrm.test',
        password_hash,
        first_name: 'Ada',
        last_name: 'Corporate',
        phone: '613-555-0100',
        role: 'corporate',
        branch_id: null,
        onboarding_status: 'approved',
      },
      {
        email: 'kingston.manager@avcrm.test',
        password_hash,
        first_name: 'Marty',
        last_name: 'Manager',
        phone: '613-555-0111',
        role: 'corporate',
        branch_id: kingston.id,
        onboarding_status: 'approved',
      },
      {
        email: 'halifax.manager@avcrm.test',
        password_hash,
        first_name: 'Dee',
        last_name: 'Dartmouth',
        phone: '902-555-0122',
        role: 'corporate',
        branch_id: halifax.id,
        onboarding_status: 'approved',
      },
      {
        // Fully compliant: shows up in the assignable pool.
        email: 'otto@avcrm.test',
        password_hash,
        first_name: 'Otto',
        last_name: 'Plows',
        phone: '613-555-0133',
        role: 'operator',
        branch_id: kingston.id,
        onboarding_status: 'approved',
      },
      {
        // Has an abstract expiring inside the 30 day window.
        email: 'nina@avcrm.test',
        password_hash,
        first_name: 'Nina',
        last_name: 'Salter',
        phone: '613-555-0144',
        role: 'operator',
        branch_id: kingston.id,
        onboarding_status: 'approved',
      },
      {
        // Documents submitted but not reviewed yet.
        email: 'pat@avcrm.test',
        password_hash,
        first_name: 'Pat',
        last_name: 'Pending',
        phone: '902-555-0155',
        role: 'operator',
        branch_id: halifax.id,
        onboarding_status: 'pending',
      },
    ])
    .returning(['id', 'email']);

  const byEmail = (email: string) => {
    const found = users.find((u) => u.email === email);
    if (!found) throw new Error(`User seed failed: ${email}`);
    return found;
  };

  const kingstonManager = byEmail('kingston.manager@avcrm.test');
  const halifaxManager = byEmail('halifax.manager@avcrm.test');
  const corporate = byEmail('corporate@avcrm.test');
  const otto = byEmail('otto@avcrm.test');
  const nina = byEmail('nina@avcrm.test');
  const pat = byEmail('pat@avcrm.test');

  await knex('branches')
    .where({ id: kingston.id })
    .update({ manager_user_id: kingstonManager.id });
  await knex('branches')
    .where({ id: halifax.id })
    .update({ manager_user_id: halifaxManager.id });

  // --- Document requirements ---------------------------------------------
  await knex('document_requirements').insert([
    {
      code: 'drivers_license',
      label: "Driver's licence",
      province: null,
      is_required: true,
      expires: true,
      default_validity_days: 1825,
    },
    {
      code: 'drivers_abstract',
      label: "Driver's abstract",
      province: null,
      is_required: true,
      expires: true,
      default_validity_days: 365,
    },
    {
      code: 'insurance_certificate',
      label: 'Insurance certificate',
      province: null,
      is_required: true,
      expires: true,
      default_validity_days: 365,
    },
    {
      code: 'vehicle_registration',
      label: 'Vehicle registration',
      province: null,
      is_required: true,
      expires: true,
      default_validity_days: 365,
    },
    {
      code: 'contractor_agreement',
      label: 'Contractor agreement',
      province: null,
      is_required: true,
      expires: false,
      default_validity_days: null,
    },
    {
      code: 'void_cheque',
      label: 'Void cheque',
      province: null,
      is_required: true,
      expires: false,
      default_validity_days: null,
    },
    {
      code: 'tax_form',
      label: 'Tax form',
      province: null,
      is_required: true,
      expires: false,
      default_validity_days: null,
    },
    {
      // Ontario's workers' compensation board; NS has its own scheme.
      code: 'wsib_clearance',
      label: 'WSIB clearance certificate',
      province: 'ON',
      is_required: true,
      expires: true,
      default_validity_days: 90,
    },
    {
      code: 'criminal_record_check',
      label: 'Criminal record check',
      province: null,
      is_required: false,
      expires: true,
      default_validity_days: 1095,
    },
  ]);

  // --- Operator documents -------------------------------------------------
  const file = (code: string, userEmail: string) => ({
    file_url: `private/operator-docs/${userEmail}/${code}.pdf`,
    file_name: `${code}.pdf`,
    mime_type: 'application/pdf',
    file_size: 184_320,
  });

  const approved = (
    userId: string,
    email: string,
    code: string,
    expiresOn: string | null,
  ) => ({
    user_id: userId,
    requirement_code: code,
    ...file(code, email),
    issued_on: expiresOn ? addDays(expiresOn, -365) : null,
    expires_on: expiresOn,
    status: 'approved' as const,
    reviewed_by_user_id: corporate.id,
    reviewed_at: new Date(),
  });

  // Otto is fully compliant, everything comfortably in date.
  const ottoRequired = [
    'drivers_license',
    'drivers_abstract',
    'insurance_certificate',
    'vehicle_registration',
    'wsib_clearance',
  ];
  const ottoRows = ottoRequired.map((code) =>
    approved(otto.id, 'otto@avcrm.test', code, addDays(today, 200)),
  );
  ottoRows.push(
    approved(otto.id, 'otto@avcrm.test', 'contractor_agreement', null),
    approved(otto.id, 'otto@avcrm.test', 'void_cheque', null),
    approved(otto.id, 'otto@avcrm.test', 'tax_form', null),
  );

  // Nina is compliant today, but her abstract lands inside the 30 day window
  // so the nightly job has a reminder to send.
  const ninaRows = [
    approved(nina.id, 'nina@avcrm.test', 'drivers_license', addDays(today, 400)),
    approved(nina.id, 'nina@avcrm.test', 'drivers_abstract', addDays(today, 21)),
    approved(nina.id, 'nina@avcrm.test', 'insurance_certificate', addDays(today, 150)),
    approved(nina.id, 'nina@avcrm.test', 'vehicle_registration', addDays(today, 150)),
    approved(nina.id, 'nina@avcrm.test', 'wsib_clearance', addDays(today, 60)),
    approved(nina.id, 'nina@avcrm.test', 'contractor_agreement', null),
    approved(nina.id, 'nina@avcrm.test', 'void_cheque', null),
    approved(nina.id, 'nina@avcrm.test', 'tax_form', null),
  ];

  // Pat has submitted two documents that nobody has reviewed yet.
  const patRows = [
    {
      user_id: pat.id,
      requirement_code: 'drivers_license',
      ...file('drivers_license', 'pat@avcrm.test'),
      issued_on: addDays(today, -30),
      expires_on: addDays(today, 1795),
      status: 'submitted' as const,
    },
    {
      user_id: pat.id,
      requirement_code: 'contractor_agreement',
      ...file('contractor_agreement', 'pat@avcrm.test'),
      issued_on: addDays(today, -30),
      expires_on: null,
      status: 'submitted' as const,
    },
  ];

  await knex('operator_documents').insert([...ottoRows, ...ninaRows, ...patRows]);

  // --- Customers and properties ------------------------------------------
  const customers = await knex('customers')
    .insert([
      {
        branch_id: kingston.id,
        first_name: 'Harold',
        last_name: 'Bell',
        email: 'harold.bell@example.test',
        phone: '613-555-0201',
        preferred_contact: 'both',
        status: 'active',
        notes: 'Signed at the door, wants the driveway done before 7am.',
        created_by_user_id: otto.id,
      },
      {
        branch_id: kingston.id,
        first_name: 'Priya',
        last_name: 'Raman',
        email: 'priya.raman@example.test',
        phone: '613-555-0202',
        preferred_contact: 'email',
        status: 'active',
        created_by_user_id: nina.id,
      },
      {
        branch_id: kingston.id,
        first_name: 'Doug',
        last_name: 'Whitaker',
        phone: '613-555-0203',
        preferred_contact: 'sms',
        status: 'lead',
        notes: 'Asked us to come back after the first snowfall.',
        created_by_user_id: otto.id,
      },
      {
        branch_id: kingston.id,
        first_name: 'Elaine',
        last_name: 'Fortier',
        email: 'elaine.fortier@example.test',
        preferred_contact: 'email',
        status: 'churned',
        notes: 'Moved out of the service area in the spring.',
        created_by_user_id: nina.id,
      },
      {
        branch_id: halifax.id,
        first_name: 'Sam',
        last_name: 'Toussaint',
        email: 'sam.toussaint@example.test',
        phone: '902-555-0204',
        preferred_contact: 'both',
        status: 'active',
        created_by_user_id: halifaxManager.id,
      },
    ])
    .returning(['id', 'first_name']);

  const customerBy = (firstName: string) => {
    const found = customers.find((c) => c.first_name === firstName);
    if (!found) throw new Error(`Customer seed failed: ${firstName}`);
    return found;
  };

  await knex('properties').insert([
    {
      customer_id: customerBy('Harold').id,
      address_line1: '212 Johnson St',
      city: 'Kingston',
      province: 'ON',
      postal_code: 'K7L 1Y4',
      latitude: '44.230500',
      longitude: '-76.494400',
      driveway_size_cars: 2,
      access_notes: 'Pile snow on the left side. Dog in the yard until 8am.',
      priority_flag: true,
    },
    {
      customer_id: customerBy('Harold').id,
      address_line1: '9 Barrie St',
      address_line2: 'Rear lot',
      city: 'Kingston',
      province: 'ON',
      postal_code: 'K7L 3J7',
      driveway_size_cars: 4,
      priority_flag: false,
    },
    {
      customer_id: customerBy('Priya').id,
      address_line1: '1140 Princess St',
      city: 'Kingston',
      province: 'ON',
      postal_code: 'K7M 3E1',
      latitude: '44.246800',
      longitude: '-76.526900',
      driveway_size_cars: 6,
      access_notes: 'Gate code 4417.',
      priority_flag: false,
    },
    {
      customer_id: customerBy('Doug').id,
      address_line1: '47 Country Club Dr',
      city: 'Kingston',
      province: 'ON',
      postal_code: 'K7M 7X4',
      driveway_size_cars: 3,
      priority_flag: false,
    },
    {
      customer_id: customerBy('Sam').id,
      address_line1: '5560 Cornwallis St',
      city: 'Halifax',
      province: 'NS',
      postal_code: 'B3K 1B1',
      driveway_size_cars: 1,
      priority_flag: true,
    },
  ]);
}
