import type { Knex } from 'knex';

/**
 * The service agreement: the contract form, the agreement generated from it,
 * and the customer page built around both.
 *
 * Lookup tables. Everything the contract form offers as a choice — contract
 * types, billing plans, scope items, add-ons, tags, tax codes, routes — is a
 * row the office can relabel, reorder or switch off without a deploy. Where a
 * choice changes what the system does (a pay-in-full plan, the YIA tag, the
 * referral tag), the behaviour hangs off a fixed `kind` column, so the label
 * stays the office's to word.
 *
 * Quotes. The form writes a quote, as the door sign-up always has: the money
 * stays on the quote, signing still produces the contract, and every rule the
 * contract and billing code already enforce keeps holding. The new columns are
 * all nullable, and `billing_plan_id` being set is what marks a quote as a
 * service agreement rather than the older PDF sign-up.
 *
 * Contracts. A paper agreement is signed on paper and arrives as a scan, so
 * it is the one kind of contract with no drawn signature.
 *
 * Invoices carry their tax and any credit applied, so the amount due can be
 * explained line by line. Credits are a ledger: referral credit earned, and
 * credit spent against an invoice, one row each.
 *
 * Written out rather than imported: a migration is history.
 */

const LOOKUP_TABLES = [
  'contract_types',
  'billing_plans',
  'scope_items',
  'addon_services',
  'contract_tags',
  'tax_codes',
  'service_routes',
] as const;

const PLAN_KINDS = ['seasonal_installments', 'seasonal_yia', 'monthly_recurring', 'monthly_one_time'];
const TAG_KINDS = ['yia', 'route_code', 'referral'];
const PHONE_TYPES = ['mobile', 'home', 'work', 'other'];
const DRIVEWAY_WIDTHS = ['single', 'double', 'triple'];
const NOTE_KINDS = ['account', 'operator'];
const CREDIT_KINDS = ['referral', 'applied', 'adjustment'];

function lookupColumns(knex: Knex, table: Knex.CreateTableBuilder): void {
  table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
  table.text('code').notNullable().unique();
  table.text('label').notNullable();
  table.boolean('active').notNullable().defaultTo(true);
  table.integer('sort_order').notNullable().defaultTo(0);
  table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
  table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
}

const inList = (values: string[]): string => values.map((v) => `'${v}'`).join(', ');

const CONTRACT_TYPES = [
  ['seasonal_1_electronic', 'Seasonal Snow Removal – Monthly Billing 1 Season (Electronic Agreement)', 1, 'electronic', false],
  ['seasonal_1_paper', 'Seasonal Snow Removal – Monthly Billing 1 Season (Paper Agreement)', 1, 'paper', false],
  ['seasonal_2_electronic', 'Seasonal Snow Removal – Monthly Billing 2 Seasons (Electronic Agreement)', 2, 'electronic', false],
  ['seasonal_2_paper', 'Seasonal Snow Removal – Monthly Billing 2 Seasons (Paper Agreement)', 2, 'paper', false],
  ['switch_1_electronic', 'SWITCH OVER – Seasonal Snow Removal – Monthly Billing 1 Season (Electronic Agreement)', 1, 'electronic', true],
  ['switch_1_paper', 'SWITCH OVER – Seasonal Snow Removal – Monthly Billing 1 Season (Paper Agreement)', 1, 'paper', true],
  ['switch_2_electronic', 'SWITCH OVER – Seasonal Snow Removal – Monthly Billing 2 Seasons (Electronic Agreement)', 2, 'electronic', true],
  ['switch_2_paper', 'SWITCH OVER – Seasonal Snow Removal – Monthly Billing 2 Seasons (Paper Agreement)', 2, 'paper', true],
] as const;

/** [code, label, kind, installments per season, early termination fee] */
const BILLING_PLANS = [
  ['seasonal_monthly', '1-yr Seasonal (Monthly)', 'seasonal_installments', 5, '75.00'],
  ['seasonal_yia', '1-yr Seasonal (YIA – Paid in Full)', 'seasonal_yia', 5, '0.00'],
  ['monthly_recurring', 'Monthly (Recurring)', 'monthly_recurring', 1, '0.00'],
  ['monthly_one_time', 'Monthly (One-time)', 'monthly_one_time', 1, '0.00'],
] as const;

