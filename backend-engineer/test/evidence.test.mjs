import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  addItem,
  emptyLedger,
  gapTransition,
  loadLedger,
  main,
  makeContext,
  recordReview,
  recordRun,
  releaseStatus,
  validateLedger,
} from '../scripts/ledger.mjs';
import { declare, emptyInventory, passingRun, withRepo } from './helpers.mjs';

const PRINTS = (text) => `node -e "console.log('${text}'); process.exit(0)"`;

// A gap at Fix Implemented, with one named regression test.
function gapAtFix(ledger, { regressionTests = ['alpha'] } = {}) {
  addItem(ledger, 'gaps', { title: 'Queue stale', severity: 'High', category: 'Frontend', owner: 'frontend-integrator', rootCause: 'cache', fix: 'invalidate', regressionTests });
  ledger.gaps[0].status = 'Fix Implemented';
  return ledger.gaps[0];
}

test('a regression test counts only if its name printed in a passing regression run', () =>
  withRepo((dir) => {
    const ledger = declare(emptyLedger(), { regression: PRINTS('alpha passed') });
    const gap = gapAtFix(ledger, { regressionTests: ['alpha', 'beta'] });
    gap.status = 'Focused Tests Passed';
    recordRun(ledger, makeContext(dir), { name: 'regression', scope: 'regression', command: PRINTS('alpha passed'), gapIds: ['G-01'], tests: ['alpha', 'beta'] });
    assert.deepEqual(ledger.evidence.at(-1).testsSeen, ['alpha']);
    const result = gapTransition(ledger, gap, 'Regression Verified', makeContext(dir));
    assert.equal(result.ok, false);
    assert.match(result.reasons.join('\n'), /these regression tests did not print in a passing regression run: beta/);
  }));

test('a regression test whose name is only claimed, not printed, does not pass the gate', () =>
  withRepo((dir) => {
    const ledger = declare(emptyLedger(), { regression: PRINTS('nothing to see') });
    const gap = gapAtFix(ledger, { regressionTests: ['alpha'] });
    recordRun(ledger, makeContext(dir), { name: 'regression', scope: 'regression', command: PRINTS('nothing to see'), gapIds: ['G-01'], tests: ['alpha'] });
    assert.match(gapTransition(ledger, gap, 'Regression Verified', makeContext(dir)).reasons.join('\n'), /alpha/);
  }));

test('a regression test that printed in a passing run lets the gap move to Regression Verified', () =>
  withRepo((dir) => {
    const ledger = declare(emptyLedger(), { regression: PRINTS('alpha passed') });
    const gap = gapAtFix(ledger, { regressionTests: ['alpha'] });
    gap.status = 'Focused Tests Passed';
    recordRun(ledger, makeContext(dir), { name: 'regression', scope: 'regression', command: PRINTS('alpha passed'), gapIds: ['G-01'], tests: ['alpha'] });
    assert.equal(gapTransition(ledger, gap, 'Regression Verified', makeContext(dir)).ok, true);
  }));

test('acceptance must cite current passing evidence linked to the gap, or a current passing review', () =>
  withRepo((dir) => {
    const ledger = declare(emptyLedger(), { testFocused: PRINTS('ok') });
    const gap = gapAtFix(ledger);
    gap.status = 'Regression Verified';
    gap.acceptance = [{ criterion: 'Queue refreshes', evidence: 'E-99' }];
    assert.match(gapTransition(ledger, gap, 'Closed', makeContext(dir)).reasons.join('\n'), /no current passing evidence linked to this gap \(E-99\)/);

    recordRun(ledger, makeContext(dir), { name: 'testFocused', scope: 'focused', command: PRINTS('ok'), gapIds: ['G-01'] });
    gap.acceptance = [{ criterion: 'Queue refreshes', evidence: 'E-01' }];
    assert.equal(gapTransition(ledger, gap, 'Closed', makeContext(dir)).ok, true);

    recordReview(ledger, makeContext(dir), { verdict: 'passed' });
    gap.acceptance = [{ criterion: 'Reviewed', evidence: 'E-02' }];
    assert.equal(gapTransition(ledger, gap, 'Closed', makeContext(dir)).ok, true);
  }));

test('acceptance evidence that a later edit made stale does not count', () =>
  withRepo((dir) => {
    const ledger = declare(emptyLedger(), { testFocused: PRINTS('ok') });
    const gap = gapAtFix(ledger);
    gap.status = 'Regression Verified';
    recordRun(ledger, makeContext(dir), { name: 'testFocused', scope: 'focused', command: PRINTS('ok'), gapIds: ['G-01'] });
    gap.acceptance = [{ criterion: 'Queue refreshes', evidence: 'E-01' }];
    writeFileSync(join(dir, 'src', 'feature', 'a.ts'), 'export const a = 5;\n');
    assert.match(gapTransition(ledger, gap, 'Closed', makeContext(dir)).reasons.join('\n'), /no current passing evidence/);
  }));

test('acceptance and regression fields keep their shapes', () => {
  const ledger = emptyLedger();
  addItem(ledger, 'gaps', { title: 'x', severity: 'Low', category: 'Documentation', acceptance: ['just text'], regressionTests: 'alpha' });
  const errors = validateLedger(ledger).join('\n');
  assert.match(errors, /acceptance must be a list of \{criterion, evidence\}/);
  assert.match(errors, /regressionTests must be a list of test names/);
});

