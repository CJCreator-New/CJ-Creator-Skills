// The defect lifecycle on the fixture plan, with runs recorded directly: triage and its severity floor,
// the second review of a Critical defect, merging, the handoff packet, the fix claim, and the retest
// and regression evaluation that closes a defect.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { fixtureLedger, NOW } from './helpers.mjs';
import { approvePlan, freezePlan } from '../scripts/plan.mjs';
import { recordDefect, recordResults, recordRun, status } from '../scripts/ledger.mjs';
import {
  claimFix,
  evaluateDefects,
  handOff,
  mergeDefect,
  regressionSet,
  renderHandoff,
  reviewDefect,
  severityFloor,
  triageDefect,
} from '../scripts/remediation.mjs';

const BUILD_A = 'def456';
const BUILD_B = 'the-fixed-tree';

function approved() {
  const ledger = fixtureLedger();
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  return ledger;
}

const fail = (ledger, id, message = 'status was 200, expected 404') =>
  recordResults(ledger, [{ id, result: 'failed', failures: [{ check: 'check 1 (http)', message }], reasons: [], evidence: [] }], { now: NOW });
const pass = (ledger, ids) => recordResults(ledger, ids.map((id) => ({ id, result: 'passed', failures: [], reasons: [], evidence: [] })), { now: NOW });

// A ledger with DEF-001 on TC-ORD-03 (the cross-tenant read), triaged and handed off.
function handedOff() {
  const ledger = approved();
  fail(ledger, 'TC-ORD-03');
  triageDefect(ledger, 'DEF-001', { severity: 'High', owner: 'backend-engineer', rootCause: 'GET /api/orders/:id does not check the tenant', by: 'triage', now: NOW });
  handOff(ledger, 'DEF-001', { now: NOW });
  return ledger;
}

describe('triage', () => {
  test('a defect on a P0 journey is at least High, and triage cannot set it lower', () => {
    const ledger = approved();
    fail(ledger, 'TC-ORD-03');
    assert.deepEqual(severityFloor(ledger, ledger.defects[0]), { severity: 'High', reason: 'TC-ORD-03 is on P0 journey J-04' });
    assert.throws(
      () => triageDefect(ledger, 'DEF-001', { severity: 'Medium', owner: 'backend-engineer', rootCause: 'x', by: 'triage', now: NOW }),
      /DEF-001 cannot be Medium: TC-ORD-03 is on P0 journey J-04, so it is at least High/,
    );
  });

  test('a defect off the P0 journeys can be Low, and triage records the owner, the root cause and the history', () => {
    const ledger = approved();
    fail(ledger, 'TC-UI-01', 'clicking Export started no download');
    const defect = triageDefect(ledger, 'DEF-001', { severity: 'Low', owner: 'frontend-engineer', rootCause: 'the Export button has no handler', by: 'triage', now: NOW });
    assert.equal(defect.status, 'Triaged');
    assert.equal(defect.owner, 'frontend-engineer');
    assert.deepEqual(defect.history.map((h) => h.status), ['Confirmed', 'Triaged']);
  });

  test('triage needs an owner, a root cause and a known severity', () => {
    const ledger = approved();
    fail(ledger, 'TC-UI-01');
    assert.throws(() => triageDefect(ledger, 'DEF-001', { severity: 'Low', rootCause: 'x', by: 't', now: NOW }), /owner is required/);
    assert.throws(() => triageDefect(ledger, 'DEF-001', { severity: 'Low', owner: 'o', by: 't', now: NOW }), /root cause is required/);
    assert.throws(() => triageDefect(ledger, 'DEF-001', { severity: 'Urgent', owner: 'o', rootCause: 'x', by: 't', now: NOW }), /severity must be one of/);
  });

  test('a Critical defect needs a second review by someone else before it is handed off', () => {
    const ledger = approved();
    fail(ledger, 'TC-ORD-03');
    triageDefect(ledger, 'DEF-001', { severity: 'Critical', owner: 'backend-engineer', rootCause: 'no tenant check', by: 'triage', now: NOW });
    assert.throws(() => handOff(ledger, 'DEF-001', { now: NOW }), /second review is pending/);
    assert.throws(() => reviewDefect(ledger, 'DEF-001', { by: 'triage', verdict: 'confirmed', now: NOW }), /needs a different reviewer/);
    assert.throws(() => reviewDefect(ledger, 'DEF-001', { by: 'reviewer', verdict: 'changed', severity: 'Medium', now: NOW }), /at least High/);
    reviewDefect(ledger, 'DEF-001', { by: 'reviewer', verdict: 'confirmed', now: NOW });
    assert.equal(handOff(ledger, 'DEF-001', { now: NOW }).severity, 'Critical');
  });

  test('a duplicate merges into the defect with the same root cause, and closes as a duplicate', () => {
    const ledger = approved();
    fail(ledger, 'TC-APR-04', 'staff approved an order');
    fail(ledger, 'TC-UI-09', 'staff saw the approve button');
    const into = mergeDefect(ledger, 'DEF-002', 'DEF-001', { by: 'triage', note: 'both are the missing approve check', now: NOW });
    assert.deepEqual(into.testCases, ['TC-APR-04', 'TC-UI-09']);
    const duplicate = ledger.defects.find((d) => d.id === 'DEF-002');
    assert.equal(duplicate.status, 'Closed');
    assert.equal(duplicate.mergedInto, 'DEF-001');
    assert.throws(() => mergeDefect(ledger, 'DEF-002', 'DEF-001', { by: 'triage', now: NOW }), /only open defects merge/);
  });
});

