import { db } from './database';
import { hashPassword } from '../../src/services/auth';
import {
  MESSAGE_CHANNELS,
  TEMPLATE_CODES,
  type BillingType,
  type PreferredContact,
  type MessageChannel,
  type QuoteStatus,
  type ServiceType,
  type TemplateCode,
  type WorkOrderStatus,
} from '../../src/types/models';

/**
 * The smallest world a test can stand on: two branches, the people who work
 * in them, and the config rows the application treats as given.
 *
 * Built by insert rather than through the API. A test about the completion
 * gate should fail because the gate is wrong, not because signing a contract
 * six calls earlier changed shape — so only the thing under test goes through
 * HTTP, and everything it needs to exist simply exists.
 */

export const PASSWORD = 'Password123!';

export interface World {
  branches: { kingston: string; halifax: string };
  users: {
    corporate: string;
    kingstonManager: string;
    operator: string;
    halifaxOperator: string;
    pending: string;
  };
  emails: {
    corporate: string;
    kingstonManager: string;
    operator: string;
    halifaxOperator: string;
    pending: string;
  };
}

/** One hash for the whole run: bcrypt is deliberately slow. */
let cachedHash: string | null = null;
async function password(): Promise<string> {
  cachedHash ??= await hashPassword(PASSWORD);
  return cachedHash;
}

export async function buildWorld(): Promise<World> {
  const branches = await db('branches')
    .insert([
      { name: 'Kingston', province: 'ON', timezone: 'America/Toronto' },
      { name: 'Halifax', province: 'NS', timezone: 'America/Halifax' },
    ])
    .returning(['id', 'name']);

  const kingston = branches.find((b) => b.name === 'Kingston')?.id ?? '';
  const halifax = branches.find((b) => b.name === 'Halifax')?.id ?? '';

  const password_hash = await password();
  const users = await db('users')
    .insert([
      {
        email: 'corporate@test.local',
        password_hash,
        first_name: 'Ada',
        last_name: 'Corporate',
        role: 'corporate',
        branch_id: null,
        onboarding_status: 'approved',
      },
      {
        email: 'kingston.manager@test.local',
        password_hash,
        first_name: 'Marty',
        last_name: 'Manager',
        role: 'corporate',
        branch_id: kingston,
        onboarding_status: 'approved',
      },
      {
        email: 'otto@test.local',
        password_hash,
        first_name: 'Otto',
        last_name: 'Plows',
        role: 'operator',
        branch_id: kingston,
        onboarding_status: 'approved',
      },
      {
        email: 'hana@test.local',
        password_hash,
        first_name: 'Hana',
        last_name: 'Harbour',
        role: 'operator',
        branch_id: halifax,
        onboarding_status: 'approved',
      },
      {
        // Not through onboarding: the one who must not be dispatchable.
        email: 'pat@test.local',
        password_hash,
        first_name: 'Pat',
        last_name: 'Pending',
        role: 'operator',
        branch_id: kingston,
        onboarding_status: 'pending',
      },
    ])
    .returning(['id', 'email']);

  const idFor = (email: string) => users.find((u) => u.email === email)?.id ?? '';

  await db('branches')
    .where({ id: kingston })
    .update({ manager_user_id: idFor('kingston.manager@test.local') });

  await seedConfig(kingston, halifax);

  return {
    branches: { kingston, halifax },
    users: {
      corporate: idFor('corporate@test.local'),
      kingstonManager: idFor('kingston.manager@test.local'),
      operator: idFor('otto@test.local'),
      halifaxOperator: idFor('hana@test.local'),
      pending: idFor('pat@test.local'),
    },
    emails: {
      corporate: 'corporate@test.local',
      kingstonManager: 'kingston.manager@test.local',
      operator: 'otto@test.local',
      halifaxOperator: 'hana@test.local',
      pending: 'pat@test.local',
    },
  };
}

/**
 * The rows the application reads as configuration rather than data.
 *
 * Templates are generated from TEMPLATE_CODES rather than listed, so a code
 * added to the application arrives here with it — a test suite that has to be
 * edited every time a message is added stops being run.
 */
