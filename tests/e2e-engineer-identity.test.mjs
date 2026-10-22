// The e2e-engineer copies the fingerprint, route and telemetry modules from backend-engineer, because
// plugins cannot share code. This test fails if a copy drifts, so a fix to one is carried to the other
// on purpose.

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

test('the e2e-engineer route module is byte-identical to backend-engineer\'s', () => {
  const source = readFileSync(join(ROOT, 'backend-engineer/scripts/route.mjs'));
  const copy = readFileSync(join(ROOT, 'e2e-engineer/scripts/route.mjs'));
  assert.equal(copy.equals(source), true, 'copy drifted from backend-engineer/scripts/route.mjs');
});

test('the e2e-engineer telemetry module matches backend-engineer\'s, apart from the plugin name', () => {
  const source = readFileSync(join(ROOT, 'backend-engineer/scripts/telemetry.mjs'), 'utf8');
  const copy = readFileSync(join(ROOT, 'e2e-engineer/scripts/telemetry.mjs'), 'utf8');
  assert.equal(copy, source.replaceAll('backend-engineer', 'e2e-engineer'), 'copy drifted from backend-engineer/scripts/telemetry.mjs');
});