const SCOPE_ITEMS = [
  ['driveway', 'Driveway clearing'],
  ['front_walkway', 'Front walkway / path to door'],
  ['front_steps', 'Front steps & porch'],
  ['municipal_sidewalk', 'Municipal sidewalk frontage'],
  ['windrow', 'End-of-driveway windrow clearing (city plow bank)'],
  ['side_back_path', 'Side / back door path'],
  ['garage_apron', 'Garage apron'],
  ['salt_driveway', 'Salting / de-icing: driveway'],
  ['salt_walkways', 'Salting / de-icing: walkways & steps'],
  ['mailbox_hydrant', 'Mailbox & fire hydrant access clearing'],
] as const;

const ADDON_SERVICES = [
  ['roof_raking', 'Roof raking'],
  ['ice_dam_removal', 'Ice dam removal'],
  ['snow_hauling', 'Snow hauling / relocation'],
  ['vehicle_brush_off', 'Vehicle brush-off'],
  ['window_cleaning', 'Window cleaning'],
] as const;

const CONTRACT_TAGS = [
  ['yia', 'YIA', 'yia'],
  ['route_code_added', 'Route Code Added', 'route_code'],
  ['referral_customer', 'Referral Customer', 'referral'],
] as const;

/**
 * [code, label, rate, province, default for the province]. Combined rates.
 * Which of them applies to snow removal in a given province is the office's
 * call — each is a row it can switch off or make the default.
 */
const TAX_CODES = [
  ['ON_HST', 'ON – 13% HST', '0.1300', 'ON', true],
  ['NS_HST', 'NS – 14% HST', '0.1400', 'NS', true],
  ['NB_HST', 'NB – 15% HST', '0.1500', 'NB', true],
  ['NL_HST', 'NL – 15% HST', '0.1500', 'NL', true],
  ['PE_HST', 'PE – 15% HST', '0.1500', 'PE', true],
  ['BC_GST', 'BC – 5% GST', '0.0500', 'BC', true],
  ['BC_GST_PST', 'BC – 5% GST + 7% PST', '0.1200', 'BC', false],
  ['AB_GST', 'AB – 5% GST', '0.0500', 'AB', true],
  ['SK_GST_PST', 'SK – 5% GST + 6% PST', '0.1100', 'SK', true],
  ['SK_GST', 'SK – 5% GST', '0.0500', 'SK', false],
  ['MB_GST_RST', 'MB – 5% GST + 7% RST', '0.1200', 'MB', true],
  ['MB_GST', 'MB – 5% GST', '0.0500', 'MB', false],
  ['QC_GST_QST', 'QC – 5% GST + 9.975% QST', '0.1498', 'QC', true],
  ['YT_GST', 'YT – 5% GST', '0.0500', 'YT', true],
  ['NT_GST', 'NT – 5% GST', '0.0500', 'NT', true],
  ['NU_GST', 'NU – 5% GST', '0.0500', 'NU', true],
  ['EXEMPT', 'Tax exempt – 0%', '0.0000', null, false],
] as const;

