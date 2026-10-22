import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  checkGate,
  diffHash,
  emptyState,
  isCurrent,
  latestRun,
  main,
  parseRun,
  recordIteration,
  runCheck,
  saveState,
  upsertPackage,
  writeOwnership,
  ownershipPath,
} from '../scripts/gates.mjs';
import { overlaps } from '../scripts/ownership.mjs';

const H = 'hash-1';

function withDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'fe-gates-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const passingRun = (name, scope = 'focused', extra = {}) => ({
  name,
  scope,
  command: `npm run ${name}`,
  exitCode: 0,
  hashBefore: H,
  hashAfter: H,
  tail: '',
  ...extra,
});

// A state that passes every gate when the working tree hash is H and the owned file exists.
function passingState() {
  return {
    ...emptyState(),
    matrix: [
      {
        id: 'R-01',
        requirement: 'Filter narrows rows',
        files: ['src/a.ts'],
        tests: ['src/a.test.ts'],
        status: 'verified',
        evidence: ['.claude/frontend-engineer/evidence/r01.png'],
      },
    ],
    packages: [{ id: 'p1', owned: ['src/a.ts'] }],
    runs: [
      passingRun('lint'),
      passingRun('typecheck'),
      passingRun('build'),
      passingRun('test', 'full'),
    ],
    visual: { status: 'passing', reason: '', viewports: [{ name: 'desktop' }], iterations: 1, remaining: [] },
    review: { verdict: 'passed' },
  };
}

function ctxFor(dir, { hash = H, exists = () => true } = {}) {
  return { projectDir: dir, hash, exists };
}

// Writes ownership.json for the state's packages, so gate 1's file check can pass.
function withOwnership(dir, state) {
  writeOwnership(dir, state);
  return state;
}

test('overlap: identical paths, folder containing a file, and name prefixes', () => {
  assert.equal(overlaps('src/a.ts', 'src/a.ts'), true);
  assert.equal(overlaps('src/a/', 'src/a/b.ts'), true);
  assert.equal(overlaps('src/', 'src/a/'), true);
  assert.equal(overlaps('src/a', 'src/ab.ts'), false);
  assert.equal(overlaps('src/a/', 'src/b/'), false);
});

test('parseRun reads the name, flags and command after "--"', () => {
  assert.deepEqual(parseRun(['test', '--scope', 'full', '--', 'npm', 'test']), {
    name: 'test',
    scope: 'full',
    cwd: undefined,
    command: 'npm test',
  });
  assert.throws(() => parseRun(['lint']), /needs a name and a command/);
  assert.throws(() => parseRun(['lint', '--']), /needs a name and a command/);
  assert.throws(() => parseRun(['test', '--scope', 'nightly', '--', 'x']), /scope must be one of/);
  assert.throws(() => parseRun(['test', '--bogus', 'x', '--', 'x']), /unknown run option/);
});

test('upsertPackage replaces a package by id and rejects empty ownership', () => {
  const state = emptyState();
  upsertPackage(state, 'p1', ['src/a.ts']);
  upsertPackage(state, 'p1', ['src/b.ts', 'src/a.ts']);
  assert.equal(state.packages.length, 1);
  assert.deepEqual(state.packages[0].owned, ['src/a.ts', 'src/b.ts']);
  assert.throws(() => upsertPackage(state, 'p2', []), /needs at least one path/);
});

test('gate 1 passes with a consistent plan', () => {
  withDir((dir) => {
    const state = withOwnership(dir, passingState());
    assert.deepEqual(checkGate(1, state, ctxFor(dir)), { gate: 1, ok: true, failures: [] });
  });
});

test('gate 1 fails when two packages own overlapping paths', () => {
  withDir((dir) => {
    const state = passingState();
    state.packages.push({ id: 'p2', owned: ['src/'] });
    withOwnership(dir, state);
    const result = checkGate(1, state, ctxFor(dir));
    assert.equal(result.ok, false);
    assert.match(result.failures.join('\n'), /p1 and p2 both own/);
  });
});

test('gate 1 fails when a matrix file is not owned by any package', () => {
  withDir((dir) => {
    const state = passingState();
    state.matrix[0].files.push('src/unowned.ts');
    withOwnership(dir, state);
    assert.match(checkGate(1, state, ctxFor(dir)).failures.join('\n'), /src\/unowned\.ts is not owned/);
  });
});

test('gate 1 fails when ownership.json was not generated from the plan', () => {
  withDir((dir) => {
    const state = passingState();
    assert.match(checkGate(1, state, ctxFor(dir)).failures.join('\n'), /ownership\.json does not match/);
    mkdirSync(join(dir, '.claude', 'frontend-engineer'), { recursive: true });
    writeFileSync(ownershipPath(dir), JSON.stringify({ owned: ['src/other.ts'] }));
    assert.match(checkGate(1, state, ctxFor(dir)).failures.join('\n'), /ownership\.json does not match/);
  });
});

