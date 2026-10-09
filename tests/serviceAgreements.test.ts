import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { config } from '../src/config';
import { generateInvoicesForContract, recomputeInvoiceTotals, today } from '../src/services/invoices';
import { sendQueued } from '../src/services/messages';
import { addDays, addMonths } from '../src/types/serviceAgreement';
import { db } from './helpers/database';
import { harness } from './helpers/harness';
import { makeCustomer } from './helpers/fixtures';
import { pdfText } from './helpers/pdf';
import { call, login } from './helpers/server';

/** A real one-pixel PNG, for the signature. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');

const ALL_BOXES = ['commitment', 'service_commitment', 'card_authorization'];

/** Next year's season: always ahead of the clock, so a sign-up is always pre-season. */
const NEXT_YEAR = new Date().getUTCFullYear() + 1;
const SEASON_START = `${NEXT_YEAR}-11-01`;
const SEASON_END = `${NEXT_YEAR + 1}-03-31`;

/** Untyped, for reading rows back without restating every column type. */
function table(name: string): any {
  return db(name);
}

async function idOf(name: string, code: string): Promise<string> {
  const row = await table(name).where({ code }).first('id');
  assert.ok(row, `${name}.${code} is seeded`);
  return row.id as string;
}

describe('the service agreement', () => {
  const h = harness();

  async function upload(token: string, purpose: 'signature' | 'contract_pdf'): Promise<string> {
    const contentType = purpose === 'signature' ? 'image/png' : 'application/pdf';
    const target = await call(h.server(), 'POST', '/uploads', {
      token,
      body: { purpose, content_type: contentType, file_name: purpose === 'signature' ? 'signature.png' : 'scan.pdf' },
    });
    assert.equal(target.status, 201, JSON.stringify(target.body));
    const put = await fetch(`${h.server().url}${target.body.data.upload_url}`, {
      method: 'PUT',
      headers: { 'Content-Type': contentType },
      body: purpose === 'signature' ? PNG : PDF,
    });
    assert.equal(put.status, 201);
    return target.body.data.key as string;
  }

  /** The form as the rep fills it in: $500 a season, a $100 add-on, $50 off, 13% HST. */
  async function form(propertyId: string, overrides: Record<string, unknown> = {}) {
    return {
      property_id: propertyId,
      contract_type_id: await idOf('contract_types', 'seasonal_1_electronic'),
      billing_plan_id: await idOf('billing_plans', 'seasonal_monthly'),
      package: 'premium',
      trigger_cm: 3,
      season_start: SEASON_START,
      season_end: SEASON_END,
      scope_item_ids: [await idOf('scope_items', 'driveway'), await idOf('scope_items', 'front_walkway')],
      addons: [{ addon_service_id: await idOf('addon_services', 'roof_raking'), price: '100.00' }],
      tag_ids: [],
      normal_price: '500.00',
      discount: '50.00',
      tax_code_id: await idOf('tax_codes', 'ON_HST'),
      route_code: 'K-12',
      driveway_car_lengths: 2,
      driveway_width: 'double',
      property_notes: 'Pile snow left of the garage.',
      auto_renew: true,
      ...overrides,
    };
  }

  async function setup(overrides: Record<string, unknown> = {}, who: { first_name?: string; address_line1?: string } = {}) {
    const world = h.world();
    const made = await makeCustomer(world.branches.kingston, world.users.sales, {
      first_name: who.first_name ?? 'Harold',
      address_line1: who.address_line1 ?? '212 Johnson St',
      email: `${(who.first_name ?? 'harold').toLowerCase()}@example.test`,
    });
    const token = await login(h.server(), world.emails.sales);
    const reply = await call(h.server(), 'POST', `/customers/${made.customer_id}/agreements`, {
      token,
      body: await form(made.property_id, overrides),
    });
    assert.equal(reply.status, 201, JSON.stringify(reply.body));
    return { ...made, token, quote_id: reply.body.data.quote_id as string, form: reply.body.data };
  }

  async function sign(token: string, quoteId: string, boxes = ALL_BOXES) {
    return call(h.server(), 'POST', `/agreements/${quoteId}/sign`, {
      token,
      body: { signature_key: await upload(token, 'signature'), signer_name: 'Harold Bell', boxes },
    });
  }

  describe('lookups', () => {
    it('serves every list the form is built from', async () => {
      const token = await login(h.server(), h.world().emails.sales);
      const reply = await call(h.server(), 'GET', '/lookups', { token });
      assert.equal(reply.status, 200);
      const lists = reply.body.data;
      assert.equal(lists.contract_types.length, 8);
      assert.equal(lists.scope_items.length, 10);
      assert.equal(lists.addon_services.length, 5);
      assert.deepEqual(
        lists.billing_plans.map((p: { kind: string }) => p.kind),
        ['seasonal_installments', 'seasonal_yia', 'monthly_recurring', 'monthly_one_time'],
      );
      const on = lists.tax_codes.find((t: { province: string; is_default: boolean }) => t.province === 'ON' && t.is_default);
      assert.equal(on.label, 'ON – 13% HST');
      assert.equal(on.rate, '0.1300');
    });

    it('lets the office relabel and retire a row, and nobody else', async () => {
      const id = await idOf('scope_items', 'garage_apron');
      const sales = await login(h.server(), h.world().emails.sales);
      const refused = await call(h.server(), 'PATCH', `/lookups/scope_items/${id}`, { token: sales, body: { active: false } });
      assert.equal(refused.status, 403);

      const corporate = await login(h.server(), h.world().emails.corporate);
      const changed = await call(h.server(), 'PATCH', `/lookups/scope_items/${id}`, {
        token: corporate,
        body: { label: 'Garage apron & door', active: false },
      });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));

      const active = await call(h.server(), 'GET', '/lookups/scope_items', { token: sales });
      assert.ok(!active.body.data.some((r: { id: string }) => r.id === id));
      const all = await call(h.server(), 'GET', '/lookups/scope_items?include_inactive=true', { token: corporate });
      assert.ok(all.body.data.some((r: { label: string }) => r.label === 'Garage apron & door'));

      // Put back: lookup rows outlive the per-test reset.
      await table('scope_items').where({ id }).update({ label: 'Garage apron', active: true });
    });

    it('keeps one default tax code per province', async () => {
      const corporate = await login(h.server(), h.world().emails.corporate);
      const id = await idOf('tax_codes', 'BC_GST_PST');
      const reply = await call(h.server(), 'PATCH', `/lookups/tax_codes/${id}`, { token: corporate, body: { is_default: true } });
      assert.equal(reply.status, 200);
      const defaults = await table('tax_codes').where({ province: 'BC', is_default: true }).pluck('code');
      assert.deepEqual(defaults, ['BC_GST_PST']);
      await table('tax_codes').where({ province: 'BC' }).update({ is_default: false });
      await table('tax_codes').where({ code: 'BC_GST' }).update({ is_default: true });
    });

    it('lets the office add a new add-on', async () => {
      const corporate = await login(h.server(), h.world().emails.corporate);
      const reply = await call(h.server(), 'POST', '/lookups/addon_services', {
        token: corporate,
        body: { code: 'test_shed_path', label: 'Path to the shed', default_price: '40.00' },
      });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      assert.ok(reply.body.data.sort_order > 50);
      await table('addon_services').where({ code: 'test_shed_path' }).del();
    });
  });

  describe('the contract form', () => {
    it('saves a signable quote with the money worked out', async () => {
      const { quote_id, form: saved } = await setup();
      const quote = await table('quotes').where({ id: quote_id }).first();
      assert.equal(quote.status, 'presented');
      assert.equal(quote.billing_type, 'monthly');
      // $500 + $100 add-on, less $50: $550 a season, five payments of $110.
      assert.equal(quote.initial_price, '600.00');
      assert.equal(quote.discounted_price, '550.00');
      assert.equal(quote.recurring_price, '110.00');
      assert.equal(quote.tax_rate, '0.1300');
      assert.equal(quote.early_termination_fee, '75.00');
      assert.equal(saved.normal_price, '500.00');
      assert.equal(saved.scope_item_ids.length, 2);
      assert.equal(saved.addons[0].price, '100.00');
      // The crew sees the property notes on dispatch.
      const property = await table('properties').where({ id: quote.property_id }).first();
      assert.equal(property.access_notes, 'Pile snow left of the garage.');
    });

    it('refuses a YIA tag on a monthly plan, and tags a YIA plan itself', async () => {
      const world = h.world();
      const made = await makeCustomer(world.branches.kingston, world.users.sales);
      const token = await login(h.server(), world.emails.sales);
      const yiaTag = await idOf('contract_tags', 'yia');

      const mismatched = await call(h.server(), 'POST', `/customers/${made.customer_id}/agreements`, {
        token,
        body: await form(made.property_id, { tag_ids: [yiaTag] }),
      });
      assert.equal(mismatched.status, 400);
      assert.match(mismatched.body.error.message, /YIA/);

      const yia = await call(h.server(), 'POST', `/customers/${made.customer_id}/agreements`, {
        token,
        body: await form(made.property_id, { billing_plan_id: await idOf('billing_plans', 'seasonal_yia') }),
      });
      assert.equal(yia.status, 201);
      assert.deepEqual(yia.body.data.tag_ids, [yiaTag]);
    });

    it('needs to know who referred a referral customer', async () => {
      const world = h.world();
      const made = await makeCustomer(world.branches.kingston, world.users.sales);
      const token = await login(h.server(), world.emails.sales);
      const reply = await call(h.server(), 'POST', `/customers/${made.customer_id}/agreements`, {
        token,
        body: await form(made.property_id, { tag_ids: [await idOf('contract_tags', 'referral_customer')] }),
      });
      assert.equal(reply.status, 400);
      assert.match(reply.body.error.message, /referral/i);
    });

    it('refuses a discount bigger than the price', async () => {
      const world = h.world();
      const made = await makeCustomer(world.branches.kingston, world.users.sales);
      const token = await login(h.server(), world.emails.sales);
      const reply = await call(h.server(), 'POST', `/customers/${made.customer_id}/agreements`, {
        token,
        body: await form(made.property_id, { discount: '900.00' }),
      });
      assert.equal(reply.status, 400);
    });

    it('can be changed until it is signed', async () => {
      const { quote_id, token, property_id } = await setup();
      const changed = await call(h.server(), 'PUT', `/agreements/${quote_id}`, {
        token,
        body: await form(property_id, { discount: '0' }),
      });
      assert.equal(changed.status, 200, JSON.stringify(changed.body));
      assert.equal((await table('quotes').where({ id: quote_id }).first()).discounted_price, '600.00');

      await sign(token, quote_id);
      const late = await call(h.server(), 'PUT', `/agreements/${quote_id}`, { token, body: await form(property_id) });
      assert.equal(late.status, 409);
    });
  });

  describe('the agreement document', () => {
    it('fills every section from the form', async () => {
      const { quote_id, token } = await setup();
      const reply = await call(h.server(), 'GET', `/agreements/${quote_id}/document`, { token });
      assert.equal(reply.status, 200);
      const doc = reply.body.data;

      assert.equal(doc.status, 'draft');
      assert.equal(doc.customer.name, 'Harold Bell');
      assert.deepEqual(doc.customer.address, ['212 Johnson St', 'Kingston, ON K7L 1Y4']);
      assert.equal(doc.scope.filter((s: { checked: boolean }) => s.checked).length, 2);
      assert.equal(doc.scope.length, 10);
      const roof = doc.addons.find((a: { label: string }) => a.label === 'Roof raking');
      assert.deepEqual(roof, { label: 'Roof raking', checked: true, price: '$100.00 per season' });
      assert.deepEqual(doc.length, { one: true, two: false, other: false, other_label: null });
      assert.deepEqual(
        doc.schedule.map((s: { label: string; total: string }) => `${s.label} ${s.total}`),
        ['NOV $124.30', 'DEC $124.30', 'JAN $124.30', 'FEB $124.30', 'MAR $124.30'],
      );
      assert.equal(doc.paid_in_full, false);
      const lines = Object.fromEntries(doc.pricing_lines.map((l: { label: string; value: string }) => [l.label, l.value]));
      assert.equal(lines['Normal Price (per season)'], '$500.00');
      assert.equal(lines['Discount'], '-$50.00');
      assert.equal(lines['Net First Payment'], '$110.00');
      assert.equal(lines['First Payment incl. Tax'], '$124.30');
      assert.equal(lines['Recurring Monthly Amount'], '$110.00');
      assert.equal(lines['Recurring incl. Tax'], '$124.30');
      assert.equal(lines['Add-ons (per season)'], '$100.00');
      assert.equal(lines['Total incl. Tax'], '$621.50');
      assert.match(doc.wording.agreement_period, /3 cm/);
      assert.match(doc.wording.commitment, /\$75\.00/);
      assert.ok(doc.rep_name, 'the rep who wrote it is named');
    });

    it('prints a PDF with the same numbers', async () => {
      const { quote_id, token } = await setup();
      const reply = await fetch(`${h.server().url}/agreements/${quote_id}/preview.pdf`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(reply.status, 200);
      assert.equal(reply.headers.get('content-type'), 'application/pdf');
      const text = pdfText(Buffer.from(await reply.arrayBuffer()));
      for (const expected of [
        'Harold Bell',
        'SCOPE OF SERVICE',
        'LENGTH OF THE AGREEMENT:',
        'PAYMENT SCHEDULE',
        '$124.30',
        '$621.50',
        'E-CARD/EMAIL:',
        'YOU, THE BUYER, MAY CANCEL THIS AGREEMENT',
        'Terms and Conditions'.toUpperCase(),
      ]) {
        assert.ok(text.includes(expected), `the PDF says ${expected}`);
      }
    });

    it('shows a single paid-in-full payment for YIA', async () => {
      const { quote_id, token } = await setup({
        billing_plan_id: await idOf('billing_plans', 'seasonal_yia'),
        tag_ids: [await idOf('contract_tags', 'yia')],
      });
      const doc = (await call(h.server(), 'GET', `/agreements/${quote_id}/document`, { token })).body.data;
      assert.equal(doc.paid_in_full, true);
      assert.equal(doc.schedule.length, 1);
      assert.equal(doc.schedule[0].label, 'PAID IN FULL');
      assert.equal(doc.schedule[0].total, '$621.50');
      const lines = Object.fromEntries(doc.pricing_lines.map((l: { label: string; value: string }) => [l.label, l.value]));
      assert.equal(lines['Recurring Monthly Amount'], '—');
    });

    it('shows both seasons of a two-season commitment', async () => {
      const { quote_id, token } = await setup({ contract_type_id: await idOf('contract_types', 'seasonal_2_electronic') });
      const doc = (await call(h.server(), 'GET', `/agreements/${quote_id}/document`, { token })).body.data;
      assert.equal(doc.schedule.length, 10);
      assert.deepEqual(doc.length, { one: false, two: true, other: false, other_label: null });
    });
  });

  describe('signing', () => {
    it('locks the signed PDF, records who, when and where from, and emails a copy', async () => {
      const { quote_id, token, customer_id } = await setup();
      const reply = await sign(token, quote_id);
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      const contract = reply.body.data;
      assert.equal(contract.signer_name, 'Harold Bell');
      assert.equal(contract.agreement_medium, 'electronic');
      assert.ok(contract.signed_ip);
      assert.deepEqual(Object.keys(contract.signature_boxes).sort(), [...ALL_BOXES].sort());
      assert.ok(contract.pdf_url);
      assert.equal((await table('quotes').where({ id: quote_id }).first()).status, 'accepted');

      const file = await fetch(`${h.server().url}/files/${contract.pdf_url}`, { headers: { Authorization: `Bearer ${token}` } });
      assert.equal(file.status, 200);
      const text = pdfText(Buffer.from(await file.arrayBuffer()));
      assert.ok(text.includes('SIGNATURE RECORD'));
      assert.ok(/\d{2} Of [A-Z][a-z]{2} \d{4}/.test(text), 'the signed date is printed as "09 Of Oct 2026"');

      const email = await table('message_log').where({ customer_id, template_code: 'agreement_signed' }).first();
      assert.ok(email, 'a copy is queued for the customer');
      assert.equal(email.attachment_key, contract.pdf_url);
    });

    it('refuses while a required box is empty', async () => {
      const { quote_id, token } = await setup();
      const reply = await sign(token, quote_id, ['commitment', 'service_commitment']);
      assert.equal(reply.status, 400);
      assert.ok(reply.body.error.details.some((d: { path: string }) => d.path === 'boxes.card_authorization'));
    });

    it('takes a scanned paper agreement instead of a signature', async () => {
      const { quote_id, token } = await setup({ contract_type_id: await idOf('contract_types', 'seasonal_1_paper') });
      const onScreen = await sign(token, quote_id);
      assert.equal(onScreen.status, 409);

      const scan = await upload(token, 'contract_pdf');
      const reply = await call(h.server(), 'POST', `/agreements/${quote_id}/paper`, {
        token,
        body: { pdf_key: scan, signer_name: 'Harold Bell' },
      });
      assert.equal(reply.status, 201, JSON.stringify(reply.body));
      assert.equal(reply.body.data.agreement_medium, 'paper');
      assert.equal(reply.body.data.signature_image_url, null);
      assert.equal(reply.body.data.pdf_url, scan);
    });

    it('never stores a card number', async () => {
      const { quote_id, token } = await setup();
      const { body } = await sign(token, quote_id);
      const row = await table('contracts').where({ id: body.data.id }).first();
      // Signing takes no card at all: the card comes later, on the
      // processor's page, as a token.
      assert.equal(row.payment_method_token, null);
      for (const value of Object.values(row)) {
        if (typeof value === 'string') assert.ok(!/^\d{12,19}$/.test(value.replace(/[\s-]/g, '')), 'no card number');
      }
    });
  });

  describe('billing from the schedule', () => {
    /** A season under way, so the first payment is due the day it is signed. */
    function inSeason(): { season_start: string; season_end: string } {
      const start = addDays(today(), -10);
      return { season_start: start, season_end: addDays(addMonths(start, 5), -1) };
    }

    it('bills the first payment with tax the day an in-season agreement is signed', async () => {
      const { quote_id, token } = await setup(inSeason());
      const { body } = await sign(token, quote_id);
      const invoices = await table('invoices').where({ contract_id: body.data.id });
      assert.equal(invoices.length, 1);
      const [invoice] = invoices;
      assert.equal(invoice.billing_period_start, today());
      assert.equal(invoice.subtotal, '110.00');
      assert.equal(invoice.tax_amount, '14.30');
      assert.equal(invoice.amount_due, '124.30');
      assert.equal(invoice.status, 'sent');
    });

    it('bills a pre-season agreement from November 1st, a month at a time', async () => {
      const { quote_id, token } = await setup();
      const { body } = await sign(token, quote_id);
      assert.equal((await table('invoices').where({ contract_id: body.data.id })).length, 0);

      const asOf = `${NEXT_YEAR}-12-15`;
      const raised = await generateInvoicesForContract(body.data.id, asOf, db);
      assert.deepEqual(
        raised.map((i) => [i.billing_period_start, i.amount_due]),
        [
          [`${NEXT_YEAR}-11-01`, '124.30'],
          [`${NEXT_YEAR}-12-01`, '124.30'],
        ],
      );
      // Run again: nothing twice.
      assert.equal((await generateInvoicesForContract(body.data.id, asOf, db)).length, 0);
    });

    it('takes a YIA season as one payment at signing', async () => {
      const { quote_id, token } = await setup({
        billing_plan_id: await idOf('billing_plans', 'seasonal_yia'),
        tag_ids: [await idOf('contract_tags', 'yia')],
      });
      const { body } = await sign(token, quote_id, ['commitment', 'service_commitment']);
      assert.equal(body.data.status, 'active', JSON.stringify(body));
      const invoices = await table('invoices').where({ contract_id: body.data.id });
      assert.equal(invoices.length, 1);
      assert.equal(invoices[0].amount_due, '621.50');
      assert.equal(invoices[0].service_months, 5);
      // Nothing more is raised for the season: recurring billing is off.
      assert.equal((await generateInvoicesForContract(body.data.id, `${NEXT_YEAR + 1}-03-15`, db)).length, 0);
    });

    it('credits the referrer each month their referral pays, and takes it off their next bill', async () => {
      const referrer = await setup({}, { first_name: 'Rita', address_line1: '10 Union St' });
      const referrerContract = (await sign(referrer.token, referrer.quote_id)).body.data;

      // The referred customer pays for the season up front.
      const referred = await setup(
        {
          billing_plan_id: await idOf('billing_plans', 'seasonal_yia'),
          tag_ids: [await idOf('contract_tags', 'yia'), await idOf('contract_tags', 'referral_customer')],
          referred_by_customer_id: referrer.customer_id,
        },
        { first_name: 'Neil', address_line1: '12 Union St' },
      );
      assert.equal((await table('quotes').where({ id: referred.quote_id }).first()).referral_credit, '10.00');
      const referredContract = (await sign(referred.token, referred.quote_id, ['commitment', 'service_commitment'])).body
        .data;
      const [bill] = await table('invoices').where({ contract_id: referredContract.id });

      await table('payments').insert({
        invoice_id: bill.id,
        amount: bill.amount_due,
        method: 'cash',
        status: 'succeeded',
        processed_at: new Date(),
      });
      await db.transaction((trx) => recomputeInvoiceTotals(bill.id, trx));
      // Recomputing again must not pay out twice.
      await db.transaction((trx) => recomputeInvoiceTotals(bill.id, trx));

      const credits = await table('customer_credits').where({ customer_id: referrer.customer_id });
      assert.equal(credits.length, 1);
      assert.equal(credits[0].amount, '50.00', '$10 a month for the five months paid');

      const [next] = await generateInvoicesForContract(referrerContract.id, SEASON_START, db);
      assert.equal(next!.subtotal, '110.00');
      assert.equal(next!.credit_applied, '50.00');
      assert.equal(next!.amount_due, '74.30');

      const summary = await call(h.server(), 'GET', `/customers/${referrer.customer_id}/summary`, { token: referrer.token });
      assert.equal(summary.body.data.credit, '0.00');
    });
  });

  describe('the customer summary', () => {
    it('leads with the active contract, the balance and the card', async () => {
      const { quote_id, token, customer_id } = await setup({
        season_start: addDays(today(), -10),
        season_end: addDays(addMonths(addDays(today(), -10), 5), -1),
      });
      const signed = (await sign(token, quote_id)).body.data;
      await table('contracts').where({ id: signed.id }).update({
        payment_method_token: 'cnon:card-nonce-ok',
        payment_method_last4: '1234',
        payment_method_brand: 'VISA',
      });

      const reply = await call(h.server(), 'GET', `/customers/${customer_id}/summary`, { token });
      assert.equal(reply.status, 200);
      const summary = reply.body.data;
      assert.equal(summary.active_contract.agreement, 'Seasonal Snow Removal – Monthly Billing 1 Season (Electronic Agreement)');
      assert.equal(summary.active_contract.status, 'active');
      assert.equal(summary.balance, '124.30');
      assert.equal(summary.credit, '0.00');
      assert.deepEqual(summary.payment_method, { brand: 'VISA', last4: '1234', provider: null });
      assert.ok(!JSON.stringify(summary).includes('cnon:card-nonce-ok'), 'the processor token never leaves the server');
    });

    it('lists an agreement waiting for its signature', async () => {
      const { token, customer_id } = await setup();
      const summary = (await call(h.server(), 'GET', `/customers/${customer_id}/summary`, { token })).body.data;
      assert.equal(summary.contracts.length, 1);
      assert.equal(summary.contracts[0].status, 'pending_signature');
      assert.equal(summary.active_contract, null);
    });

    it('keeps several phones, one of them primary, in step with the customer', async () => {
      const { token, customer_id } = await setup();
      const reply = await call(h.server(), 'PUT', `/customers/${customer_id}/phones`, {
        token,
        body: {
          phones: [
            { number: '613-555-0101', phone_type: 'mobile', is_primary: false },
            { number: '613-555-0102', phone_type: 'home', is_primary: true },
          ],
        },
      });
      assert.equal(reply.status, 200, JSON.stringify(reply.body));
      assert.equal(reply.body.data[0].number, '613-555-0102');
      assert.equal((await table('customers').where({ id: customer_id }).first()).phone, '613-555-0102');
    });

    it('keeps account notes and operator notes apart, and searches them', async () => {
      const { token, customer_id } = await setup();
      for (const [kind, body] of [
        ['account', 'Prefers email.'],
        ['operator', 'Gate code 4411.'],
        ['operator', 'Pile snow on the left.'],
      ]) {
        const reply = await call(h.server(), 'POST', `/customers/${customer_id}/notes`, { token, body: { kind, body } });
        assert.equal(reply.status, 201);
      }
      const operator = await call(h.server(), 'GET', `/customers/${customer_id}/notes?kind=operator`, { token });
      assert.equal(operator.body.meta.total, 2);
      const searched = await call(h.server(), 'GET', `/customers/${customer_id}/notes?kind=operator&search=gate`, { token });
      assert.deepEqual(
        searched.body.data.map((n: { body: string }) => n.body),
        ['Gate code 4411.'],
      );
      assert.ok(searched.body.data[0].author_name);
    });

    it('texts the customer now or later, through the queue', async () => {
      const { token, customer_id } = await setup();
      const later = new Date(Date.now() + 3_600_000).toISOString();
      const now = await call(h.server(), 'POST', `/customers/${customer_id}/sms`, { token, body: { body: 'On our way!' } });
      const scheduled = await call(h.server(), 'POST', `/customers/${customer_id}/sms`, {
        token,
        body: { body: 'Snow tomorrow — please move the car.', send_at: later },
      });
      assert.equal(now.status, 201);
      assert.equal(scheduled.status, 201);
      assert.ok(scheduled.body.data.scheduled_for);

      // The worker leaves the scheduled one for later.
      await sendQueued(50, db);
      const rows = await table('message_log').where({ customer_id, channel: 'sms', template_code: 'manual' }).orderBy('created_at');
      assert.notEqual(rows[0].status, 'queued');
      assert.equal(rows[1].status, 'queued');

      const thread = await call(h.server(), 'GET', `/customers/${customer_id}/sms`, { token });
      assert.equal(thread.body.data.length, 2);
    });

    it('hands the thread to a member of staff, and respects an opt-out', async () => {
      const { token, customer_id } = await setup();
      const assignees = (await call(h.server(), 'GET', `/customers/${customer_id}/sms/assignees`, { token })).body.data;
      const otto = assignees.find((a: { name: string }) => a.name === 'Otto Plows');
      const assigned = await call(h.server(), 'PATCH', `/customers/${customer_id}/sms`, {
        token,
        body: { assigned_user_id: otto.id },
      });
      assert.equal(assigned.body.data.sms_assigned_to.name, 'Otto Plows');

      await call(h.server(), 'PATCH', `/customers/${customer_id}/sms`, { token, body: { opt_out: true } });
      const refused = await call(h.server(), 'POST', `/customers/${customer_id}/sms`, { token, body: { body: 'Hi' } });
      assert.equal(refused.status, 409);
    });

    it('files a text the customer sends back, and STOP opts them out', async () => {
      const { token, customer_id } = await setup();
      const secret = 'inbound-secret-for-the-test-suite';
      const rejected = await fetch(`${h.server().url}/webhooks/sms/inbound`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'From=%2B16135550201&Body=Hello&MessageSid=SM1',
      });
      assert.equal(rejected.status, 401);

      (config.sms as { inboundSecret: string | null }).inboundSecret = secret;
      try {
        for (const [sid, text] of [
          ['SM1', 'Hello'],
          ['SM1', 'Hello'],
          ['SM2', 'STOP'],
        ]) {
          const reply = await fetch(`${h.server().url}/webhooks/sms/inbound?secret=${secret}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `From=%2B16135550201&Body=${text}&MessageSid=${sid}`,
          });
          assert.equal(reply.status, 200);
        }
      } finally {
        (config.sms as { inboundSecret: string | null }).inboundSecret = null;
      }
      const thread = (await call(h.server(), 'GET', `/customers/${customer_id}/sms`, { token })).body.data;
      assert.deepEqual(
        thread.map((m: { body: string }) => m.body),
        ['Hello', 'STOP'],
      );
      assert.equal((await table('customers').where({ id: customer_id }).first()).sms_opt_out, true);
    });
  });
});
