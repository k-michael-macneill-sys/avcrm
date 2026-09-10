import type { Knex } from 'knex';
import { config } from '../../config';
import { hashPassword } from '../../services/auth';
import { addDays } from '../../services/operators';

/** Mid November to mid April, the season both branches sell. */
const SEASON_MONTHS = 5;

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

  // audit_log is append-only, and its trigger blocks DELETE. TRUNCATE does not
  // fire row triggers, which is exactly what a dev reset needs.
  await knex.raw('truncate table audit_log');
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

  const properties = await knex('properties')
    .insert([
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
    ])
    .returning(['id', 'address_line1']);

  const propertyBy = (addressLine1: string) => {
    const found = properties.find((p) => p.address_line1 === addressLine1);
    if (!found) throw new Error(`Property seed failed: ${addressLine1}`);
    return found;
  };

  // --- Checklist config ---------------------------------------------------
  // Order and wording match what the rep sees on the signature screen. Only
  // the required three block a submission; card_on_file is optional because a
  // seasonal customer may pay upfront by cheque.
  await knex('checklist_requirements').insert([
    { code: 'card_on_file', label: 'Card on file', is_required: false, sort_order: 1 },
    {
      code: 'terms_reviewed',
      label: 'Terms and conditions reviewed',
      is_required: true,
      sort_order: 2,
    },
    {
      code: 'service_window_explained',
      label: 'Service window explained',
      is_required: true,
      sort_order: 3,
    },
    {
      code: 'access_notes_captured',
      label: 'Access notes captured',
      is_required: false,
      sort_order: 4,
    },
    {
      code: 'photos_taken',
      label: 'Property photos taken',
      is_required: false,
      sort_order: 5,
    },
    {
      code: 'contact_confirmed',
      label: 'Contact details confirmed',
      is_required: true,
      sort_order: 6,
    },
  ]);

  // --- Pricing guide ------------------------------------------------------
  // One rate card per branch, indexed by driveway size 1-6. The seasonal
  // upfront price is the five month total less a tenth for paying at once.
  const RATE_CARDS: { branchId: string; monthly: number[] }[] = [
    { branchId: kingston.id, monthly: [89, 109, 129, 159, 189, 229] },
    { branchId: halifax.id, monthly: [99, 119, 145, 175, 209, 249] },
  ];

  await knex('pricing_guide').insert(
    RATE_CARDS.flatMap(({ branchId, monthly }) =>
      monthly.flatMap((rate, index) => [
        {
          branch_id: branchId,
          driveway_size_cars: index + 1,
          billing_type: 'monthly' as const,
          initial_price: rate.toFixed(2),
        },
        {
          branch_id: branchId,
          driveway_size_cars: index + 1,
          billing_type: 'seasonal_upfront' as const,
          initial_price: (rate * SEASON_MONTHS * 0.9).toFixed(2),
        },
      ]),
    ),
  );

  // --- Quotes -------------------------------------------------------------
  // The season the branches are currently selling: mid November to mid April.
  const seasonYear = Number(today.slice(0, 4));
  const season = {
    season_start: `${seasonYear}-11-15`,
    season_end: `${seasonYear + 1}-04-15`,
  };

  const quotes = await knex('quotes')
    .insert([
      {
        // Signed below.
        property_id: propertyBy('212 Johnson St').id,
        created_by_user_id: otto.id,
        billing_type: 'monthly',
        initial_price: '109.00',
        discounted_price: '99.00',
        ...season,
        status: 'accepted',
        notes: 'Ten off for signing at the door.',
      },
      {
        // Signed below.
        property_id: propertyBy('1140 Princess St').id,
        created_by_user_id: nina.id,
        billing_type: 'seasonal_upfront',
        initial_price: '1030.50',
        discounted_price: '975.00',
        ...season,
        status: 'accepted',
      },
      {
        // Still being written up.
        property_id: propertyBy('47 Country Club Dr').id,
        created_by_user_id: otto.id,
        billing_type: 'monthly',
        initial_price: '129.00',
        discounted_price: '129.00',
        ...season,
        status: 'draft',
      },
      {
        // A lost deal, kept for the win rate in build step 7.
        property_id: propertyBy('9 Barrie St').id,
        created_by_user_id: nina.id,
        billing_type: 'monthly',
        initial_price: '159.00',
        discounted_price: '149.00',
        ...season,
        status: 'declined',
        notes: 'Going with the neighbour who does it with a plough truck.',
      },
      {
        // Signed below.
        property_id: propertyBy('5560 Cornwallis St').id,
        created_by_user_id: halifaxManager.id,
        billing_type: 'seasonal_upfront',
        initial_price: '445.50',
        discounted_price: '425.00',
        ...season,
        status: 'accepted',
      },
    ])
    .returning(['id', 'property_id']);

  const quoteFor = (propertyId: string) => {
    const found = quotes.find((q) => q.property_id === propertyId);
    if (!found) throw new Error('Quote seed failed');
    return found;
  };

  // --- Contracts ----------------------------------------------------------
  const signedAt = new Date();

  const contracts = await knex('contracts')
    .insert([
      {
        quote_id: quoteFor(propertyBy('212 Johnson St').id).id,
        customer_id: customerBy('Harold').id,
        property_id: propertyBy('212 Johnson St').id,
        signature_image_url: 'private/signatures/harold-bell.png',
        signed_at: signedAt,
        signed_ip: '198.51.100.24',
        signed_lat: '44.230500',
        signed_lng: '-76.494400',
        terms_version: '2026-09-01',
        // A processor token, never card data. last4 and brand are display only.
        payment_method_token: 'tok_seed_harold_bell',
        payment_method_last4: '4242',
        payment_method_brand: 'visa',
        status: 'active',
      },
      {
        quote_id: quoteFor(propertyBy('1140 Princess St').id).id,
        customer_id: customerBy('Priya').id,
        property_id: propertyBy('1140 Princess St').id,
        signature_image_url: 'private/signatures/priya-raman.png',
        signed_at: signedAt,
        signed_ip: '198.51.100.31',
        terms_version: '2026-09-01',
        payment_method_token: 'tok_seed_priya_raman',
        payment_method_last4: '1881',
        payment_method_brand: 'mastercard',
        status: 'active',
      },
      {
        // Paid upfront by cheque, so there is no card on file.
        quote_id: quoteFor(propertyBy('5560 Cornwallis St').id).id,
        customer_id: customerBy('Sam').id,
        property_id: propertyBy('5560 Cornwallis St').id,
        signature_image_url: 'private/signatures/sam-toussaint.png',
        signed_at: signedAt,
        signed_ip: '203.0.113.9',
        terms_version: '2026-09-01',
        status: 'active',
      },
    ])
    .returning(['id', 'property_id']);

  const contractFor = (propertyId: string) => {
    const found = contracts.find((c) => c.property_id === propertyId);
    if (!found) throw new Error('Contract seed failed');
    return found;
  };

  const harold = contractFor(propertyBy('212 Johnson St').id);
  const priya = contractFor(propertyBy('1140 Princess St').id);
  const sam = contractFor(propertyBy('5560 Cornwallis St').id);

  // Every contract carries a row per checklist item, ticked or not, so the
  // record shows what the rep did not do as well as what they did.
  const checklistRow = (contractId: string, itemCode: string, checked: boolean) => ({
    contract_id: contractId,
    item_code: itemCode,
    checked,
    checked_at: checked ? signedAt : null,
  });

  await knex('contract_checklist_items').insert([
    checklistRow(harold.id, 'card_on_file', true),
    checklistRow(harold.id, 'terms_reviewed', true),
    checklistRow(harold.id, 'service_window_explained', true),
    checklistRow(harold.id, 'access_notes_captured', true),
    checklistRow(harold.id, 'photos_taken', false),
    checklistRow(harold.id, 'contact_confirmed', true),

    checklistRow(priya.id, 'card_on_file', true),
    checklistRow(priya.id, 'terms_reviewed', true),
    checklistRow(priya.id, 'service_window_explained', true),
    checklistRow(priya.id, 'access_notes_captured', true),
    checklistRow(priya.id, 'photos_taken', false),
    checklistRow(priya.id, 'contact_confirmed', true),

    checklistRow(sam.id, 'card_on_file', false),
    checklistRow(sam.id, 'terms_reviewed', true),
    checklistRow(sam.id, 'service_window_explained', true),
    checklistRow(sam.id, 'access_notes_captured', false),
    checklistRow(sam.id, 'photos_taken', false),
    checklistRow(sam.id, 'contact_confirmed', true),
  ]);

  // --- Work orders --------------------------------------------------------
  // A spread across the status range, so the dispatch board, an operator's run
  // sheet and the completion gate all have something real to show.
  const now = Date.now();
  const hours = (n: number) => new Date(now + n * 3_600_000);

  const workOrders = await knex('work_orders')
    .insert([
      {
        // Done yesterday, with the before and after photos that let it close.
        contract_id: harold.id,
        property_id: propertyBy('212 Johnson St').id,
        branch_id: kingston.id,
        assigned_user_id: otto.id,
        scheduled_for: hours(-26),
        service_type: 'snow_clearing',
        status: 'completed',
        started_at: hours(-25.5),
        completed_at: hours(-25),
        operator_notes: 'Cleared to the garage door, salted the step.',
      },
      {
        // On the board for tomorrow morning.
        contract_id: harold.id,
        property_id: propertyBy('212 Johnson St').id,
        branch_id: kingston.id,
        assigned_user_id: nina.id,
        scheduled_for: hours(20),
        service_type: 'salting',
        status: 'scheduled',
      },
      {
        // The reason skip_reason is not nullable when skipped.
        contract_id: harold.id,
        property_id: propertyBy('212 Johnson St').id,
        branch_id: kingston.id,
        assigned_user_id: otto.id,
        scheduled_for: hours(-50),
        service_type: 'snow_clearing',
        status: 'skipped',
        skip_reason: 'Car parked across the driveway, nobody answered the door.',
      },
      {
        // Halifax has no approved operator yet, so this one is unassigned.
        // That is the state the branch is actually in, per the seeded vault.
        contract_id: sam.id,
        property_id: propertyBy('5560 Cornwallis St').id,
        branch_id: halifax.id,
        assigned_user_id: null,
        scheduled_for: hours(6),
        service_type: 'snow_clearing',
        status: 'scheduled',
      },
      {
        // Finished a day and a bit ago and nobody has been asked about it yet.
        // This is what `npm run job:review-requests` picks up on a fresh seed.
        contract_id: priya.id,
        property_id: propertyBy('1140 Princess St').id,
        branch_id: kingston.id,
        assigned_user_id: nina.id,
        scheduled_for: hours(-31),
        service_type: 'snow_clearing',
        status: 'completed',
        started_at: hours(-30.5),
        completed_at: hours(-30),
      },
      {
        // Finished three days ago, and the customer has already rated it —
        // poorly, which is what puts it on the branch manager's list.
        contract_id: sam.id,
        property_id: propertyBy('5560 Cornwallis St').id,
        branch_id: halifax.id,
        assigned_user_id: halifaxManager.id,
        scheduled_for: hours(-74),
        service_type: 'salting',
        status: 'completed',
        started_at: hours(-73),
        completed_at: hours(-72),
      },
    ])
    .returning(['id', 'status', 'branch_id', 'service_type', 'property_id']);

  const completedVisit = workOrders.find(
    (w) => w.status === 'completed' && w.service_type === 'snow_clearing' &&
      w.branch_id === kingston.id && w.property_id === propertyBy('212 Johnson St').id,
  );
  const unaskedVisit = workOrders.find(
    (w) => w.status === 'completed' && w.property_id === propertyBy('1140 Princess St').id,
  );
  const ratedVisit = workOrders.find(
    (w) => w.status === 'completed' && w.branch_id === halifax.id,
  );
  if (!completedVisit || !unaskedVisit || !ratedVisit) {
    throw new Error('Work order seed failed');
  }

  // Geotagged on the property itself, which is what the upload check compares
  // against. taken_at is when the driveway was cleared, not when the file
  // arrived.
  await knex('service_photos').insert([
    {
      work_order_id: completedVisit.id,
      photo_type: 'before',
      file_url: 'private/service-photos/212-johnson-before.jpg',
      taken_at: hours(-25.5),
      latitude: '44.230500',
      longitude: '-76.494400',
      uploaded_by_user_id: otto.id,
    },
    {
      work_order_id: completedVisit.id,
      photo_type: 'after',
      file_url: 'private/service-photos/212-johnson-after.jpg',
      taken_at: hours(-25),
      latitude: '44.230500',
      longitude: '-76.494400',
      uploaded_by_user_id: otto.id,
    },
    {
      work_order_id: unaskedVisit.id,
      photo_type: 'before',
      file_url: 'private/service-photos/1140-princess-before.jpg',
      taken_at: hours(-30.5),
      latitude: '44.246800',
      longitude: '-76.526900',
      uploaded_by_user_id: nina.id,
    },
    {
      work_order_id: unaskedVisit.id,
      photo_type: 'after',
      file_url: 'private/service-photos/1140-princess-after.jpg',
      taken_at: hours(-30),
      latitude: '44.246800',
      longitude: '-76.526900',
      uploaded_by_user_id: nina.id,
    },
    // The Halifax address has no coordinates on file, so neither do its
    // photos: the geotag check only runs when both sides have them.
    {
      work_order_id: ratedVisit.id,
      photo_type: 'before',
      file_url: 'private/service-photos/5560-cornwallis-before.jpg',
      taken_at: hours(-73),
      uploaded_by_user_id: halifaxManager.id,
    },
    {
      work_order_id: ratedVisit.id,
      photo_type: 'after',
      file_url: 'private/service-photos/5560-cornwallis-after.jpg',
      taken_at: hours(-72),
      uploaded_by_user_id: halifaxManager.id,
    },
  ]);

  // --- Message templates --------------------------------------------------
  // Seeded config. A row with a branch_id overrides the global one for the
  // same code and channel, which is how a branch rewords a message without a
  // deploy — see the Halifax override at the end of this block.
  await knex('message_templates').insert([
    {
      code: 'service_complete',
      channel: 'email',
      branch_id: null,
      subject: '{{address_line1}} — {{service_type}} complete',
      body:
        'Hi {{customer_first_name}},\n\n' +
        '{{service_type}} at {{address_line1}}, {{city}} was completed at ' +
        '{{completed_at}}.\nOperator: {{operator_name}}\n\nPhotos:\n{{photo_list}}',
    },
    {
      // The office copy. A branch manager reading "Hi Harold, your driveway is
      // clear" is not a notification.
      code: 'service_complete_internal',
      channel: 'email',
      branch_id: null,
      subject: '[{{branch_name}}] {{address_line1}} — {{service_type}} complete',
      body:
        '{{service_type}} at {{address_line1}}, {{city}} was completed at ' +
        '{{completed_at}} by {{operator_name}}.\n\nPhotos:\n{{photo_list}}',
    },
    {
      code: 'en_route',
      channel: 'email',
      branch_id: null,
      subject: 'On the way to {{address_line1}}',
      body:
        'Hi {{customer_first_name}}, {{operator_name}} is on the way to ' +
        '{{address_line1}} now.',
    },
    {
      code: 'en_route',
      channel: 'sms',
      branch_id: null,
      subject: null,
      body: '{{operator_name}} is on the way to {{address_line1}} now.',
    },
    {
      code: 'review_request',
      channel: 'email',
      branch_id: null,
      subject: 'How did we do at {{address_line1}}?',
      body:
        'Hi {{customer_first_name}},\n\nHow did we do? One tap, no form:\n\n' +
        '1 star  {{rating_url_1}}\n2 stars {{rating_url_2}}\n' +
        '3 stars {{rating_url_3}}\n4 stars {{rating_url_4}}\n' +
        '5 stars {{rating_url_5}}\n\n— {{branch_name}}',
    },
    {
      code: 'review_request',
      channel: 'sms',
      branch_id: null,
      subject: null,
      body:
        'How did we do at {{address_line1}}? Tap to rate: ' +
        '1 {{rating_url_1}} 3 {{rating_url_3}} 5 {{rating_url_5}}',
    },
    {
      // The alert that makes the gate worth having: a poor rating reaches a
      // person instead of a public star.
      code: 'low_rating_internal',
      channel: 'email',
      branch_id: null,
      subject: '[{{branch_name}}] {{rating}}-star rating from {{customer_name}}',
      body:
        '{{customer_name}} rated a recent visit {{rating}} out of 5.\n\n' +
        'Email: {{customer_email}}\nPhone: {{customer_phone}}\n\n' +
        'Call them before they tell everyone else.',
    },
    {
      code: 'payment_failed',
      channel: 'email',
      branch_id: null,
      subject: 'We could not process your payment',
      body:
        'Hi {{customer_first_name}}, the card on file for {{address_line1}} was ' +
        'declined for {{amount}}. Service continues — please update your card ' +
        'when you get a moment.',
    },
    {
      code: 'renewal_reminder',
      channel: 'email',
      branch_id: null,
      subject: 'Your {{address_line1}} snow contract is up for renewal',
      body:
        'Hi {{customer_first_name}}, your season at {{address_line1}} ends on ' +
        '{{season_end}}. Reply and we will get next winter booked in.',
    },
    {
      code: 'document_expiring',
      channel: 'email',
      branch_id: null,
      subject: '{{label}} expires in {{days_left}} {{day_word}}',
      body:
        'Hi {{first_name}}, your {{label}} expires on {{expires_on}}.' +
        '{{required_note}} Please upload a current copy before then.',
    },
    {
      code: 'document_expiring_internal',
      channel: 'email',
      branch_id: null,
      subject: '[{{branch_name}}] {{operator_name}}: {{label}} expires in {{days_left}} {{day_word}}',
      body:
        '{{operator_name}} at {{branch_name}} has a {{label}} expiring on ' +
        '{{expires_on}}.',
    },
    {
      code: 'operator_suspended',
      channel: 'email',
      branch_id: null,
      subject: 'Your account has been suspended',
      body:
        'Hi {{first_name}}, a required document has expired, so you cannot be ' +
        'assigned work until it is replaced and approved. Please upload a ' +
        'current copy as soon as you can.',
    },
    {
      code: 'operator_suspended_internal',
      channel: 'email',
      branch_id: null,
      subject: '[{{branch_name}}] Operator suspended: {{operator_name}}',
      body:
        '{{operator_name}} has been suspended automatically because a required ' +
        'document expired. They are out of the assignable pool until it is ' +
        'replaced.',
    },
    {
      // A branch override, to show the mechanism works. Halifax signs off
      // differently; everything else falls back to the global rows above.
      code: 'service_complete',
      channel: 'email',
      branch_id: halifax.id,
      subject: '{{address_line1}} is clear',
      body:
        'Hi {{customer_first_name}},\n\nWe finished {{service_type}} at ' +
        '{{address_line1}} at {{completed_at}}. {{operator_name}} looked after ' +
        'it.\n\nPhotos:\n{{photo_list}}\n\nThanks for choosing us.\n' +
        '— The {{branch_name}} crew',
    },
  ]);

  // --- Message log --------------------------------------------------------
  // What the queue would have delivered for the completed Kingston visit.
  await knex('message_log').insert([
    {
      branch_id: kingston.id,
      customer_id: customerBy('Harold').id,
      work_order_id: completedVisit.id,
      template_code: 'service_complete',
      channel: 'email',
      recipient: 'harold.bell@example.test',
      subject: '212 Johnson St — snow clearing complete',
      body:
        'Hi Harold,\n\nsnow clearing at 212 Johnson St, Kingston was completed ' +
        'at ' + hours(-25).toISOString() + '.\nOperator: Otto Plows',
      status: 'sent',
      sent_at: hours(-25),
      provider_message_id: 'mock-email-seed-harold',
      attempts: 1,
      last_attempt_at: hours(-25),
    },
    {
      branch_id: kingston.id,
      customer_id: customerBy('Harold').id,
      work_order_id: completedVisit.id,
      template_code: 'service_complete_internal',
      channel: 'email',
      recipient: 'kingston.manager@avcrm.test',
      subject: '[Kingston] 212 Johnson St — snow clearing complete',
      body:
        'snow clearing at 212 Johnson St, Kingston was completed at ' +
        hours(-25).toISOString() + ' by Otto Plows.',
      status: 'sent',
      sent_at: hours(-25),
      provider_message_id: 'mock-email-seed-manager',
      attempts: 1,
      last_attempt_at: hours(-25),
    },
  ]);

  // --- Review requests ----------------------------------------------------
  // One of each answer, so both branches of the gate have something to show.
  // Priya's visit is deliberately left unasked: that is what
  // `npm run job:review-requests` picks up on a fresh seed.
  await knex('review_requests').insert([
    {
      // Five stars: routed to the public review page.
      customer_id: customerBy('Harold').id,
      work_order_id: completedVisit.id,
      branch_id: kingston.id,
      channel: 'email',
      sent_at: hours(-24),
      rating_response: 5,
      routed_to: 'google_review',
      completed_at: hours(-23),
    },
    {
      // Two stars: kept in house, and the branch manager was told.
      customer_id: customerBy('Sam').id,
      work_order_id: ratedVisit.id,
      branch_id: halifax.id,
      channel: 'email',
      sent_at: hours(-48),
      rating_response: 2,
      routed_to: 'internal_feedback',
      completed_at: hours(-47),
    },
  ]);

  // --- Audit log ----------------------------------------------------------
  // The trail the API would have written for the two signatures above. The
  // payment token is deliberately absent: last4 and brand are all the log
  // ever needs.
  await knex('audit_log').insert([
    {
      user_id: otto.id,
      action: 'contract.created',
      entity_type: 'contract',
      entity_id: harold.id,
      after_json: JSON.stringify({
        status: 'active',
        terms_version: '2026-09-01',
        payment_method_last4: '4242',
        payment_method_brand: 'visa',
      }),
      ip_address: '198.51.100.24',
    },
    {
      user_id: halifaxManager.id,
      action: 'contract.created',
      entity_type: 'contract',
      entity_id: sam.id,
      after_json: JSON.stringify({ status: 'active', terms_version: '2026-09-01' }),
      ip_address: '203.0.113.9',
    },
  ]);
}
