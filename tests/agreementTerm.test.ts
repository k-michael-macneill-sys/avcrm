import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agreementDate, agreementRewrites, branchPlace, PHONE_TYPE_BLANK, termDate, termLength } from '../src/types/agreement';

describe('the agreement term', () => {
  it('describes an exact-dates term the way the agreement words the season', () => {
    assert.equal(termDate('2026-12-01'), 'December 1st, 2026');
    assert.equal(termDate('2027-01-22'), 'January 22nd, 2027');
    assert.equal(termDate('2027-01-11'), 'January 11th, 2027');
    assert.equal(termLength('2026-11-01', '2027-03-31'), 'five (5) months');
    assert.equal(termLength('2026-12-01', '2027-01-31'), 'two (2) months');
    assert.equal(termLength('2026-12-15', '2027-01-15'), 'one (1) month');
    assert.equal(termLength('2026-12-01', '2026-12-20'), '20 days');
  });

  it('rewords the November-to-March lines when the term has dates, and always covers the phone type', () => {
    const terms = (values: Parameters<typeof agreementRewrites>[0]) => agreementRewrites(values).filter((l) => l.term);
    // An older seasonal agreement, with its two-digit years, prints as it is.
    assert.deepEqual(terms({ term_type: 'Seasonal', start_year: '26', end_year: '27' }), []);
    assert.deepEqual(terms({ start_year: '26', end_year: '27' }), [], 'older agreements are seasonal');
    assert.deepEqual(agreementRewrites({ start_year: '26', end_year: '27' }), [PHONE_TYPE_BLANK]);

    const lines = agreementRewrites({ term_type: 'Exact dates', term_start: '2026-12-01', term_end: '2027-01-31' });
    assert.equal(
      lines.find((l) => l.term)?.text,
      'This Agreement begins on December 1st, 2026 and ends on January 31st, 2027, a service period of two (2) months.',
    );
    assert.equal(lines.length, 4);
    assert.ok(lines.every((l) => !/November|March/.test(l.text)));

    // A seasonal term signed now carries its dates, and says them.
    const season = agreementRewrites({ term_type: 'Seasonal', term_start: '2026-12-15', term_end: '2027-03-31' });
    assert.equal(
      season.find((l) => l.term)?.text,
      'This Agreement begins on December 15th, 2026 and ends on March 31st, 2027, a service period of 107 days.',
    );
  });

  it('says which branch is serving, where the template says Kingston', () => {
    assert.equal(branchPlace({ name: 'Alberta', province: 'AB' }), 'Alberta');
    assert.equal(branchPlace({ name: 'Regina', province: 'SK' }), 'Regina, Saskatchewan');
    assert.equal(branchPlace({ name: 'Cranbrook', province: 'BC' }), 'Cranbrook, British Columbia');

    const seasonal = { term_type: 'Seasonal', start_year: '26', end_year: '27' };
    const lines = (name: string, province: string) =>
      agreementRewrites(seasonal, { name, province })
        .map((l) => l.text)
        .filter((text) => text && !text.includes('governed'));
    assert.deepEqual(lines('Alberta', 'AB'), ['Serving Alberta', ' (Alberta)  (the “Contractor”)']);
    assert.deepEqual(lines('Regina', 'SK'), [
      'Serving Regina, Saskatchewan',
      ' (Regina, Saskatchewan)  (the “Contractor”)',
    ]);
    assert.deepEqual(lines('Kingston', 'ON'), [], 'the template is already Kingston’s');
    assert.deepEqual(agreementRewrites(seasonal, null), [PHONE_TYPE_BLANK]);
  });

  it('prints the branch’s own phone and email in the header, Kingston’s included', () => {
    const seasonal = { term_type: 'Seasonal', start_year: '26', end_year: '27' };
    const kingston = { name: 'Kingston', province: 'ON', phone: '(519) 221-6191', email: 'm.macneill@drift-ps.com' };
    assert.deepEqual(
      agreementRewrites(seasonal, kingston).map((l) => l.text).filter(Boolean),
      ['Phone: (519) 221-6191', 'Email: m.macneill@drift-ps.com'],
    );
    const regina = { name: 'Regina', province: 'SK', phone: '(306) 570-5877', email: 'Carter.o@drift-ps.com' };
    assert.deepEqual(agreementRewrites(seasonal, regina).map((l) => l.text).filter(Boolean).slice(0, 4), [
      'Phone: (306) 570-5877',
      'Email: Carter.o@drift-ps.com',
      'This Agreement is governed by the laws of the Province of Saskatchewan, without regard to its conflict of law principles.',
      'Serving Regina, Saskatchewan',
    ]);
  });

  it('words the governing law for the branch’s province', () => {
    const seasonal = { term_type: 'Seasonal', start_year: '26', end_year: '27' };
    const law = (province: string) =>
      agreementRewrites(seasonal, { name: 'X', province }).find((l) => l.text.includes('governed'))?.text;
    assert.equal(
      law('AB'),
      'This Agreement is governed by the laws of the Province of Alberta, without regard to its conflict of law principles.',
    );
    assert.match(law('BC') ?? '', /Province of British Columbia,/);
    assert.equal(law('ON'), undefined, 'the template already says Ontario');
  });

  it('dates a signature by the branch’s own calendar', () => {
    // 11:30pm in Regina on 9 December is already 10 December in Ontario.
    const late = new Date('2026-12-10T05:30:00Z');
    assert.equal(agreementDate(late, 'America/Regina'), '09/Dec/2026');
    assert.equal(agreementDate(late), '10/Dec/2026');
  });
});

