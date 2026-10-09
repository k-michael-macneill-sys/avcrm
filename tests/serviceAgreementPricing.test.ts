import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  agreementDateLabel,
  computePricing,
  defaultSeason,
  formatMoney,
  paymentSchedule,
  PricingError,
  taxOn,
  toCents,
  type PricingInput,
  type ScheduleTerms,
} from '../src/types/serviceAgreement';

/**
 * The money on the agreement, worked by hand. These are the numbers a
 * customer signs for and is billed, so each case states its arithmetic.
 */

const HST = '0.1300';

const seasonal = (overrides: Partial<PricingInput> = {}): PricingInput => ({
  plan_kind: 'seasonal_installments',
  installments_per_season: 5,
  seasons: 1,
  normal_price: 50000,
  discount: 5000,
  addons: [{ label: 'Roof raking', price: 10000 }],
  tax_rate: HST,
  ...overrides,
});

const terms = (overrides: Partial<ScheduleTerms> = {}): ScheduleTerms => ({
  plan_kind: 'seasonal_installments',
  installments_per_season: 5,
  seasons: 1,
  season_start: '2026-11-01',
  season_end: '2027-03-31',
  signed_on: '2026-10-09',
  auto_renew: true,
  ...overrides,
});

describe('service agreement money', () => {
  it('reads money without floats', () => {
    assert.equal(toCents('123.45'), 12345);
    assert.equal(toCents('$1,234.5'), 123450);
    assert.equal(toCents('0.07'), 7);
    assert.equal(toCents(19.99), 1999);
    assert.equal(toCents('12.345'), null);
    assert.equal(toCents('abc'), null);
    assert.equal(formatMoney(123450), '$1,234.50');
  });

  it('rounds tax half-up to the cent, per payment', () => {
    // 50¢ × 13% = 6.5¢ → 7¢; 11000 × 13% = 1430 exactly.
    assert.equal(taxOn(50, HST), 7);
    assert.equal(taxOn(11000, HST), 1430);
    // 8021 × 13% = 1042.73 → 1043.
    assert.equal(taxOn(8021, HST), 1043);
    assert.equal(taxOn(10000, '0.14975'), 1498);
  });

  it('splits a season into five payments, with tax on each', () => {
    // $500 + $100 add-on − $50 discount = $550 for the season; ÷ 5 = $110.
    const p = computePricing(seasonal());
    assert.equal(p.net, 55000);
    assert.equal(p.addons_total, 10000);
    assert.equal(p.first_payment, 11000);
    assert.equal(p.recurring_payment, 11000);
    assert.equal(p.first_payment_tax, 1430);
    assert.equal(p.first_payment_total, 12430);
    assert.equal(p.payments_count, 5);
    assert.equal(p.commitment_subtotal, 55000);
    assert.equal(p.commitment_tax, 7150);
    assert.equal(p.commitment_total, 62150);
  });

  it('puts the odd cents on the first payment so five add up to the season', () => {
    // $401.01 ÷ 5 = $80.202: four payments of $80.20, the first $80.21.
    const p = computePricing(seasonal({ normal_price: 40101, discount: 0, addons: [] }));
    assert.equal(p.recurring_payment, 8020);
    assert.equal(p.first_payment, 8021);
    assert.equal(p.first_payment + 4 * p.recurring_payment, 40101);
    // Tax is summed per payment: 1043 + 4 × 1043 (8020 × 13% = 1042.6 → 1043).
    assert.equal(p.commitment_tax, 1043 + 4 * 1043);
  });

  it('doubles the commitment for two seasons', () => {
    const p = computePricing(seasonal({ seasons: 2 }));
    assert.equal(p.payments_count, 10);
    assert.equal(p.commitment_subtotal, 110000);
    assert.equal(p.commitment_total, 124300);
  });

  it('takes a YIA season as one payment up front', () => {
    const p = computePricing(seasonal({ plan_kind: 'seasonal_yia' }));
    assert.equal(p.first_payment, 55000);
    assert.equal(p.first_payment_tax, 7150);
    assert.equal(p.recurring_payment, 0);
    assert.equal(p.payments_count, 1);
    assert.equal(p.commitment_total, 62150);
  });

  it('bills month to month at the monthly price', () => {
    const p = computePricing(
      seasonal({ plan_kind: 'monthly_recurring', normal_price: 15000, discount: 0, addons: [] }),
    );
    assert.equal(p.unit, 'month');
    assert.equal(p.first_payment, 15000);
    assert.equal(p.recurring_payment, 15000);
    assert.equal(p.recurring_total, 16950);
    assert.equal(p.payments_count, null);
  });

  it('refuses a discount larger than the price', () => {
    assert.throws(() => computePricing(seasonal({ discount: 70000 })), PricingError);
  });
});

