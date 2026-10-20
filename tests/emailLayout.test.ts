import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { describe, it } from 'node:test';
import { LOGO_PATH, renderEmailHtml } from '../src/services/emailLayout';
import { QUOTE_EMAIL } from '../src/types/quoteEmail';

describe('the branded email layout', () => {
  const render = (body: string): string => renderEmailHtml(body, { subject: 'Test', branchName: 'Regina' });

  it('finds the logo it attaches', () => {
    assert.ok(existsSync(LOGO_PATH), LOGO_PATH);
  });

  it('turns the plain-text conventions into formatting', () => {
    const html = render(
      [
        'Hi Harold,',
        '',
        'What happens next',
        '',
        '- One',
        '- Two',
        '',
        '1. First',
        '2. Second',
        '',
        'First month: $129.00',
        'Each month after: $109.00',
        '',
        '→ Review and accept your quote: https://crm.test/app/sign/abc',
        '',
        'Unsubscribe here: https://crm.test/u/1',
      ].join('\n'),
    );

    assert.match(html, /<h2[^>]*>What happens next<\/h2>/);
    assert.match(html, /<ul[^>]*><li[^>]*>One<\/li><li[^>]*>Two<\/li><\/ul>/);
    assert.match(html, /<ol[^>]*><li[^>]*>First<\/li>/);
    assert.match(html, /<td[^>]*>First month<\/td><td[^>]*>\$129\.00<\/td>/);
    assert.match(html, /<a href="https:\/\/crm\.test\/app\/sign\/abc"[^>]*>Review and accept your quote<\/a>/);
    // A lone "label: link" line is a link, not a table or a button.
    assert.match(html, /Unsubscribe here: <a href="https:\/\/crm\.test\/u\/1"/);
    assert.doesNotMatch(html, /<h2[^>]*>Hi Harold/);
    assert.match(html, /Drift Property Services – Regina/);
  });

  it('escapes what customers and staff typed', () => {
    const html = render('Hi <script>alert(1)</script> & co,\n\nNotes: "quoted"\nGate: <b>1234</b>');
    assert.doesNotMatch(html, /<script>|<b>/);
    assert.match(html, /&lt;script&gt;/);
  });

  it('draws the quote email’s summary as a table', () => {
    const body = QUOTE_EMAIL.body
      .replace('{{quote_summary}}', 'Property: 1 Main St, Regina\nYour price: $550.00')
      .replace('{{quote_url}}', 'https://crm.test/app/sign/abc');
    const html = render(body);
    assert.match(html, /<td[^>]*>Your price<\/td>/);
    assert.match(html, /<h2[^>]*>Your quote<\/h2>/);
    assert.match(html, />Review and accept your quote<\/a>/);
  });
});