export async function up(knex: Knex): Promise<void> {
  // ── Lookups ───────────────────────────────────────────────────────────
  await knex.schema.createTable('contract_types', (table) => {
    lookupColumns(knex, table);
    table.integer('seasons').notNullable().defaultTo(1);
    table.text('agreement_medium').notNullable().defaultTo('electronic');
    table.boolean('is_switch_over').notNullable().defaultTo(false);
  });
  await knex.raw(`
    alter table contract_types add constraint contract_types_seasons_check check (seasons between 1 and 5)
  `);
  await knex.raw(`
    alter table contract_types add constraint contract_types_medium_check
      check (agreement_medium in ('electronic', 'paper'))
  `);

  await knex.schema.createTable('billing_plans', (table) => {
    lookupColumns(knex, table);
    table.text('kind').notNullable();
    table.integer('installments_per_season').notNullable().defaultTo(5);
    table.decimal('early_termination_fee', 10, 2).notNullable().defaultTo('0');
  });
  await knex.raw(`
    alter table billing_plans add constraint billing_plans_kind_check check (kind in (${inList(PLAN_KINDS)}))
  `);
  await knex.raw(`
    alter table billing_plans add constraint billing_plans_installments_check
      check (installments_per_season between 1 and 12)
  `);
  await knex.raw(`
    alter table billing_plans add constraint billing_plans_fee_check check (early_termination_fee >= 0)
  `);

  await knex.schema.createTable('scope_items', (table) => {
    lookupColumns(knex, table);
  });

  await knex.schema.createTable('addon_services', (table) => {
    lookupColumns(knex, table);
    // What the form pre-fills; the rep can change it per contract.
    table.decimal('default_price', 10, 2).nullable();
  });
  await knex.raw(`
    alter table addon_services add constraint addon_services_price_check
      check (default_price is null or default_price >= 0)
  `);

  await knex.schema.createTable('contract_tags', (table) => {
    lookupColumns(knex, table);
    table.text('kind').nullable();
  });
  await knex.raw(`
    alter table contract_tags add constraint contract_tags_kind_check
      check (kind is null or kind in (${inList(TAG_KINDS)}))
  `);
  // One tag per behaviour, or the form would not know which box YIA is.
  await knex.raw(`create unique index contract_tags_kind_unique on contract_tags (kind) where kind is not null`);

  await knex.schema.createTable('tax_codes', (table) => {
    lookupColumns(knex, table);
    table.decimal('rate', 6, 4).notNullable();
    table.text('province').nullable();
    table.boolean('is_default').notNullable().defaultTo(false);
  });
  await knex.raw(`alter table tax_codes add constraint tax_codes_rate_check check (rate >= 0 and rate < 1)`);
  await knex.raw(`
    create unique index tax_codes_one_default_per_province on tax_codes (province)
      where is_default and province is not null
  `);

  await knex.schema.createTable('service_routes', (table) => {
    lookupColumns(knex, table);
    table.uuid('branch_id').nullable().references('id').inTable('branches').onDelete('CASCADE');
  });

  for (const table of LOOKUP_TABLES) {
    await knex.raw(`
      create trigger ${table}_set_updated_at before update on ${table}
        for each row execute function set_updated_at()
    `);
  }

  await knex('contract_types').insert(
    CONTRACT_TYPES.map(([code, label, seasons, agreement_medium, is_switch_over], i) => ({
      code,
      label,
      seasons,
      agreement_medium,
      is_switch_over,
      sort_order: (i + 1) * 10,
    })),
  );
  await knex('billing_plans').insert(
    BILLING_PLANS.map(([code, label, kind, installments_per_season, early_termination_fee], i) => ({
      code,
      label,
      kind,
      installments_per_season,
      early_termination_fee,
      sort_order: (i + 1) * 10,
    })),
  );
  await knex('scope_items').insert(SCOPE_ITEMS.map(([code, label], i) => ({ code, label, sort_order: (i + 1) * 10 })));
  await knex('addon_services').insert(
    ADDON_SERVICES.map(([code, label], i) => ({ code, label, sort_order: (i + 1) * 10 })),
  );
  await knex('contract_tags').insert(
    CONTRACT_TAGS.map(([code, label, kind], i) => ({ code, label, kind, sort_order: (i + 1) * 10 })),
  );
  await knex('tax_codes').insert(
    TAX_CODES.map(([code, label, rate, province, is_default], i) => ({
      code,
      label,
      rate,
      province,
      is_default,
      sort_order: (i + 1) * 10,
    })),
  );

  // ── Customers ─────────────────────────────────────────────────────────
  await knex.schema.alterTable('customers', (table) => {
    // Null when bills go to the service address.
    table.text('billing_address_line1').nullable();
    table.text('billing_address_line2').nullable();
    table.text('billing_city').nullable();
    table.text('billing_province').nullable();
    table.text('billing_postal_code').nullable();
    // Who on staff is looking after this customer's text thread.
    table.uuid('sms_assigned_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    // The customer asked not to be texted (CASL). Nothing manual goes out.
    table.boolean('sms_opt_out').notNullable().defaultTo(false);
  });

  await knex.schema.createTable('customer_phones', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    table.text('number').notNullable();
    table.text('phone_type').notNullable().defaultTo('mobile');
    table.boolean('is_primary').notNullable().defaultTo(false);
    table.integer('sort_order').notNullable().defaultTo(0);
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['customer_id'], 'customer_phones_customer_id_index');
  });
  await knex.raw(`
    alter table customer_phones add constraint customer_phones_type_check
      check (phone_type in (${inList(PHONE_TYPES)}))
  `);
  await knex.raw(`
    create unique index customer_phones_one_primary on customer_phones (customer_id) where is_primary
  `);
  await knex.raw(`
    create trigger customer_phones_set_updated_at before update on customer_phones
      for each row execute function set_updated_at()
  `);
  // The one phone every customer had becomes their primary mobile.
  // customers.phone stays, kept in step with the primary by the service.
  await knex.raw(`
    insert into customer_phones (customer_id, number, phone_type, is_primary)
      select id, phone, 'mobile', true from customers where phone is not null and btrim(phone) <> ''
  `);

  await knex.schema.createTable('customer_notes', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    table.text('kind').notNullable();
    table.text('body').notNullable();
    table.uuid('author_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('updated_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['customer_id', 'kind'], 'customer_notes_customer_kind_index');
  });
  await knex.raw(`
    alter table customer_notes add constraint customer_notes_kind_check check (kind in (${inList(NOTE_KINDS)}))
  `);
  await knex.raw(`alter table customer_notes add constraint customer_notes_body_check check (btrim(body) <> '')`);
  await knex.raw(`
    create trigger customer_notes_set_updated_at before update on customer_notes
      for each row execute function set_updated_at()
  `);
  // Copied, not moved: the old columns are still read elsewhere.
  await knex.raw(`
    insert into customer_notes (customer_id, kind, body, created_at)
      select id, 'account', notes, created_at from customers where notes is not null and btrim(notes) <> ''
  `);
  await knex.raw(`
    insert into customer_notes (customer_id, kind, body, created_at)
      select customer_id, 'operator', access_notes, created_at from properties
        where access_notes is not null and btrim(access_notes) <> ''
  `);

  // ── Quotes: the contract form ─────────────────────────────────────────
  await knex.schema.alterTable('quotes', (table) => {
    table.uuid('contract_type_id').nullable().references('id').inTable('contract_types').onDelete('RESTRICT');
    table.uuid('billing_plan_id').nullable().references('id').inTable('billing_plans').onDelete('RESTRICT');
    table.uuid('tax_code_id').nullable().references('id').inTable('tax_codes').onDelete('RESTRICT');
    // Frozen when the form is saved, so editing a tax code later cannot
    // change what a customer already agreed to pay.
    table.decimal('tax_rate', 6, 4).nullable();
    table.uuid('assigned_operator_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.uuid('service_route_id').nullable().references('id').inTable('service_routes').onDelete('SET NULL');
    table.text('route_code').nullable();
    table.decimal('discount', 10, 2).notNullable().defaultTo('0');
    table.decimal('trigger_cm', 4, 1).nullable();
    table.decimal('referral_credit', 10, 2).nullable();
    // Who referred this customer. They earn the referral credit.
    table.uuid('referred_by_customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    table.boolean('auto_renew').notNullable().defaultTo(true);
    table.integer('driveway_car_lengths').nullable();
    table.text('driveway_width').nullable();
    table.text('property_notes').nullable();
    // Copied from the billing plan when the form is saved, like the tax rate.
    table.decimal('early_termination_fee', 10, 2).nullable();
  });
  await knex.raw(`alter table quotes add constraint quotes_discount_amount_check check (discount >= 0)`);
  await knex.raw(`
    alter table quotes add constraint quotes_referral_credit_check check (referral_credit is null or referral_credit >= 0)
  `);
  await knex.raw(`
    alter table quotes add constraint quotes_driveway_width_check
      check (driveway_width is null or driveway_width in (${inList(DRIVEWAY_WIDTHS)}))
  `);
  await knex.raw(`
    alter table quotes add constraint quotes_driveway_lengths_check
      check (driveway_car_lengths is null or driveway_car_lengths between 1 and 20)
  `);
  await knex.raw(`
    alter table quotes add constraint quotes_trigger_cm_check check (trigger_cm is null or trigger_cm between 0 and 100)
  `);
  // A service agreement has everything the agreement prints.
  await knex.raw(`
    alter table quotes add constraint quotes_service_agreement_complete_check
      check (
        billing_plan_id is null
        or (contract_type_id is not null and tax_code_id is not null and tax_rate is not null)
      )
  `);

  await knex.schema.createTable('quote_scope_items', (table) => {
    table.uuid('quote_id').notNullable().references('id').inTable('quotes').onDelete('CASCADE');
    table.uuid('scope_item_id').notNullable().references('id').inTable('scope_items').onDelete('RESTRICT');
    table.primary(['quote_id', 'scope_item_id']);
  });
  await knex.schema.createTable('quote_addons', (table) => {
    table.uuid('quote_id').notNullable().references('id').inTable('quotes').onDelete('CASCADE');
    table.uuid('addon_service_id').notNullable().references('id').inTable('addon_services').onDelete('RESTRICT');
    table.decimal('price', 10, 2).notNullable();
    table.primary(['quote_id', 'addon_service_id']);
  });
  await knex.raw(`alter table quote_addons add constraint quote_addons_price_check check (price >= 0)`);
  await knex.schema.createTable('quote_tags', (table) => {
    table.uuid('quote_id').notNullable().references('id').inTable('quotes').onDelete('CASCADE');
    table.uuid('tag_id').notNullable().references('id').inTable('contract_tags').onDelete('RESTRICT');
    table.primary(['quote_id', 'tag_id']);
  });

  // ── Contracts ─────────────────────────────────────────────────────────
  await knex.schema.alterTable('contracts', (table) => {
    table.text('agreement_medium').notNullable().defaultTo('electronic');
    table.text('signer_name').nullable();
    // Which signature boxes the customer applied their signature to, and when.
    table.jsonb('signature_boxes').nullable();
  });
  await knex.raw(`
    alter table contracts add constraint contracts_agreement_medium_check
      check (agreement_medium in ('electronic', 'paper'))
  `);
  await knex.raw('alter table contracts alter column signature_image_url drop not null');
  // Only paper goes without a drawn signature, and paper always has its scan.
  await knex.raw(`
    alter table contracts add constraint contracts_signed_somehow_check
      check (
        signature_image_url is not null
        or (agreement_medium = 'paper' and pdf_url is not null)
      )
  `);

  // ── Invoices and credits ──────────────────────────────────────────────
  await knex.schema.alterTable('invoices', (table) => {
    // Null on invoices raised before tax was charged.
    table.decimal('subtotal', 10, 2).nullable();
    table.decimal('tax_amount', 10, 2).nullable();
    table.decimal('credit_applied', 10, 2).notNullable().defaultTo('0');
    // Months of service this bill pays for; a monthly referral credit is earned per month.
    table.integer('service_months').nullable();
  });
  await knex.raw(`
    alter table invoices add constraint invoices_breakdown_check
      check (
        (subtotal is null and tax_amount is null)
        or (subtotal >= 0 and tax_amount >= 0 and credit_applied >= 0
            and amount_due = subtotal + tax_amount - credit_applied)
      )
  `);

  await knex.schema.createTable('customer_credits', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('customer_id').notNullable().references('id').inTable('customers').onDelete('CASCADE');
    table.text('kind').notNullable();
    // Positive is credit earned, negative is credit spent.
    table.decimal('amount', 10, 2).notNullable();
    table.text('description').nullable();
    // referral: the referred customer's paid invoice that earned it.
    table.uuid('source_invoice_id').nullable().references('id').inTable('invoices').onDelete('CASCADE');
    // applied: the invoice it was spent on.
    table.uuid('invoice_id').nullable().references('id').inTable('invoices').onDelete('CASCADE');
    table.uuid('created_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['customer_id'], 'customer_credits_customer_id_index');
  });
  await knex.raw(`
    alter table customer_credits add constraint customer_credits_kind_check check (kind in (${inList(CREDIT_KINDS)}))
  `);
  await knex.raw(`
    alter table customer_credits add constraint customer_credits_shape_check
      check (
        (kind = 'referral' and amount > 0 and source_invoice_id is not null)
        or (kind = 'applied' and amount < 0 and invoice_id is not null)
        or (kind = 'adjustment' and amount <> 0)
      )
  `);
  // A paid invoice earns its referrer credit once, however often it is recomputed.
  await knex.raw(`
    create unique index customer_credits_referral_once on customer_credits (source_invoice_id) where kind = 'referral'
  `);
  await knex.raw(`
    create unique index customer_credits_applied_once on customer_credits (invoice_id) where kind = 'applied'
  `);

  // ── Messages ──────────────────────────────────────────────────────────
  await knex.schema.alterTable('message_log', (table) => {
    // Not before this time: "send later".
    table.timestamp('send_after', { useTz: true }).nullable();
    // Who typed it, for a message written by hand rather than from a template.
    table.uuid('sent_by_user_id').nullable().references('id').inTable('users').onDelete('SET NULL');
    // A stored file to attach to an email, such as the signed agreement.
    table.text('attachment_key').nullable();
    table.text('attachment_name').nullable();
  });
  await knex.raw(`
    alter table message_log add constraint message_log_attachment_check
      check (attachment_key is null or channel = 'email')
  `);

  await knex.schema.createTable('sms_inbound', (table) => {
    table.uuid('id').primary().defaultTo(knex.raw('gen_random_uuid()'));
    table.uuid('customer_id').nullable().references('id').inTable('customers').onDelete('SET NULL');
    table.text('from_number').notNullable();
    table.text('body').notNullable();
    table.text('provider_message_id').nullable();
    table.timestamp('received_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.timestamp('created_at', { useTz: true }).notNullable().defaultTo(knex.fn.now());
    table.index(['customer_id', 'received_at'], 'sms_inbound_customer_index');
  });
  await knex.raw(`
    create unique index sms_inbound_provider_message_unique on sms_inbound (provider_message_id)
      where provider_message_id is not null
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.schema.dropTableIfExists('sms_inbound');
  await knex.raw('alter table message_log drop constraint if exists message_log_attachment_check');
  await knex.schema.alterTable('message_log', (table) => {
    table.dropColumn('send_after');
    table.dropColumn('sent_by_user_id');
    table.dropColumn('attachment_key');
    table.dropColumn('attachment_name');
  });

  await knex.schema.dropTableIfExists('customer_credits');
  await knex.raw('alter table invoices drop constraint if exists invoices_breakdown_check');
  await knex.schema.alterTable('invoices', (table) => {
    table.dropColumn('subtotal');
    table.dropColumn('tax_amount');
    table.dropColumn('credit_applied');
    table.dropColumn('service_months');
  });

  await knex.raw('alter table contracts drop constraint if exists contracts_signed_somehow_check');
  await knex.raw('alter table contracts alter column signature_image_url set not null');
  await knex.raw('alter table contracts drop constraint if exists contracts_agreement_medium_check');
  await knex.schema.alterTable('contracts', (table) => {
    table.dropColumn('agreement_medium');
    table.dropColumn('signer_name');
    table.dropColumn('signature_boxes');
  });

  await knex.schema.dropTableIfExists('quote_tags');
  await knex.schema.dropTableIfExists('quote_addons');
  await knex.schema.dropTableIfExists('quote_scope_items');
  for (const constraint of [
    'quotes_service_agreement_complete_check',
    'quotes_trigger_cm_check',
    'quotes_driveway_lengths_check',
    'quotes_driveway_width_check',
    'quotes_referral_credit_check',
    'quotes_discount_amount_check',
  ]) {
    await knex.raw(`alter table quotes drop constraint if exists ${constraint}`);
  }
  await knex.schema.alterTable('quotes', (table) => {
    for (const column of [
      'contract_type_id',
      'billing_plan_id',
      'tax_code_id',
      'tax_rate',
      'assigned_operator_id',
      'service_route_id',
      'route_code',
      'discount',
      'trigger_cm',
      'referral_credit',
      'referred_by_customer_id',
      'auto_renew',
      'driveway_car_lengths',
      'driveway_width',
      'property_notes',
      'early_termination_fee',
    ]) {
      table.dropColumn(column);
    }
  });

  await knex.schema.dropTableIfExists('customer_notes');
  await knex.schema.dropTableIfExists('customer_phones');
  await knex.schema.alterTable('customers', (table) => {
    for (const column of [
      'billing_address_line1',
      'billing_address_line2',
      'billing_city',
      'billing_province',
      'billing_postal_code',
      'sms_assigned_user_id',
      'sms_opt_out',
    ]) {
      table.dropColumn(column);
    }
  });

  for (const table of [...LOOKUP_TABLES].reverse()) {
    await knex.schema.dropTableIfExists(table);
  }
}
