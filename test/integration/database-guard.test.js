import assert from 'node:assert/strict';
import test from 'node:test';

import { requireTestDatabaseUrl } from './database.js';

test('database verification refuses absent, malformed and non-test targets without leaking credentials', () => {
  for (const value of ['', ' ', 'malformed', 'postgresql://user:secret@localhost/gpss', 'file:///tmp/gpss_test']) {
    assert.throws(() => requireTestDatabaseUrl(value), (error) => {
      assert.doesNotMatch(error.message, /secret/);
      return true;
    });
  }
  assert.throws(() => requireTestDatabaseUrl('postgresql://user:secret@localhost/test%2Fproduction'));
  assert.equal(requireTestDatabaseUrl('postgresql://user:secret@localhost/gpss_test'),
    'postgresql://user:secret@localhost/gpss_test');
});