test('gate 2 fails on an open handoff', () => {
  withDir((dir) => {
    const state = passingState();
    state.handoffs.push({ from: 'implementer', file: 'src/routes.ts', change: 'add route', resolved: false });
    const result = checkGate(3, state, ctxFor(dir));
    assert.match(result.failures.join('\n'), /open handoff from implementer/);
  });
});

test('gate 2 fails when lint or typecheck has no run', () => {
  withDir((dir) => {
    const state = passingState();
    state.runs = state.runs.filter((r) => r.name !== 'lint');
    assert.match(checkGate(2, state, ctxFor(dir)).failures.join('\n'), /no "lint" run recorded/);
  });
});

test('a failing run blocks the gate that needs it', () => {
  withDir((dir) => {
    const state = passingState();
    state.runs.push({ ...passingRun('typecheck'), exitCode: 2 });
    assert.match(checkGate(2, state, ctxFor(dir)).failures.join('\n'), /"typecheck" failed \(exit 2\)/);
  });
});

test('a passing run goes stale when the changes move on', () => {
  withDir((dir) => {
    const state = passingState();
    const result = checkGate(2, state, ctxFor(dir, { hash: 'hash-2' }));
    assert.match(result.failures.join('\n'), /modified after it ran/);
  });
});

test('gate 3 fails on a row that is not implemented', () => {
  withDir((dir) => {
    const state = passingState();
    state.matrix[0].status = 'not started';
    assert.match(checkGate(3, state, ctxFor(dir)).failures.join('\n'), /R-01: status is "not started"/);
  });
});

test('gate 4 fails on a verified row without evidence, or with missing evidence on disk', () => {
  withDir((dir) => {
    const state = passingState();
    state.matrix[0].evidence = [];
    assert.match(checkGate(4, state, ctxFor(dir)).failures.join('\n'), /verified with no visual evidence/);

    const state2 = passingState();
    assert.match(
      checkGate(4, state2, ctxFor(dir, { exists: () => false })).failures.join('\n'),
      /evidence file does not exist/,
    );
  });
});

test('gate 4 fails when the full test run is missing', () => {
  withDir((dir) => {
    const state = passingState();
    state.runs = state.runs.filter((r) => !(r.name === 'test' && r.scope === 'full'));
    assert.match(checkGate(4, state, ctxFor(dir)).failures.join('\n'), /no full test run recorded/);
  });
});

test('gate 4 accepts a failing full run only with a failing baseline and listed, reasoned failures', () => {
  withDir((dir) => {
    const state = passingState();
    state.runs = state.runs.filter((r) => !(r.name === 'test' && r.scope === 'full'));
    const command = 'npm test';
    state.runs.push({ ...passingRun('test', 'full'), command, exitCode: 1 });
    assert.match(checkGate(4, state, ctxFor(dir)).failures.join('\n'), /full test run failed \(exit 1\)/);

    state.runs.push({ ...passingRun('test', 'baseline'), command, exitCode: 1 });
    assert.match(checkGate(4, state, ctxFor(dir)).failures.join('\n'), /full test run failed/);

    state.allowedFailures = [{ test: 'legacy export', reason: 'fails at base commit too' }];
    assert.equal(checkGate(4, state, ctxFor(dir)).failures.some((f) => /full test run/.test(f)), false);

    state.allowedFailures = [{ test: 'legacy export' }];
    assert.match(checkGate(4, state, ctxFor(dir)).failures.join('\n'), /full test run failed/);
  });
});

test('gate 4 fails when the review has not passed', () => {
  withDir((dir) => {
    const state = passingState();
    state.review = { verdict: 'findings open' };
    assert.match(checkGate(4, state, ctxFor(dir)).failures.join('\n'), /review has not passed \(verdict: findings open\)/);
  });
});

test('gate 4 blocks an incomplete visual run that still has critical or high defects', () => {
  withDir((dir) => {
    const state = passingState();
    state.visual = { status: 'incomplete', reason: '', viewports: [], iterations: 3, remaining: [{ severity: 'high', summary: 'overflow' }] };
    assert.match(checkGate(4, state, ctxFor(dir)).failures.join('\n'), /1 critical or high visual defects remain/);

    state.visual.remaining = [{ severity: 'low', summary: 'shadow' }];
    assert.equal(checkGate(4, state, ctxFor(dir)).ok, true);
  });
});