async function seedConfig(kingston: string, halifax: string): Promise<void> {
  await db('checklist_requirements').insert([
    { code: 'card_on_file', label: 'Card on file', is_required: false, sort_order: 1 },
    { code: 'terms_reviewed', label: 'Terms reviewed', is_required: true, sort_order: 2 },
    {
      code: 'service_window_explained',
      label: 'Service window explained',
      is_required: true,
      sort_order: 3,
    },
  ]);

  await db('document_requirements').insert([
    {
      code: 'drivers_license',
      label: "Driver's licence",
      province: null,
      is_required: true,
      expires: true,
      default_validity_days: 365,
    },
    {
      code: 'wsib_clearance',
      label: 'WSIB clearance',
      province: 'ON',
      is_required: true,
      expires: true,
      default_validity_days: 365,
    },
  ]);

  await db('pricing_guide').insert(
    [kingston, halifax].flatMap((branch_id) =>
      [1, 2, 3, 4].flatMap((cars) => [
        {
          branch_id,
          driveway_size_cars: cars,
          billing_type: 'monthly' as const,
          initial_price: (79 + cars * 20).toFixed(2),
        },
        {
          branch_id,
          driveway_size_cars: cars,
          billing_type: 'seasonal_upfront' as const,
          initial_price: ((79 + cars * 20) * 5 * 0.9).toFixed(2),
        },
      ]),
    ),
  );

  await db('message_templates').insert(
    TEMPLATE_CODES.flatMap((code) =>
      MESSAGE_CHANNELS.map((channel) => ({
        code,
        channel,
        branch_id: null,
        subject: channel === 'email' ? `${code} for {{address_line1}}` : null,
        // Every placeholder the renderer might be handed is not knowable here,
        // and an unknown one is the renderer's business to complain about —
        // these carry the two that every context provides.
        body: `${code}: {{customer_first_name}} at {{address_line1}}`,
      })),
    ),
  );
}

export interface CustomerFixture {
  customer_id: string;
  property_id: string;
}

export async function makeCustomer(
  branchId: string,
  createdBy: string,
  overrides: Partial<{
    first_name: string;
    last_name: string;
    email: string | null;
    phone: string | null;
    preferred_contact: PreferredContact;
    address_line1: string;
    driveway_size_cars: number;
    priority_flag: boolean;
    latitude: string | null;
    longitude: string | null;
  }> = {},
): Promise<CustomerFixture> {
  const [customer] = await db('customers')
    .insert({
      branch_id: branchId,
      first_name: overrides.first_name ?? 'Harold',
      last_name: overrides.last_name ?? 'Bell',
      email: overrides.email === undefined ? 'harold@example.test' : overrides.email,
      phone: overrides.phone === undefined ? '613-555-0201' : overrides.phone,
      preferred_contact: overrides.preferred_contact ?? 'both',
      status: 'active',
      created_by_user_id: createdBy,
    })
    .returning('id');

  const [property] = await db('properties')
    .insert({
      customer_id: customer?.id ?? '',
      address_line1: overrides.address_line1 ?? '212 Johnson St',
      city: 'Kingston',
      province: 'ON',
      postal_code: 'K7L 1Y4',
      latitude: overrides.latitude === undefined ? '44.230500' : overrides.latitude,
      longitude: overrides.longitude === undefined ? '-76.494400' : overrides.longitude,
      driveway_size_cars: overrides.driveway_size_cars ?? 2,
      priority_flag: overrides.priority_flag ?? false,
    })
    .returning('id');

  return { customer_id: customer?.id ?? '', property_id: property?.id ?? '' };
}

/** A season that is always in the future, so nothing expires mid-test. */
export function season(): { season_start: string; season_end: string } {
  const year = new Date().getUTCFullYear() + 1;
  return { season_start: `${year}-11-15`, season_end: `${year + 1}-04-15` };
}

export async function makeQuote(
  propertyId: string,
  createdBy: string,
  overrides: Partial<{
    billing_type: BillingType;
    initial_price: string;
    discounted_price: string;
    status: QuoteStatus;
  }> = {},
): Promise<string> {
  const [quote] = await db('quotes')
    .insert({
      property_id: propertyId,
      created_by_user_id: createdBy,
      billing_type: overrides.billing_type ?? 'monthly',
      initial_price: overrides.initial_price ?? '119.00',
      discounted_price: overrides.discounted_price ?? '109.00',
      ...season(),
      status: overrides.status ?? 'presented',
    })
    .returning('id');
  return quote?.id ?? '';
}

