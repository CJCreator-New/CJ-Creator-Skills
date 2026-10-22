// The e2e-engineer copies the fingerprint module from backend-engineer, because plugins cannot share
// code. This test fails if the copy drifts, so a fix to one is carried to the other on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

test('the e2e-engineer fingerprint module is byte-identical to backend-engineer\'s', () => {
  const source = readFileSync(join(ROOT, 'backend-engineer/scripts/fingerprint.mjs'));
  const copy = readFileSync(join(ROOT, 'e2e-engineer/scripts/fingerprint.mjs'));
  assert.equal(copy.equals(source), true, 'copy drifted from backend-engineer/scripts/fingerprint.mjs');
});
