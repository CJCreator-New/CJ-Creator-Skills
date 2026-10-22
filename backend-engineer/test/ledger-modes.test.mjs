import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  addItem,
  emptyLedger,
  loadLedger,
  main,
  makeContext,
  recordReview,
  recordRun,
  releaseStatus,
  validateLedger,
} from '../scripts/ledger.mjs';

function withRepo(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'be-modes-'));
  try {
    const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
    git('init', '-q');
    mkdirSync(join(dir, 'server'), { recursive: true });
    writeFileSync(join(dir, 'server', 'a.ts'), 'export {};\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function completeLedger(dir, mode = 'standard') {
  const ledger = emptyLedger();
  ledger.project = { mode };
  addItem(ledger, 'requirements', { source: 'confirmed', priority: 'high', text: 'Works.', status: 'implemented' });
  addItem(ledger, 'journeys', {
    requirementIds: ['R-01'],
    role: 'user',
    start: 's',
    steps: [{ ui: 'b' }],
    outcomeSuccess: 'o',
    dependsOn: ['server/'],
    priority: 'high',
  });
  const ctx = makeContext(dir);
  recordRun(ledger, ctx, { name: 'test', scope: 'focused', command: 'node -e "process.exit(0)"', cwd: dir, journeyIds: ['J-01'] });
  recordRun(ledger, ctx, { name: 'test', scope: 'full', command: 'node -e "process.exit(0)"', cwd: dir });
  recordReview(ledger, ctx, { verdict: 'passed' });
  return { ledger, ctx };
}

test('an unknown project mode is refused by validation', () => {
  const ledger = emptyLedger();
  ledger.project = { mode: 'turbo' };
  assert.match(validateLedger(ledger).join('\n'), /project.mode must be one of fast, standard, high-assurance/);
});

test('high-assurance mode needs a current passing security review on top of the release review', () => {
  withRepo((dir) => {
    const { ledger, ctx } = completeLedger(dir, 'high-assurance');
    assert.match(releaseStatus(ledger, ctx).notReady.join('\n'), /needs a current passing security review/);

    recordReview(ledger, ctx, { verdict: 'passed', reviewer: 'security-reviewer' });
    assert.equal(releaseStatus(ledger, ctx).status, 'Complete');
  });
});

test('standard mode does not require a security review', () => {
  withRepo((dir) => {
    const { ledger, ctx } = completeLedger(dir, 'standard');
    assert.equal(releaseStatus(ledger, ctx).status, 'Complete');
  });
});

test('a security review that failed does not satisfy high-assurance mode', () => {
  withRepo((dir) => {
    const { ledger, ctx } = completeLedger(dir, 'high-assurance');
    recordReview(ledger, ctx, { verdict: 'findings-open', reviewer: 'security-reviewer' });
    assert.match(releaseStatus(ledger, ctx).notReady.join('\n'), /needs a current passing security review/);
  });
});

test('an unknown reviewer and an unknown detectedIn are refused', () => {
  withRepo((dir) => {
    const ledger = emptyLedger();
    assert.throws(() => recordReview(ledger, makeContext(dir), { verdict: 'passed', reviewer: 'intern' }), /reviewer must be one of/);
  });
  const ledger = emptyLedger();
  addItem(ledger, 'gaps', { title: 'x', severity: 'Low', category: 'Documentation', detectedIn: 'lunch' });
  assert.match(validateLedger(ledger).join('\n'), /detectedIn must be one of/);
});

test('set project records the mode and the stack through the ledger command', () => {
  withRepo((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    main(['init'], env);
    assert.equal(main(['set', 'project', '{"mode":"fast","stack":{"backend":"Express"}}'], env).code, 0);
    assert.equal(loadLedger(dir).project.mode, 'fast');
    assert.throws(() => main(['set', 'project', '{"mode":"turbo"}'], env), /project.mode must be one of/);
    assert.equal(loadLedger(dir).project.mode, 'fast');
  });
});

test('review records the reviewer named on the command line', () => {
  withRepo((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    main(['init'], env);
    main(['review', 'passed', '--reviewer', 'security-reviewer', '--notes', 'checked authz'], env);
    const review = loadLedger(dir).evidence.at(-1);
    assert.equal(review.reviewer, 'security-reviewer');
    assert.equal(review.notes, 'checked authz');
  });
});
