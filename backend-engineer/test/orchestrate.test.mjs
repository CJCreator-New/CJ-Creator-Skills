import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { addItem, emptyLedger, loadLedger, makeContext, recordRun, saveLedger } from '../scripts/ledger.mjs';
import { advance, approve, dispatchFor, main, nextPhase, planWaves, prerequisites, statusOf } from '../scripts/orchestrate.mjs';
import { PASS, declare, passingRun, withRepo } from './helpers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OPENAPI_EXAMPLE = resolve(HERE, '../examples/openapi.example.json');
const LEDGER_EXAMPLE = JSON.parse(readFileSync(resolve(HERE, '../examples/ledger.example.json'), 'utf8'));
const { _comment, ...EXAMPLE } = LEDGER_EXAMPLE;

const FIXED = () => new Date('2026-10-22T10:00:00.000Z');

// Adds one requirement and one journey to the run's ledger, keeping any phases already completed.
function plannedLedger(dir) {
  const ledger = declare(loadLedger(dir));
  addItem(ledger, 'requirements', { source: 'confirmed', priority: 'high', text: 'Submit works.', status: 'implemented' });
  addItem(ledger, 'journeys', {
    requirementIds: ['R-01'],
    role: 'employee',
    start: 'draft',
    steps: [{ ui: 'Submit', api: 'POST /expenses/:id/submit' }],
    outcomeSuccess: 'submitted',
    dependsOn: ['src/feature/'],
    priority: 'high',
  });
  saveLedger(dir, ledger);
  return ledger;
}


// Completes phases in order, as the skill would, so a test can start from any point.
function completePhases(dir, names) {
  for (const name of names) {
    const result = advance(dir, name, { now: FIXED });
    assert.equal(result.ok, true, `${name}: ${result.reasons.join('; ')}`);
  }
}

test('phases advance only in order, and the next one is named when a request is out of turn', () => {
  withRepo((dir) => {
    plannedLedger(dir);
    const out = advance(dir, 'plan', { now: FIXED });
    assert.equal(out.ok, false);
    assert.match(out.reasons.join('\n'), /the next phase is discover, not plan/);
    completePhases(dir, ['discover', 'understand', 'plan']);
    assert.equal(nextPhase(loadLedger(dir)), 'contract');
  });
});

test('the plan phase needs requirements and journeys, and the contract phase needs an approved contract', () => {
  withRepo((dir) => {
    saveLedger(dir, declare(emptyLedger()));
    completePhases(dir, ['discover', 'understand']);
    assert.match(advance(dir, 'plan', { now: FIXED }).reasons.join('\n'), /record requirements first/);

    plannedLedger(dir);
    completePhases(dir, ['plan']);
    const refused = advance(dir, 'contract', { now: FIXED });
    assert.match(refused.reasons.join('\n'), /approve the contract first/);
  });
});

test('the contract is approved only when the OpenAPI document passes the journey check', () => {
  withRepo((dir) => {
    plannedLedger(dir);
    completePhases(dir, ['discover', 'understand', 'plan']);
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify({ openapi: '3.0.3', paths: {} }));
    const refused = approve(dir, 'contract', bad, { now: FIXED });
    assert.equal(refused.ok, false);
    assert.match(refused.reasons.join('\n'), /is used by the journey but not in the document/);
    assert.equal(loadLedger(dir).approvals.length, 0);

    const approved = approve(dir, 'contract', OPENAPI_EXAMPLE, { now: FIXED });
    assert.equal(approved.ok, true);
    assert.equal(loadLedger(dir).approvals[0].name, 'contract');
  });
});

test('an approval goes stale when the contract file changes, and the contract phase is then refused', () => {
  withRepo((dir) => {
    plannedLedger(dir);
    completePhases(dir, ['discover', 'understand', 'plan']);
    const file = join(dir, 'openapi.json');
    writeFileSync(file, readFileSync(OPENAPI_EXAMPLE, 'utf8'));
    assert.equal(approve(dir, 'contract', file, { now: FIXED }).ok, true);

    writeFileSync(file, readFileSync(OPENAPI_EXAMPLE, 'utf8').replace('Expenses (example)', 'Changed'));
    const refused = advance(dir, 'contract', { now: FIXED });
    assert.equal(refused.ok, false);
    assert.match(refused.reasons.join('\n'), /changed after it was approved/);
  });
});

