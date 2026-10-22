import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');

test('plugin structure, agents, hooks, the example ledger and the marketplace entry validate', () => {
  const result = spawnSync(process.execPath, [resolve(PLUGIN, 'scripts/validate.mjs')], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
