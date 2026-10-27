import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide, isTestCommand } from '../hooks/guard-test-runs.mjs';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../hooks/guard-test-runs.mjs');

function projectWithPhase(phase) {
  const dir = mkdtempSync(join(tmpdir(), 'repo-orch-'));
  if (phase !== undefined) {
    mkdirSync(join(dir, '.claude', 'orchestrator'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'orchestrator', 'phase'), `${phase}\n`);
  }
  return dir;
}

function bash(command, cwd) {
  return { tool_name: 'Bash', tool_input: { command }, cwd };
}

test('recognises common test runners', () => {
  for (const cmd of [
    'pnpm test',
    'pnpm test:url-first',
    'pnpm -r test',
    'npm run test',
    'yarn test',
    'pnpm exec vitest run a.test.ts',
    'npx jest',
    'npx playwright test',
    'pytest -q',
    'go test ./...',
    'cargo test',
    'node --test test/',
  ]) {
    assert.equal(isTestCommand(cmd), true, cmd);
  }
});

test('does not treat builds, installs or lint as test runs', () => {
  for (const cmd of [
    'pnpm build',
    'pnpm install',
    'pnpm typecheck',
    'pnpm lint',
    'npx playwright install chromium',
    'git status',
  ]) {
    assert.equal(isTestCommand(cmd), false, cmd);
  }
});

test('allows everything when no orchestrator phase file exists', () => {
  const dir = projectWithPhase(undefined);
  assert.equal(decide(bash('pnpm test', dir), {}).allow, true);
  rmSync(dir, { recursive: true, force: true });
});

test('blocks test runners in the implementation and readiness phases', () => {
  for (const phase of ['implementation', 'readiness']) {
    const dir = projectWithPhase(phase);
    const verdict = decide(bash('pnpm exec vitest run x.test.ts', dir), {});
    assert.equal(verdict.allow, false, phase);
    assert.match(verdict.reason, new RegExp(phase));
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allows test runners in the verification phase and non-test commands during implementation', () => {
  const verification = projectWithPhase('verification');
  assert.equal(decide(bash('pnpm test', verification), {}).allow, true);
  rmSync(verification, { recursive: true, force: true });

  const implementation = projectWithPhase('implementation');
  assert.equal(decide(bash('pnpm build', implementation), {}).allow, true);
  assert.equal(decide({ tool_name: 'Edit', tool_input: { file_path: 'a.ts' } }, {}).allow, true);
  rmSync(implementation, { recursive: true, force: true });
});

test('CLAUDE_PROJECT_DIR takes precedence over the hook input cwd', () => {
  const phased = projectWithPhase('implementation');
  const empty = projectWithPhase(undefined);
  const verdict = decide(bash('pnpm test', empty), { CLAUDE_PROJECT_DIR: phased });
  assert.equal(verdict.allow, false);
  rmSync(phased, { recursive: true, force: true });
  rmSync(empty, { recursive: true, force: true });
});

test('hook process exits 2 with a reason when blocking, 0 otherwise', () => {
  const dir = projectWithPhase('implementation');
  const blocked = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(bash('npm test', dir)),
    encoding: 'utf8',
  });
  assert.equal(blocked.status, 2);
  assert.match(blocked.stderr, /blocked during the "implementation" phase/);

  const allowed = spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify(bash('pnpm build', dir)),
    encoding: 'utf8',
  });
  assert.equal(allowed.status, 0);
  rmSync(dir, { recursive: true, force: true });
});

test('fails open on malformed input so it never breaks a session', () => {
  const result = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
  assert.equal(result.status, 0);
});