test('only the contract can be approved', () => {
  withRepo((dir) => {
    plannedLedger(dir);
    assert.throws(() => approve(dir, 'schema', OPENAPI_EXAMPLE, { now: FIXED }), /only the contract can be approved/);
  });
});

test('verify is refused while any task is not done, and the names of the open tasks are given', () => {
  withRepo((dir) => {
    plannedLedger(dir);
    const ledger = loadLedger(dir);
    addItem(ledger, 'tasks', { owner: 'backend-implementer', files: ['src/feature/'], status: 'planned' });
    saveLedger(dir, ledger);
    completePhases(dir, ['discover', 'understand', 'plan']);
    approve(dir, 'contract', OPENAPI_EXAMPLE, { now: FIXED });
    completePhases(dir, ['contract', 'implement']);
    assert.match(advance(dir, 'verify', { now: FIXED }).reasons.join('\n'), /tasks are not done: T-01/);
  });
});

test('review needs a current passing full suite run', () => {
  withRepo((dir) => {
    const ledger = declare(emptyLedger());
    addItem(ledger, 'requirements', { source: 'confirmed', priority: 'high', text: 'x', status: 'implemented' });
    addItem(ledger, 'journeys', { requirementIds: ['R-01'], role: 'u', start: 's', steps: [{ ui: 'b' }], outcomeSuccess: 'o', dependsOn: ['src/feature/'], priority: 'high' });
    saveLedger(dir, ledger);
    const current = loadLedger(dir);
    current.phases = ['discover', 'understand', 'plan', 'contract', 'implement', 'verify', 'e2e'].map((name) => ({ name, completedAt: FIXED().toISOString() }));
    assert.match(prerequisites(current, 'review', makeContext(dir)).join('\n'), /no current passing full suite run/);
    passingRun(current, makeContext(dir), { scope: 'full' });
    // A fresh context: the tree-hash memo of the check above must not carry into the run.
    assert.deepEqual(prerequisites(current, 'review', makeContext(dir)), []);
  });
});

test('deliver is refused unless the release status is Complete', () => {
  withRepo((dir) => {
    const ledger = declare(emptyLedger());
    ledger.phases = ['discover', 'understand', 'plan', 'contract', 'implement', 'verify', 'e2e', 'review'].map((name) => ({ name, completedAt: FIXED().toISOString() }));
    assert.match(prerequisites(ledger, 'deliver', makeContext(dir)).join('\n'), /release status is Not Release Ready/);
  });
});

test('a phase cannot be completed twice', () => {
  withRepo((dir) => {
    plannedLedger(dir);
    const first = advance(dir, 'discover', { now: FIXED });
    const second = advance(dir, 'discover', { now: FIXED });
    assert.equal(first.ok, true);
    assert.equal(second.ok, false);
    assert.equal(loadLedger(dir).phases.length, 1);
  });
});

test('a task with a route kind gets a model from route, and an owner gets its default kind', () => {
  const task = { id: 'T-01', owner: 'db-integrity', files: ['db/'], status: 'planned', risk: 'low', dependsOn: [] };
  const dispatch = dispatchFor(task);
  assert.equal(dispatch.kind, 'migration');
  assert.equal(dispatch.model, 'opus');
  assert.equal(dispatchFor({ ...task, owner: 'backend-implementer', risk: 'low' }).model, 'sonnet');
  assert.equal(dispatchFor({ ...task, owner: 'backend-implementer', risk: 'high' }).model, 'opus');
});