describe('payment schedule', () => {
  it('runs November to March for a pre-season sign-up', () => {
    const t = terms();
    const schedule = paymentSchedule(t, computePricing(seasonal()));
    assert.deepEqual(
      schedule.map((e) => [e.label, e.due_on, e.total]),
      [
        ['NOV', '2026-11-01', 12430],
        ['DEC', '2026-12-01', 12430],
        ['JAN', '2027-01-01', 12430],
        ['FEB', '2027-02-01', 12430],
        ['MAR', '2027-03-01', 12430],
      ],
    );
    assert.ok(schedule.every((e) => e.period_end > e.due_on));
  });

  it('bills the first payment on the day of an in-season sign-up', () => {
    const schedule = paymentSchedule(terms({ signed_on: '2026-12-10' }), computePricing(seasonal()));
    assert.deepEqual(
      schedule.map((e) => e.due_on),
      ['2026-12-10', '2027-01-01', '2027-02-01', '2027-03-01', '2027-04-01'],
    );
  });

  it('shows two seasons for a two-season commitment', () => {
    const schedule = paymentSchedule(terms({ seasons: 2 }), computePricing(seasonal({ seasons: 2 })));
    assert.equal(schedule.length, 10);
    assert.deepEqual(
      schedule.map((e) => e.season),
      [0, 0, 0, 0, 0, 1, 1, 1, 1, 1],
    );
    assert.equal(schedule[5]?.due_on, '2027-11-01');
    assert.ok(schedule.every((e) => !e.renewal));
  });

  it('is a single paid-in-full payment for YIA', () => {
    const t = terms({ plan_kind: 'seasonal_yia' });
    const schedule = paymentSchedule(t, computePricing(seasonal({ plan_kind: 'seasonal_yia' })));
    assert.equal(schedule.length, 1);
    assert.equal(schedule[0]?.label, 'PAID IN FULL');
    // Due at signing, not on November 1st: it is paid in advance.
    assert.equal(schedule[0]?.due_on, '2026-10-09');
    assert.equal(schedule[0]?.period_end, '2027-03-31');
    assert.equal(schedule[0]?.total, 62150);
    // A referral credit "per month" is earned for the five months it covers.
    assert.equal(schedule[0]?.months, 5);
  });

  it('renews on the same schedule when billing runs past the commitment', () => {
    const p = computePricing(seasonal());
    const due = paymentSchedule(terms(), p, '2027-12-15');
    assert.equal(due.length, 7);
    assert.deepEqual(
      due.slice(5).map((e) => [e.due_on, e.renewal]),
      [
        ['2027-11-01', true],
        ['2027-12-01', true],
      ],
    );
  });

  it('stops at the commitment when it does not auto-renew', () => {
    const due = paymentSchedule(terms({ auto_renew: false }), computePricing(seasonal()), '2028-06-01');
    assert.equal(due.length, 5);
  });

  it('only bills what has fallen due', () => {
    const due = paymentSchedule(terms(), computePricing(seasonal()), '2026-12-31');
    assert.deepEqual(
      due.map((e) => e.due_on),
      ['2026-11-01', '2026-12-01'],
    );
  });

  it('bills a recurring monthly plan every month of the season', () => {
    const input = seasonal({ plan_kind: 'monthly_recurring', normal_price: 15000, discount: 0, addons: [] });
    const schedule = paymentSchedule(terms({ plan_kind: 'monthly_recurring' }), computePricing(input));
    assert.deepEqual(
      schedule.map((e) => e.label),
      ['NOV', 'DEC', 'JAN', 'FEB', 'MAR'],
    );
    assert.ok(schedule.every((e) => e.amount === 15000));
  });

  it('bills a one-time month once, and never renews it', () => {
    const input = seasonal({ plan_kind: 'monthly_one_time', normal_price: 20000, discount: 0, addons: [] });
    const schedule = paymentSchedule(terms({ plan_kind: 'monthly_one_time' }), computePricing(input), '2030-01-01');
    assert.equal(schedule.length, 1);
    assert.equal(schedule[0]?.due_on, '2026-11-01');
  });
});

describe('agreement dates', () => {
  it('prints the signing date the way the agreement does', () => {
    assert.equal(agreementDateLabel('2026-10-09'), '09 Of Oct 2026');
  });

  it('picks the coming season from April on', () => {
    assert.deepEqual(defaultSeason('2026-10-09'), { season_start: '2026-11-01', season_end: '2027-03-31' });
    assert.deepEqual(defaultSeason('2027-01-15'), { season_start: '2026-11-01', season_end: '2027-03-31' });
  });
});