export interface ContractFixture extends CustomerFixture {
  quote_id: string;
  contract_id: string;
}

/**
 * A signed contract, inserted rather than posted.
 *
 * Tests about what happens *after* a signature — dispatch, billing, reports —
 * should not break when the signature screen changes, so they start from a
 * contract that simply exists.
 */
export async function makeContract(
  branchId: string,
  createdBy: string,
  overrides: Partial<{
    billing_type: BillingType;
    discounted_price: string;
    address_line1: string;
    first_name: string;
    email: string | null;
    phone: string | null;
    preferred_contact: PreferredContact;
    priority_flag: boolean;
    latitude: string | null;
    longitude: string | null;
    payment_method_token: string | null;
    payment_method_last4: string | null;
  }> = {},
): Promise<ContractFixture> {
  const made = await makeCustomer(branchId, createdBy, overrides);
  const quote = await makeQuote(made.property_id, createdBy, {
    status: 'accepted',
    billing_type: overrides.billing_type ?? 'monthly',
    discounted_price: overrides.discounted_price ?? '109.00',
  });

  const [contract] = await db('contracts')
    .insert({
      quote_id: quote,
      customer_id: made.customer_id,
      property_id: made.property_id,
      signature_image_url: 'signatures/2026/01/test.png',
      signed_at: new Date(),
      signed_ip: '198.51.100.7',
      terms_version: 'v1',
      status: 'active',
      payment_method_token: overrides.payment_method_token ?? null,
      payment_method_last4: overrides.payment_method_last4 ?? null,
      payment_method_brand: overrides.payment_method_last4 ? 'visa' : null,
    })
    .returning('id');

  const requirements = await db('checklist_requirements').select('code');
  await db('contract_checklist_items').insert(
    requirements.map((r) => {
      const checked =
        r.code === 'card_on_file' ? Boolean(overrides.payment_method_token) : true;
      // The table's own rule: a timestamp means it was ticked, and an
      // unticked box cannot carry one.
      return {
        contract_id: contract?.id ?? '',
        item_code: r.code,
        checked,
        checked_at: checked ? new Date() : null,
      };
    }),
  );

  return { ...made, quote_id: quote, contract_id: contract?.id ?? '' };
}

export async function makeWorkOrder(
  contract: ContractFixture,
  branchId: string,
  overrides: Partial<{
    assigned_user_id: string | null;
    status: WorkOrderStatus;
    service_type: ServiceType;
    scheduled_for: Date;
    completed_at: Date | null;
    started_at: Date | null;
  }> = {},
): Promise<string> {
  const [row] = await db('work_orders')
    .insert({
      contract_id: contract.contract_id,
      property_id: contract.property_id,
      branch_id: branchId,
      assigned_user_id: overrides.assigned_user_id ?? null,
      scheduled_for: overrides.scheduled_for ?? new Date(),
      service_type: overrides.service_type ?? 'snow_clearing',
      status: overrides.status ?? 'scheduled',
      // The table insists the timestamps agree with the status: a completed
      // visit was started, and a scheduled one was not.
      started_at:
        overrides.started_at
        ?? (overrides.status === 'in_progress' || overrides.status === 'completed'
          ? (overrides.completed_at ?? new Date())
          : null),
      completed_at: overrides.completed_at ?? null,
    })
    .returning('id');
  return row?.id ?? '';
}

/**
 * Rewords one template for a test.
 *
 * The generic templates carry the two placeholders every context provides.
 * A test that cares about a particular value — the card link, an amount —
 * sets the wording it needs rather than every template carrying every
 * placeholder and breaking the ones without it.
 */
export async function setTemplate(
  code: TemplateCode,
  channel: MessageChannel,
  body: string,
  subject: string | null = null,
): Promise<void> {
  await db('message_templates')
    .where({ code, channel })
    .whereNull('branch_id')
    .update({ body, subject });
}
