// The model each agent runs on is a decision, backed by the blind comparison in the PR that set it.
// Changing a model here means re-running that comparison first.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const modelOf = (rel) => {
  const match = readFileSync(join(ROOT, rel), 'utf8').match(/^model: (\S+)$/m);
  return match ? match[1] : null;
};

const EXPECTED = {
  'security-audit/agents/secrets-scanner.md': 'haiku',
  'security-audit/agents/access-control-reviewer.md': 'sonnet',
  'security-audit/agents/input-handler-reviewer.md': 'sonnet',
  'e2e-engineer/agents/rbac-analyst.md': 'sonnet',
  'e2e-engineer/agents/ux-analyst.md': 'sonnet',
  'e2e-engineer/agents/test-strategist.md': 'sonnet',
  'e2e-engineer/agents/flow-analyst.md': 'opus',
  'e2e-engineer/agents/triage.md': 'opus',
};

for (const [rel, model] of Object.entries(EXPECTED)) {
  test(`${rel} runs on ${model}`, () => {
    assert.equal(modelOf(rel), model);
  });
}