test('a passed review needs a report file, and the ledger stores the report hash', () =>
  withRepo((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    main(['init'], env);
    assert.throws(() => main(['review', 'passed'], env), /needs --report/);
    assert.throws(() => main(['review', 'passed', '--report', 'missing.md'], env), /does not exist/);
    writeFileSync(join(dir, 'review.md'), '# Review\nChecked the queue.\n');
    assert.equal(main(['review', 'passed', '--report', 'review.md'], env).code, 0);
    const review = loadLedger(dir).evidence.at(-1);
    assert.equal(review.reportSha256, createHash('sha256').update(readFileSync(join(dir, 'review.md'))).digest('hex'));
  }));

test('a findings-open review may be recorded without a report', () =>
  withRepo((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    main(['init'], env);
    assert.equal(main(['review', 'findings-open'], env).code, 0);
  }));

test('migrations need a rollback unless irreversible, and an irreversible one needs an answered decision', () => {
  const ledger = emptyLedger();
  addItem(ledger, 'migrations', { file: 'db/migrations/002.sql', description: 'add column', backwardCompatible: true, irreversible: false, rollback: null });
  addItem(ledger, 'migrations', { file: 'db/migrations/003.sql', description: 'drop column', backwardCompatible: false, irreversible: true, rollback: null, decisionId: 'D-09' });
  const errors = validateLedger(ledger).join('\n');
  assert.match(errors, /M-01: a reversible migration needs a rollback step/);
  assert.match(errors, /M-02: decisionId references missing D-09/);
});

test('release is not ready while a migration has no current passing migrate run', () =>
  withRepo((dir) => {
    const ledger = emptyInventory(declare(emptyLedger(), { migrate: PRINTS('applied and reverted') }));
    addItem(ledger, 'migrations', { file: 'db/migrations/002.sql', description: 'add column', backwardCompatible: true, irreversible: false, rollback: 'drop column' });
    assert.match(releaseStatus(ledger, makeContext(dir)).notReady.join('\n'), /M-01 \(db\/migrations\/002.sql\) is not verified/);

    recordRun(ledger, makeContext(dir), { name: 'migrate', scope: 'focused', command: PRINTS('applied and reverted') });
    assert.doesNotMatch(releaseStatus(ledger, makeContext(dir)).notReady.join('\n'), /is not verified/);
  }));

test('release is not ready for a non-compatible migration that is not recorded as irreversible, or whose decision is open', () =>
  withRepo((dir) => {
    const ledger = emptyInventory(declare(emptyLedger(), { migrate: PRINTS('ok') }));
    addItem(ledger, 'decisions', { question: 'Drop the old column now?', status: 'open', blocks: [] });
    addItem(ledger, 'migrations', { file: 'db/migrations/004.sql', description: 'rename', backwardCompatible: false, irreversible: false, rollback: 'rename back' });
    addItem(ledger, 'migrations', { file: 'db/migrations/005.sql', description: 'drop', backwardCompatible: false, irreversible: true, rollback: null, decisionId: 'D-01' });
    const notReady = releaseStatus(ledger, makeContext(dir)).notReady.join('\n');
    assert.match(notReady, /M-01 is not backward compatible/);
    assert.match(notReady, /M-02 is irreversible, and its decision D-01 is not answered/);
  }));

test('an implemented requirement with a journey that is not verified is not ready', () =>
  withRepo((dir) => {
    const ledger = emptyInventory(declare(emptyLedger()));
    addItem(ledger, 'requirements', { source: 'confirmed', priority: 'high', text: 'Submit works.', status: 'implemented' });
    addItem(ledger, 'journeys', { requirementIds: ['R-01'], role: 'u', start: 's', steps: [{ ui: 'b' }], outcomeSuccess: 'o', dependsOn: ['src/feature/'], priority: 'high' });
    assert.match(releaseStatus(ledger, makeContext(dir)).notReady.join('\n'), /R-01 is marked implemented, but J-01 not verified/);
  }));

test('a UI file with interaction sites and no interaction record makes the release partial, and naming it clears it', () =>
  withRepo((dir) => {
    const ledger = declare(emptyLedger());
    ledger.inventory = { recordedAt: '2026-10-22T10:00:00.000Z', files: { 'src/features/expenses/ExpenseForm.tsx': 2 } };
    assert.match(releaseStatus(ledger, makeContext(dir)).partial.join('\n'), /UI files with interaction sites and no interaction record: src\/features\/expenses\/ExpenseForm.tsx/);

    addItem(ledger, 'interactions', { route: '/x', element: 'Submit', classification: 'local', reason: 'client only', source: 'src/features/expenses/ExpenseForm.tsx' });
    assert.doesNotMatch(releaseStatus(ledger, makeContext(dir)).partial.join('\n'), /no interaction record/);
  }));

test('a release with no UI inventory recorded is partial, not silently complete', () =>
  withRepo((dir) => {
    const ledger = declare(emptyLedger());
    assert.match(releaseStatus(ledger, makeContext(dir)).partial.join('\n'), /no UI inventory recorded/);
  }));

test('an interaction source must be a file path', () => {
  const ledger = emptyLedger();
  addItem(ledger, 'interactions', { route: '/x', element: 'Submit', classification: 'local', reason: 'r', source: '' });
  assert.match(validateLedger(ledger).join('\n'), /source must be a file path/);
});
