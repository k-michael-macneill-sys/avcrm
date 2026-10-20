import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MESSAGE_TEMPLATES } from '../src/db/appConfig';
import { TEMPLATE_CODES } from '../src/types/models';

describe('the installed configuration', () => {
  // A code with no default is an error the first time anything sends it, as
  // "No email template for signing_request" was on a live install.
  it('has a default template for every code the application sends', () => {
    const installed = new Set(MESSAGE_TEMPLATES.filter((t) => t.branch_id === null).map((t) => t.code));
    const missing = TEMPLATE_CODES.filter((code) => !installed.has(code));
    assert.deepEqual(missing, []);
  });
});