test('gate 4 requires a reason when visual verification is not performed', () => {
  withDir((dir) => {
    const state = passingState();
    state.visual = { status: 'not performed', reason: '', viewports: [], iterations: 0, remaining: [] };
    assert.match(checkGate(4, state, ctxFor(dir)).failures.join('\n'), /not performed, and no reason/);
  });
});

test('gate 5 checks approval values and that an incomplete visual run lists what remains', () => {
  withDir((dir) => {
    const state = passingState();
    state.approval = 'maybe';
    assert.match(checkGate(5, state, ctxFor(dir)).failures.join('\n'), /approval must be one of/);

    const state2 = passingState();
    state2.visual = { status: 'incomplete', reason: '', viewports: [], iterations: 3, remaining: [] };
    assert.match(checkGate(5, state2, ctxFor(dir)).failures.join('\n'), /incomplete, but no remaining defects/);
  });
});

test('a complete state passes every gate', () => {
  withDir((dir) => {
    const state = withOwnership(dir, passingState());
    for (const gate of [1, 2, 3, 4, 5]) {
      assert.equal(checkGate(gate, state, ctxFor(dir)).ok, true, `gate ${gate}`);
    }
  });
});

test('checkGate rejects a gate outside 1 to 5', () => {
  assert.throws(() => checkGate(6, passingState(), ctxFor('/tmp')), /gate must be 1 to 5/);
});

test('recordIteration stops at the limit', () => {
  const state = emptyState();
  assert.equal(recordIteration(state, 2), 1);
  assert.equal(recordIteration(state, 2), 2);
  assert.throws(() => recordIteration(state, 2), /visual iteration limit reached \(2\)/);
});

test('runCheck records the real exit code, output tail and hashes of the command', () => {
  withDir((dir) => {
    const state = emptyState();
    const entry = runCheck(state, {
      name: 'lint',
      scope: 'focused',
      command: `node -e "console.log('clean'); process.exit(3)"`,
      cwd: dir,
      hash: () => H,
    });
    assert.equal(entry.exitCode, 3);
    assert.match(entry.tail, /clean/);
    assert.equal(entry.hashBefore, H);
    assert.equal(entry.hashAfter, H);
    assert.equal(isCurrent(entry, H), false);
    assert.equal(latestRun(state, 'lint'), entry);
  });
});

test('isCurrent needs a passing run against the current hash', () => {
  assert.equal(isCurrent(passingRun('lint'), H), true);
  assert.equal(isCurrent(passingRun('lint'), 'other'), false);
  assert.equal(isCurrent(passingRun('lint'), null), false);
  assert.equal(isCurrent({ ...passingRun('lint'), exitCode: 1 }, H), false);
  assert.equal(isCurrent(undefined, H), false);
});

test('diffHash changes with tracked edits and new files, and ignores the .claude folder', () => {
  withDir((dir) => {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');

    const clean = diffHash(dir);
    assert.ok(clean);

    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    const edited = diffHash(dir);
    assert.notEqual(edited, clean);

    writeFileSync(join(dir, 'src', 'new.ts'), 'export const n = 1;\n');
    assert.notEqual(diffHash(dir), edited);

    const before = diffHash(dir);
    mkdirSync(join(dir, '.claude', 'frontend-engineer'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'frontend-engineer', 'state.json'), '{}');
    assert.equal(diffHash(dir), before);
  });
});

test('diffHash is null outside a git repository', () => {
  withDir((dir) => {
    assert.equal(diffHash(dir), null);
  });
});

test('CLI: init, package, ownership and check run against the state file', () => {
  withDir((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    assert.equal(main(['init'], env).code, 0);
    assert.equal(existsSync(join(dir, '.claude', 'frontend-engineer', 'state.json')), true);
    assert.equal(main(['package', 'p1', 'src/a.ts'], env).code, 0);
    assert.equal(main(['ownership'], env).code, 0);
    assert.equal(existsSync(ownershipPath(dir)), true);

    const check = main(['check', '1'], env);
    assert.equal(check.code, 1);
    assert.match(check.out, /traceability matrix is empty/);
  });
});

test('CLI: finish refuses to end a run that fails gate 5, and abort always ends it', () => {
  withDir((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    saveState(dir, emptyState());
    writeOwnership(dir, { packages: [{ id: 'p1', owned: ['src/a.ts'] }] });

    const refused = main(['finish'], env);
    assert.equal(refused.code, 1);
    assert.equal(existsSync(ownershipPath(dir)), true);

    assert.equal(main(['abort'], env).code, 0);
    assert.equal(existsSync(ownershipPath(dir)), false);
  });
});

test('CLI: run records the command and exits with its status', () => {
  withDir((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    const result = main(['run', 'build', '--', `node -e "process.exit(4)"`], env);
    assert.equal(result.code, 1);
    assert.match(result.out, /build \[focused\] failed \(exit 4\)/);
  });
});
