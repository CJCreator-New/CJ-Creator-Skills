import { test } from 'node:test';
import assert from 'node:assert/strict';

import { clone, fixtureLedger, NOW, readFixturePlan } from './helpers.mjs';
import { emptyLedger } from '../scripts/ledger.mjs';
import { addItem, approvePlan, canonical, freezePlan, loadPlan, planDigest, planState } from '../scripts/plan.mjs';

test('the digest does not depend on the order the items were written in', () => {
  const a = fixtureLedger();
  const b = fixtureLedger();
  b.testCases.reverse();
  b.requirements.reverse();
  assert.equal(planDigest(a), planDigest(b));
});

test('the digest changes when any plan item changes, and the state says so', () => {
  const ledger = fixtureLedger();
  const before = planDigest(ledger);
  freezePlan(ledger, { now: NOW });
  assert.equal(planState(ledger), 'frozen');
  ledger.testCases[0].title = 'a changed title';
  assert.notEqual(planDigest(ledger), before);
  assert.equal(planState(ledger), 'changed since frozen');
});

test('a plan that has errors cannot be frozen, and the errors are in the message', () => {
  const ledger = fixtureLedger();
  ledger.testCases = ledger.testCases.filter((t) => t.id !== 'TC-ORD-03');
  assert.throws(() => freezePlan(ledger, { now: NOW }), /P0 journey J-04 has no test case/);
  assert.equal(ledger.planFrozen, null);
});

test('freezing records the digest, the time, and the coverage at that time', () => {
  const ledger = fixtureLedger();
  const frozen = freezePlan(ledger, { now: NOW });
  assert.equal(frozen.hash, planDigest(ledger));
  assert.equal(frozen.frozenAt, NOW);
  assert.equal(frozen.coverage.requirements.total, 15);
  assert.equal(frozen.gaps, 3);
});

test('an approval binds to the frozen digest, and only a frozen plan can be approved', () => {
  const ledger = fixtureLedger();
  assert.throws(() => approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' }), /freeze the plan before approving/);
  freezePlan(ledger, { now: NOW });
  const approval = approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  assert.equal(approval.planHash, ledger.planFrozen.hash);
});

test('an approval is refused when the plan changed after it was frozen', () => {
  const ledger = fixtureLedger();
  freezePlan(ledger, { now: NOW });
  ledger.requirements[0].text = 'a changed requirement';
  assert.throws(() => approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' }), /changed after it was frozen/);
});

test('an approval needs a named approver', () => {
  const ledger = fixtureLedger();
  freezePlan(ledger, { now: NOW });
  assert.throws(() => approvePlan(ledger, { approver: '  ', approvedAt: '2026-10-22' }), /approver/);
});

test('addItem refuses a duplicate, a bad identifier, an unknown kind and a refused run', () => {
  const ledger = fixtureLedger();
  assert.throws(() => addItem(ledger, 'role', { id: 'admin' }), /role admin already exists/);
  assert.throws(() => addItem(ledger, 'role', { id: 'has space' }), /needs an id/);
  assert.throws(() => addItem(ledger, 'widget', { id: 'W-1' }), /unknown kind widget/);
  const refused = emptyLedger();
  refused.intake = { safety: { allowed: false, problems: ['x'] } };
  assert.throws(() => addItem(refused, 'role', { id: 'r' }), /refused run/);
});

test('loadPlan reads each section into its collection and rejects an unknown section', () => {
  const ledger = fixtureLedger();
  const plain = { ...emptyLedger(), intake: ledger.intake };
  const counts = loadPlan(plain, readFixturePlan());
  assert.equal(counts.testCases, 18);
  assert.equal(counts.journeys, 9);
  assert.throws(() => loadPlan(plain, { mystery: [] }), /unknown plan section mystery/);
});

test('canonical sorts keys at every depth, and keeps the order of arrays', () => {
  assert.equal(JSON.stringify(canonical({ b: 1, a: { d: 2, c: [{ z: 1, y: 2 }] } })), '{"a":{"c":[{"y":2,"z":1}],"d":2},"b":1}');
  assert.deepEqual(canonical([3, 1, 2]), [3, 1, 2]);
});

test('the fixture plan loads with every collection populated', () => {
  const ledger = fixtureLedger();
  assert.equal(ledger.requirements.length, 15);
  assert.equal(ledger.journeys.length, 9);
  assert.equal(ledger.testCases.length, 18);
  assert.equal(clone(ledger.designMap).source, 'none');
});
