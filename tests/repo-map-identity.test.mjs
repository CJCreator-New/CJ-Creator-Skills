// Plugins cannot share code, so each plugin that maps a repository keeps its own copy of the shared repo
// map. This test fails when a copy drifts from backend-engineer's, so a fix is carried to every copy on purpose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(ROOT, 'backend-engineer/scripts/repo-map.mjs'));

for (const plugin of ['e2e-engineer', 'frontend-engineer']) {
  test(`${plugin} repo-map.mjs is byte-identical to backend-engineer's`, () => {
    const copy = readFileSync(join(ROOT, plugin, 'scripts/repo-map.mjs'));
    assert.equal(copy.equals(source), true, `${plugin}/scripts/repo-map.mjs drifted from backend-engineer/scripts/repo-map.mjs`);
  });
}
