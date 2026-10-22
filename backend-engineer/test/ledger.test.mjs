import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { pathsHash, treeHash } from '../scripts/fingerprint.mjs';
import {
  addItem,
  emptyLedger,
  gapTransition,
  journeyState,
  loadLedger,
  main,
  makeContext,
  recordReview,
  recordRun,
  releaseStatus,
  setItem,
  validateLedger,
  parseRun,
  ledgerPath,
  ownershipPath,
} from '../scripts/ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = JSON.parse(readFileSync(resolve(HERE, '../examples/ledger.example.json'), 'utf8'));
const { _comment, ...EXAMPLE_LEDGER } = EXAMPLE;
const GIT = ['-c', 'user.name=t', '-c', 'user.email=t@example.com'];

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'be-ledger-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    mkdirSync(join(dir, 'src', 'feature'), { recursive: true });
    writeFileSync(join(dir, 'src', 'feature', 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git(...GIT, 'commit', '-q', '-m', 'base');
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const passingRun = (ledger, ctx, journeyIds = [], gapIds = [], scope = 'focused') =>
  recordRun(ledger, ctx, { name: 'test', scope, command: 'node -e "process.exit(0)"', cwd: ctx.projectDir, journeyIds, gapIds });

// A ledger in which the single journey is fully verified and the release is complete.
function completeLedger(dir) {
  const ledger = emptyLedger();
  addItem(ledger, 'requirements', { source: 'confirmed', priority: 'high', text: 'Feature works.', status: 'implemented' });
  addItem(ledger, 'journeys', {
    requirementIds: ['R-01'],
    role: 'user',
    start: 'start',
    steps: [{ ui: 'button' }],
    outcomeSuccess: 'done',
    dependsOn: ['src/feature/'],
    priority: 'high',
    status: 'implemented',
  });
  const ctx = makeContext(dir);
  passingRun(ledger, ctx, ['J-01']);
  passingRun(ledger, ctx, [], [], 'full');
  recordReview(ledger, ctx, { verdict: 'passed' });
  return ledger;
}

test('the example ledger is valid and its release is not Complete', () => {
  assert.deepEqual(validateLedger(EXAMPLE_LEDGER), []);
  withRepo((dir) => {
    const release = releaseStatus(EXAMPLE_LEDGER, makeContext(dir));
    assert.equal(release.status, 'Blocked');
    assert.match(release.blockers.join('\n'), /D-01 is open/);
  });
});

test('ids are assigned in order, and a supplied id or an evidence add is refused', () => {
  const ledger = emptyLedger();
  assert.equal(addItem(ledger, 'requirements', { source: 'confirmed', priority: 'high', text: 'x' }).id, 'R-01');
  assert.equal(addItem(ledger, 'requirements', { source: 'confirmed', priority: 'low', text: 'y' }).id, 'R-02');
  assert.throws(() => addItem(ledger, 'requirements', { id: 'R-09' }), /ids are assigned/);
  assert.throws(() => addItem(ledger, 'evidence', {}), /recorded by run or review/);
  assert.throws(() => addItem(ledger, 'gaps', { status: 'Closed' }), /starts at Detected/);
});

test('a gap status changes only through the gap command', () => {
  const ledger = emptyLedger();
  addItem(ledger, 'gaps', { title: 'Queue stale', severity: 'High', category: 'Frontend' });
  assert.throws(() => setItem(ledger, 'gaps', 'G-01', { status: 'Closed' }), /only through the gap command/);
  assert.throws(() => setItem(ledger, 'evidence', 'E-01', {}), /not set/);
});

test('validation finds broken references, unresolved implementation and missing reasons', () => {
  const ledger = structuredClone(EXAMPLE_LEDGER);
  ledger.journeys[0].requirementIds = ['R-99'];
  ledger.requirements[0].source = 'unresolved';
  ledger.requirements[0].status = 'implemented';
  ledger.interactions[1].reason = undefined;
  ledger.interactions[0].journeyId = undefined;
  const errors = validateLedger(ledger).join('\n');
  assert.match(errors, /J-01: requirementIds references missing R-99/);
  assert.match(errors, /R-01: an unresolved business rule cannot be implemented/);
  assert.match(errors, /I-02: a local interaction needs a reason/);
  assert.match(errors, /I-01: a backend interaction must name its journeyId/);
});

test('validation rejects a gap that skips its required fields for its stage', () => {
  const ledger = structuredClone(EXAMPLE_LEDGER);
  ledger.gaps[0].status = 'Closed';
  const errors = validateLedger(ledger).join('\n');
  assert.match(errors, /G-01: owner is required from Assigned onwards/);
  assert.match(errors, /G-01: acceptance criteria are required to close/);
});

test('validation rejects a journey with no steps or no dependency paths', () => {
  const ledger = structuredClone(EXAMPLE_LEDGER);
  ledger.journeys[0].steps = [];
  ledger.journeys[0].dependsOn = [];
  const errors = validateLedger(ledger).join('\n');
  assert.match(errors, /J-01: steps must list at least one step/);
  assert.match(errors, /J-01: dependsOn must list the paths/);
});

test('the gap lifecycle moves one step at a time and needs what each step requires', () => {
  withRepo((dir) => {
    const ledger = structuredClone(EXAMPLE_LEDGER);
    const ctx = makeContext(dir);
    const gap = ledger.gaps[0];

    let result = gapTransition(ledger, gap, 'Assigned', ctx);
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('\n'), /the next step is Triaged/);

    result = gapTransition(ledger, gap, 'Triaged', ctx);
    assert.equal(result.ok, true);

    gap.status = 'Triaged';
    assert.match(gapTransition(ledger, gap, 'Assigned', ctx).reasons.join('\n'), /set an owner first/);

    gap.status = 'Focused Tests Passed';
    assert.match(gapTransition(ledger, gap, 'Regression Verified', ctx).reasons.join('\n'), /record regressionTests first/);
  });
});

test('a gap can move to Focused Tests Passed only with a current passing run linked to it', () => {
  withRepo((dir) => {
    const ledger = structuredClone(EXAMPLE_LEDGER);
    const ctx = makeContext(dir);
    const gap = ledger.gaps[0];
    gap.status = 'Fix Implemented';
    assert.match(gapTransition(ledger, gap, 'Focused Tests Passed', ctx).reasons.join('\n'), /no current passing run/);

    passingRun(ledger, ctx, ['J-01'], ['G-01']);
    assert.equal(gapTransition(ledger, gap, 'Focused Tests Passed', ctx).ok, true);
  });
});

test('a journey is verified by its current run, stale after its files change, and failed by a failing run', () => {
  withRepo((dir) => {
    const ledger = structuredClone(EXAMPLE_LEDGER);
    ledger.journeys[0].dependsOn = ['src/feature/'];
    ledger.decisions[0].status = 'answered';
    ledger.decisions[0].answer = 'No.';
    const journey = ledger.journeys[0];

    assert.equal(journeyState(ledger, journey, makeContext(dir)), 'planned');

    passingRun(ledger, makeContext(dir), ['J-01']);
    assert.equal(journeyState(ledger, journey, makeContext(dir)), 'verified');

    writeFileSync(join(dir, 'src', 'feature', 'a.ts'), 'export const a = 2;\n');
    assert.equal(journeyState(ledger, journey, makeContext(dir)), 'stale');

    recordRun(ledger, makeContext(dir), { name: 'test', scope: 'e2e', command: 'node -e "process.exit(3)"', cwd: dir, journeyIds: ['J-01'], gapIds: [] });
    assert.equal(journeyState(ledger, journey, makeContext(dir)), 'failed');
  });
});

test('an open decision that blocks a journey makes the journey blocked, whatever its runs say', () => {
  withRepo((dir) => {
    const ledger = structuredClone(EXAMPLE_LEDGER);
    passingRun(ledger, makeContext(dir), ['J-01']);
    assert.equal(journeyState(ledger, ledger.journeys[0], makeContext(dir)), 'blocked');
  });
});

test('release is Complete only when every part of the evidence holds', () => {
  withRepo((dir) => {
    const ledger = completeLedger(dir);
    assert.deepEqual(releaseStatus(ledger, makeContext(dir)), { status: 'Complete', blockers: [], notReady: [], partial: [] });
  });
});

test('release is Not Release Ready for an empty ledger, a missing full run, or a missing review', () => {
  withRepo((dir) => {
    const empty = releaseStatus(emptyLedger(), makeContext(dir));
    assert.equal(empty.status, 'Not Release Ready');
    assert.match(empty.notReady.join('\n'), /no requirements recorded/);

    const ledger = completeLedger(dir);
    ledger.evidence = ledger.evidence.filter((e) => e.kind !== 'review');
    assert.match(releaseStatus(ledger, makeContext(dir)).notReady.join('\n'), /no independent review recorded/);
  });
});

test('release is Not Release Ready when the review is stale after the tree changed', () => {
  withRepo((dir) => {
    const ledger = completeLedger(dir);
    writeFileSync(join(dir, 'src', 'feature', 'a.ts'), 'export const a = 3;\n');
    assert.match(releaseStatus(ledger, makeContext(dir)).notReady.join('\n'), /is stale/);
  });
});

test('release is Not Release Ready for an open Critical gap, and Partially Complete for a Low one', () => {
  withRepo((dir) => {
    const ledger = completeLedger(dir);
    addItem(ledger, 'gaps', { title: 'Data leak', severity: 'Critical', category: 'Authorization' });
    assert.equal(releaseStatus(ledger, makeContext(dir)).status, 'Not Release Ready');

    const minor = completeLedger(dir);
    addItem(minor, 'gaps', { title: 'Typo', severity: 'Low', category: 'Documentation' });
    assert.equal(releaseStatus(minor, makeContext(dir)).status, 'Partially Complete');
  });
});

test('a failing full suite run blocks release only while it is the latest current run', () => {
  withRepo((dir) => {
    const ledger = completeLedger(dir);
    recordRun(ledger, makeContext(dir), { name: 'test', scope: 'full', command: 'node -e "process.exit(1)"', cwd: dir, journeyIds: [], gapIds: [] });
    assert.match(releaseStatus(ledger, makeContext(dir)).notReady.join('\n'), /test \[full\] failed/);
  });
});

test('parseRun reads the scope, the linked ids and the command, and rejects bad input', () => {
  assert.deepEqual(parseRun(['test', '--scope', 'e2e', '--journey', 'J-01,J-02', '--gap', 'G-01', '--', 'npm', 'run', 'e2e']), {
    name: 'test',
    scope: 'e2e',
    journeyIds: ['J-01', 'J-02'],
    gapIds: ['G-01'],
    cwd: undefined,
    command: 'npm run e2e',
  });
  assert.throws(() => parseRun(['test']), /needs a name and a command/);
  assert.throws(() => parseRun(['test', '--scope', 'nightly', '--', 'x']), /scope must be one of/);
  assert.throws(() => parseRun(['test', '--bogus', 'x', '--', 'x']), /unknown run option/);
});

test('fingerprints change with content and ignore the .claude folder', () => {
  withRepo((dir) => {
    const before = pathsHash(dir, ['src/feature/']);
    const tree = treeHash(dir);
    assert.ok(before && tree);
    mkdirSync(join(dir, '.claude', 'backend-engineer'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'backend-engineer', 'ledger.json'), '{}');
    assert.equal(pathsHash(dir, ['src/feature/']), before);
    assert.equal(treeHash(dir), tree);
    writeFileSync(join(dir, 'src', 'feature', 'a.ts'), 'export const a = 9;\n');
    assert.notEqual(pathsHash(dir, ['src/feature/']), before);
  });
});

test('fingerprints are null outside a git repository', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be-nogit-'));
  try {
    assert.equal(pathsHash(dir, ['src/']), null);
    assert.equal(treeHash(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI: add refuses an invalid change and writes nothing', () => {
  withRepo((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    assert.equal(main(['init'], env).code, 0);
    const journey = '{"requirementIds":["R-99"],"role":"u","start":"s","steps":[{"ui":"b"}],"outcomeSuccess":"o","dependsOn":["src/"],"priority":"high"}';
    assert.throws(() => main(['add', 'journeys', journey], env), /requirementIds references missing R-99/);
    assert.equal(loadLedger(dir).journeys.length, 0);
  });
});

test('CLI: run records the exit code and the output tail, and a gap transition is refused without prerequisites', () => {
  withRepo((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    main(['init'], env);
    const result = main(['run', 'build', '--', `node -e "console.log('built'); process.exit(4)"`], env);
    assert.equal(result.code, 1);
    assert.match(result.out, /build \[focused\] failed \(exit 4\)/);
    assert.match(result.out, /built/);
    assert.equal(loadLedger(dir).evidence[0].exitCode, 4);
  });
});

test('CLI: finish refuses an incomplete release and abort removes ownership', () => {
  withRepo((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    main(['init'], env);
    mkdirSync(join(dir, '.claude', 'backend-engineer'), { recursive: true });
    writeFileSync(ownershipPath(dir), JSON.stringify({ owned: ['src/'] }));
    const refused = main(['finish'], env);
    assert.equal(refused.code, 1);
    assert.equal(existsSync(ownershipPath(dir)), true);
    main(['abort'], env);
    assert.equal(existsSync(ownershipPath(dir)), false);
    assert.equal(existsSync(ledgerPath(dir)), true);
  });
});