describe('the handoff packet', () => {
  test('holds the requirement, the reproduction, what was observed, the acceptance criteria and the regression set', () => {
    const ledger = handedOff();
    const packet = ledger.handoffs[0];
    assert.equal(packet.id, 'HO-DEF-001-1');
    assert.equal(packet.owner, 'backend-engineer');
    assert.deepEqual(packet.requirements.map((r) => r.id), ['REQ-ORD-003']);
    assert.equal(packet.testCases[0].id, 'TC-ORD-03');
    assert.ok(packet.testCases[0].checks.length > 0);
    assert.deepEqual(packet.observed, [{ check: 'check 1 (http)', message: 'status was 200, expected 404' }]);
    assert.deepEqual(packet.retest, ['TC-ORD-03']);
    assert.deepEqual(packet.regression, regressionSet(ledger, ledger.defects[0]));
    assert.equal(ledger.defects[0].status, 'Handed Off');
  });

  test('the regression set is every in-scope test case on the defect journeys and on the P0 journeys', () => {
    const ledger = approved();
    fail(ledger, 'TC-UI-04', 'the button is 18 CSS pixels');
    const set = regressionSet(ledger, ledger.defects[0]);
    assert.ok(set.includes('TC-UI-04') && set.includes('TC-UI-05'), 'the defect journey J-07');
    assert.ok(set.includes('TC-ORD-03') && set.includes('TC-UI-09'), 'the P0 journeys');
    assert.ok(!set.includes('TC-AND-01'), 'an out-of-scope test case is not in it');
    assert.ok(!set.includes('TC-UI-01'), 'J-06 is neither');
  });

  test('renders as markdown, with the retest command, and with no credential', () => {
    const ledger = handedOff();
    const text = renderHandoff(ledger.handoffs[0]);
    assert.match(text, /^# HO-DEF-001-1: /);
    assert.match(text, /retest\.mjs" <ledger\.json> <qa\.config\.json> --root <repo> --defect DEF-001/);
    assert.match(text, /A fix is a new build/);
    assert.doesNotMatch(text, /manager-pass|admin-pass/);
  });

  test('a test disposition says the fix is a plan change, which needs a new approval', () => {
    const ledger = approved();
    fail(ledger, 'TC-UI-01');
    triageDefect(ledger, 'DEF-001', { severity: 'Low', owner: 'qa', rootCause: 'the test expects the wrong file name', disposition: 'test', by: 'triage', now: NOW });
    assert.match(handOff(ledger, 'DEF-001', { now: NOW }).rules[0], /needs a new approval/);
  });
});

describe('retest and regression', () => {
  test('a claim moves the defect to Fix Claimed only; nothing closes on a claim', () => {
    const ledger = handedOff();
    claimFix(ledger, 'DEF-001', { by: 'backend-engineer', note: 'tenant check added', now: NOW });
    assert.equal(ledger.defects[0].status, 'Fix Claimed');
    assert.deepEqual(evaluateDefects(ledger, { now: NOW }), []);
    assert.throws(() => claimFix(ledger, 'DEF-001', { by: 'x', now: NOW }), /only for a handed-off defect/);
  });

  test('a pass on the build where the test failed is flaky, so it does not retest the fix', () => {
    const ledger = handedOff();
    claimFix(ledger, 'DEF-001', { by: 'backend-engineer', now: NOW });
    const recorded = pass(ledger, ['TC-ORD-03']);
    assert.deepEqual(recorded.flaky, ['TC-ORD-03']);
    assert.equal(ledger.defects[0].status, 'Fix Claimed');
    assert.deepEqual(ledger.defects[0].flaky, ['TC-ORD-03']);
  });

  test('a failing retest sends the defect back to Handed Off', () => {
    const ledger = handedOff();
    claimFix(ledger, 'DEF-001', { by: 'backend-engineer', now: NOW });
    ledger.intake.build.treeHash = BUILD_B;
    const recorded = fail(ledger, 'TC-ORD-03');
    assert.deepEqual(recorded.transitions, [{ defect: 'DEF-001', from: 'Fix Claimed', to: 'Handed Off' }]);
    assert.equal(ledger.defects.length, 1, 'the open defect takes the failure; no second defect');
  });

  test('a retest pass on the new build is Retest Passed, and the regression is incomplete until the set has run', () => {
    const ledger = handedOff();
    claimFix(ledger, 'DEF-001', { by: 'backend-engineer', now: NOW });
    ledger.intake.build.treeHash = BUILD_B;
    pass(ledger, ['TC-ORD-03']);
    const defect = ledger.defects[0];
    assert.equal(defect.status, 'Retest Passed');
    assert.equal(defect.regression.status, 'incomplete');
    assert.ok(defect.regression.missing.includes('TC-AUTH-01 not run'));
    assert.equal(status(ledger).status, 'FAIL', 'an open High defect keeps the gate at FAIL');
  });

  test('the regression run closes the defect, and a failure that another, earlier defect covers is known', () => {
    const ledger = handedOff();
    fail(ledger, 'TC-APR-04', 'staff approved an order');
    claimFix(ledger, 'DEF-001', { by: 'backend-engineer', now: NOW });
    ledger.intake.build.treeHash = BUILD_B;
    const set = regressionSet(ledger, ledger.defects[0]);
    pass(ledger, set.filter((id) => id !== 'TC-APR-04'));
    fail(ledger, 'TC-APR-04', 'staff approved an order');
    const defect = ledger.defects[0];
    assert.equal(defect.status, 'Closed');
    assert.equal(defect.closedOnBuild, BUILD_B);
    assert.deepEqual(defect.regression.knownFailures, ['TC-APR-04']);
    assert.deepEqual(
      defect.history.map((h) => h.status),
      ['Confirmed', 'Triaged', 'Handed Off', 'Fix Claimed', 'Retest Passed', 'Regression Passed', 'Closed'],
    );
  });

  test('a failure first seen on the fixed build is a regression, and the defect does not close', () => {
    const ledger = handedOff();
    claimFix(ledger, 'DEF-001', { by: 'backend-engineer', now: NOW });
    ledger.intake.build.treeHash = BUILD_B;
    const set = regressionSet(ledger, ledger.defects[0]);
    pass(ledger, set.filter((id) => id !== 'TC-ORD-02'));
    fail(ledger, 'TC-ORD-02', 'total is a string');
    const defect = ledger.defects[0];
    assert.equal(defect.status, 'Retest Passed');
    assert.deepEqual(defect.regression.failing, ['TC-ORD-02']);
    assert.equal(ledger.defects[1].build, BUILD_B, 'the regression has its own defect, found on the fixed build');
  });

  test('a later failure of a closed defect test opens a new defect, marked as a regression of it', () => {
    const ledger = handedOff();
    ledger.intake.build.treeHash = BUILD_B;
    pass(ledger, regressionSet(ledger, ledger.defects[0]));
    assert.equal(ledger.defects[0].status, 'Closed');
    ledger.intake.build.treeHash = 'a-third-tree';
    fail(ledger, 'TC-ORD-03');
    assert.equal(ledger.defects[1].regressionOf, 'DEF-001');
  });
});

describe('flaky test cases (planted defect 11)', () => {
  test('a pass then a failure on the same build is flaky, and opens no defect', () => {
    const ledger = approved();
    pass(ledger, ['TC-ORD-02']);
    const recorded = fail(ledger, 'TC-ORD-02', 'order o-2 is approved, expected pending');
    assert.deepEqual(recorded.flaky, ['TC-ORD-02']);
    assert.deepEqual(recorded.opened, []);
    assert.equal(ledger.defects.length, 0);
  });

  test('a defect is recorded with the run that found it', () => {
    const ledger = approved();
    recordRun(ledger, { testCase: 'TC-UI-01', result: 'failed', now: NOW });
    assert.equal(recordDefect(ledger, { testCase: 'TC-UI-01', failures: [], now: NOW }).detectedRun, 'R-0001');
    assert.equal(ledger.defects[0].build, BUILD_A);
  });
});

describe('selecting test cases by ID', () => {
  test('a retest never silently runs less than it was asked to', async () => {
    const { selectTestCases } = await import('../scripts/results.mjs');
    const ledger = approved();
    assert.deepEqual(selectTestCases(ledger, ['api'], ['TC-ORD-03']).map((t) => t.id), ['TC-ORD-03']);
    assert.deepEqual(selectTestCases(ledger, ['web'], ['TC-ORD-03']), [], 'another layer runs it');
    assert.throws(() => selectTestCases(ledger, ['api'], ['TC-NOPE']), /TC-NOPE is not in the plan/);
    assert.throws(() => selectTestCases(ledger, ['android'], ['TC-AND-01']), /TC-AND-01 is out of scope: native targets/);
    assert.ok(!selectTestCases(ledger, ['android', 'ios']).length, 'out-of-scope cases are not selected');
  });
});
