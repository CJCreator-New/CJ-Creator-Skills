import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { recordRun } from '../scripts/ledger.mjs';

// Commands that succeed. Tests declare these as the project's commands, so runs can execute.
export const PASS = 'node -e "process.exit(0)"';
export const COMMANDS = {
  test: PASS,
  testFocused: PASS,
  regression: PASS,
  e2e: PASS,
  lint: PASS,
  typecheck: PASS,
  build: PASS,
};

// A UI inventory with no sites, so a ledger with no interaction sites is not partial for lack of one.
export const emptyInventory = (ledger) => {
  ledger.inventory = { recordedAt: new Date(0).toISOString(), files: {} };
  return ledger;
};

// A ledger with the passing commands declared, so that runs can be recorded.
export const declare = (ledger, overrides = {}) => {
  ledger.project = { ...ledger.project, commands: { ...COMMANDS, ...overrides } };
  return ledger;
};

const SCOPE_NAME = { focused: 'testFocused', regression: 'regression', e2e: 'e2e', full: 'test' };

// Records a passing run for the scope, with the declared command for that scope.
export function passingRun(ledger, ctx, { journeyIds = [], gapIds = [], scope = 'focused' } = {}) {
  const name = SCOPE_NAME[scope];
  return recordRun(ledger, ctx, { name, scope, command: ledger.project.commands[name], journeyIds, gapIds });
}

// A repository with one committed file under src/feature/, so journeys can depend on that path.
// The directory is removed only after fn finishes, including when fn is async.
export function withRepo(fn, { files = { 'src/feature/a.ts': 'export const a = 1;\n' } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'be-test-'));
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(dir, file, '..'), { recursive: true });
      writeFileSync(join(dir, file), content);
    }
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
    const result = fn(dir);
    if (result && typeof result.then === 'function') return result.finally(cleanup);
    cleanup();
    return result;
  } catch (err) {
    cleanup();
    throw err;
  }
}
