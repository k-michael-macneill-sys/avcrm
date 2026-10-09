import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { agreementRewrites, PHONE_TYPE_BLANK, termDate, termLength } from '../src/types/agreement';

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
});