test('the plan puts ready tasks into waves, in dependency order, and tasks in a wave own different files', () => {
  const ledger = emptyLedger();
  addItem(ledger, 'tasks', { owner: 'api-architect', files: ['contracts/'] });
  addItem(ledger, 'tasks', { owner: 'backend-implementer', files: ['server/expenses/'], dependsOn: ['T-01'] });
  addItem(ledger, 'tasks', { owner: 'db-integrity', files: ['db/migrations/'] });
  addItem(ledger, 'tasks', { owner: 'frontend-integrator', files: ['src/features/'], dependsOn: ['T-02', 'T-03'] });
  const plan = planWaves(ledger);
  assert.deepEqual(plan.waves.map((w) => w.tasks.map((t) => t.id)), [['T-01', 'T-03'], ['T-02'], ['T-04']]);
  for (const wave of plan.waves) {
    for (const [i, a] of wave.tasks.entries()) {
      for (const b of wave.tasks.slice(i + 1)) {
        const overlap = a.files.some((x) => b.files.some((y) => x === y || x.startsWith(y) || y.startsWith(x)));
        assert.equal(overlap, false, `${a.id} and ${b.id} share files in one wave`);
      }
    }
  }
});

test('done tasks are not scheduled, and blocked tasks and their dependants are reported, not run', () => {
  const ledger = emptyLedger();
  addItem(ledger, 'tasks', { owner: 'a', files: ['x/'], status: 'done' });
  addItem(ledger, 'tasks', { owner: 'b', files: ['y/'], status: 'blocked' });
  addItem(ledger, 'tasks', { owner: 'c', files: ['z/'], dependsOn: ['T-02'] });
  addItem(ledger, 'tasks', { owner: 'd', files: ['w/'], dependsOn: ['T-01'] });
  const plan = planWaves(ledger);
  assert.deepEqual(plan.waves.map((w) => w.tasks.map((t) => t.id)), [['T-04']]);
  assert.deepEqual(plan.blocked, ['T-02']);
  assert.deepEqual(plan.waiting, ['T-03']);
});

test('status names the next phase and what blocks it', () => {
  withRepo((dir) => {
    plannedLedger(dir);
    const status = statusOf(loadLedger(dir), makeContext(dir));
    assert.equal(status.next, 'discover');
    assert.deepEqual(status.completed, []);
    assert.equal(status.release, 'Not Release Ready');
  });
});

test('CLI: status, plan and an out-of-turn advance return JSON and exit codes the skill can read', () => {
  withRepo((dir) => {
    const env = { CLAUDE_PROJECT_DIR: dir };
    plannedLedger(dir);
    const status = JSON.parse(main(['status'], env).out);
    assert.equal(status.next, 'discover');
    assert.equal(main(['advance', 'plan'], env).code, 1);
    const plan = JSON.parse(main(['plan'], env).out);
    assert.deepEqual(plan.waves, []);
  });
});

test('the example ledger and its OpenAPI document reach the contract phase together', () => {
  withRepo((dir) => {
    saveLedger(dir, EXAMPLE);
    completePhases(dir, ['discover', 'understand', 'plan']);
    assert.equal(approve(dir, 'contract', OPENAPI_EXAMPLE, { now: FIXED }).ok, true);
    assert.equal(advance(dir, 'contract', { now: FIXED }).ok, true);
  });
});

test('verify needs a current passing migrate run once the project has migrations', () => {
  withRepo((dir) => {
    plannedLedger(dir);
    completePhases(dir, ['discover', 'understand', 'plan']);
    approve(dir, 'contract', OPENAPI_EXAMPLE, { now: FIXED });
    const ledger = declare(loadLedger(dir), { migrate: PASS });
    addItem(ledger, 'tasks', { owner: 'backend-implementer', files: ['src/feature/'], status: 'done' });
    addItem(ledger, 'migrations', { file: 'db/migrations/002.sql', description: 'add column', backwardCompatible: true, irreversible: false, rollback: 'drop column' });
    saveLedger(dir, ledger);
    completePhases(dir, ['contract', 'implement']);
    assert.match(advance(dir, 'verify', { now: FIXED }).reasons.join('\n'), /migrations are not verified/);

    recordRun(ledger, makeContext(dir), { name: 'migrate', scope: 'focused', command: PASS });
    saveLedger(dir, ledger);
    assert.doesNotMatch(advance(dir, 'verify', { now: FIXED }).reasons.join('\n'), /migrations are not verified/);
  });
});
