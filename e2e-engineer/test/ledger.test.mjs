import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowedLedger, clone, fixtureLedger, NOW } from './helpers.mjs';
import {
  emptyLedger,
  readLedger,
  recordBinary,
  recordDefect,
  recordIntake,
  recordRun,
  status,
  testState,
  writeLedger,
} from '../scripts/ledger.mjs';
import { approvePlan, freezePlan } from '../scripts/plan.mjs';

// The fixture's P0 journeys and the test cases that cover each one.
const P0 = { 'J-01': ['TC-AUTH-01', 'TC-AUTH-02', 'TC-UI-06'], 'J-02': ['TC-ORD-01', 'TC-ORD-02', 'TC-UI-08'], 'J-03': ['TC-APR-01', 'TC-APR-02', 'TC-APR-03', 'TC-APR-04', 'TC-DB-01'], 'J-04': ['TC-ORD-03'] };

function run(ledger, testCase, result, extra = {}) {
  return recordRun(ledger, { testCase, result, now: NOW, ...extra });
}

function approved() {
  const ledger = fixtureLedger({ web: { status: 'ready' }, 'mobile-web': { status: 'ready' } });
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  return ledger;
}

test('an empty ledger is blocked because intake has not run', () => {
  assert.deepEqual(status(emptyLedger()), { status: 'BLOCKED', reasons: ['intake has not run'] });
});

test('a refused run is blocked, and every refusal reason is reported', () => {
  const ledger = emptyLedger();
  recordIntake(ledger, {
    configName: 'test',
    safety: { allowed: false, problems: ['db "orders" does not match allowlist.dbNamePattern'], resetAllowed: false },
    build: { commit: null, treeHash: null, current: false },
    probes: {},
    readiness: {},
    targets: {},
    now: NOW,
  });
  assert.deepEqual(status(ledger), {
    status: 'BLOCKED',
    reasons: ['refused: db "orders" does not match allowlist.dbNamePattern'],
  });
});

test('an allowed run with no frozen plan is blocked, and says the plan is not frozen', () => {
  assert.deepEqual(status(allowedLedger()), { status: 'BLOCKED', reasons: ['the test plan is not frozen and approved'] });
});

test('a frozen but unapproved plan is blocked, and says the plan is not approved', () => {
  const ledger = fixtureLedger();
  freezePlan(ledger, { now: NOW });
  assert.deepEqual(status(ledger), { status: 'BLOCKED', reasons: ['the test plan is not approved'] });
});

test('an approved plan with no runs is partially tested, and every P0 journey says what is missing', () => {
  const result = status(approved());
  assert.equal(result.status, 'PARTIALLY TESTED');
  assert.equal(result.reasons.length, 4);
  assert.ok(result.reasons.some((r) => r.startsWith('P0 journey J-03 is not verified: TC-APR-01 not run')));
});

test('the gate passes only when every test case of every P0 journey has a current pass', () => {
  const ledger = approved();
  const all = Object.values(P0).flat();
  for (const id of all.slice(0, -1)) run(ledger, id, 'passed');
  assert.equal(status(ledger).status, 'PARTIALLY TESTED');
  run(ledger, all[all.length - 1], 'passed');
  assert.deepEqual(status(ledger), { status: 'PASS', reasons: [] });
});

test('a failing test case gives FAIL, and FAIL takes precedence over a blocked target', () => {
  const ledger = fixtureLedger({ android: { status: 'blocked', reason: 'no device' } });
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  run(ledger, 'TC-AUTH-02', 'failed');
  assert.deepEqual(status(ledger), { status: 'FAIL', reasons: ['TC-AUTH-02 failed'] });
});

test('a blocked P0 test case keeps the gate at BLOCKED, with its reason', () => {
  const ledger = approved();
  run(ledger, 'TC-ORD-03', 'blocked', { reasons: ['environment variable E2E_MANAGER_PASSWORD is not set'] });
  const result = status(ledger);
  assert.equal(result.status, 'BLOCKED');
  assert.match(result.reasons.join(' '), /TC-ORD-03 is blocked: environment variable E2E_MANAGER_PASSWORD is not set/);
});

test('a run from an earlier build is stale, and it does not count toward the gate', () => {
  const ledger = approved();
  const all = Object.values(P0).flat();
  for (const id of all) run(ledger, id, 'passed');
  assert.equal(status(ledger).status, 'PASS');
  ledger.intake.build.treeHash = 'a-different-tree';
  assert.equal(testState(ledger, 'TC-ORD-03').state, 'stale');
  const result = status(ledger);
  assert.equal(result.status, 'PARTIALLY TESTED');
  assert.ok(result.reasons.some((r) => r.includes('TC-ORD-03 stale')));
});

test('a run that needs confirmation is not a FAIL, and its journey is not verified', () => {
  const ledger = approved();
  run(ledger, 'TC-APR-04', 'needs-confirmation');
  const result = status(ledger);
  assert.notEqual(result.status, 'FAIL');
  assert.ok(result.reasons.some((r) => r.includes('TC-APR-04 needs-confirmation')));
});

test('the latest run of a test case is the one that counts', () => {
  const ledger = approved();
  run(ledger, 'TC-AUTH-02', 'failed');
  run(ledger, 'TC-AUTH-02', 'passed');
  assert.equal(testState(ledger, 'TC-AUTH-02').state, 'passed');
  assert.equal(status(ledger).reasons.some((r) => r === 'TC-AUTH-02 failed'), false);
});

test('a run records the build it ran on, and cannot be recorded for a refused run or an unknown test case', () => {
  const ledger = approved();
  const entry = run(ledger, 'TC-AUTH-02', 'passed');
  assert.equal(entry.build, 'def456');
  assert.deepEqual(entry.journeys, ['J-01']);
  assert.throws(() => run(ledger, 'TC-NOPE', 'passed'), /test case TC-NOPE is not in the plan/);
  const refused = emptyLedger();
  refused.intake = { safety: { allowed: false, problems: ['x'] } };
  assert.throws(() => run(refused, 'TC-AUTH-02', 'passed'), /refused run/);
});

test('a defect is opened once per test case, and a second failure adds no second defect', () => {
  const ledger = approved();
  const first = recordDefect(ledger, { testCase: 'TC-ORD-03', failures: [{ check: 'check 1 (http)', message: 'status is 200' }], now: NOW });
  const second = recordDefect(ledger, { testCase: 'TC-ORD-03', failures: [{ check: 'check 1 (http)', message: 'status is 200' }], now: NOW });
  assert.equal(first.id, 'DEF-001');
  assert.equal(second.id, 'DEF-001');
  assert.equal(ledger.defects.length, 1);
  assert.equal(first.severity, 'unassigned');
  assert.equal(first.status, 'Confirmed');
});

test('the approval hash is the frozen digest, not a file hash', () => {
  const ledger = approved();
  assert.equal(ledger.approval.planHash, ledger.planFrozen.hash);
});

test('a binary is hashed by the ledger, belongs to android or ios, and replaces an earlier record of the same file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-ledger-'));
  try {
    const ledger = allowedLedger({ android: { status: 'ready' } });
    ledger.intake.targets.android = { packageName: 'com.example.orders' };
    const file = join(dir, 'orders.apk');
    writeFileSync(file, 'abc');
    const entry = await recordBinary(ledger, { target: 'android', file, versionName: '1.0.0', buildNumber: '1', now: NOW });
    assert.equal(entry.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
    await recordBinary(ledger, { target: 'android', file, versionName: '1.0.0', buildNumber: '2', now: NOW });
    assert.equal(ledger.binaries.length, 1);
    assert.equal(ledger.binaries[0].buildNumber, '2');
    await assert.rejects(recordBinary(ledger, { target: 'web', file, versionName: '1', buildNumber: '1', now: NOW }), /binaries belong to android or ios/);
    await assert.rejects(recordBinary(ledger, { target: 'ios', file, versionName: '1', buildNumber: '1', now: NOW }), /not in scope/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ledger round-trips through its file, and an unknown schema is refused', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-ledger-'));
  try {
    const path = join(dir, 'ledger.json');
    writeLedger(path, allowedLedger());
    assert.equal(existsSync(`${path}.tmp`), false);
    assert.equal(readLedger(path).intake.configName, 'fixture');
    writeFileSync(path, JSON.stringify({ schema: 99 }));
    assert.throws(() => readLedger(path), /schema 99 is not supported/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a ledger from v0.1, with no plan collections, reads with empty collections', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-ledger-'));
  try {
    const path = join(dir, 'ledger.json');
    writeFileSync(path, JSON.stringify({ schema: 1, intake: null, approval: null, binaries: [], journeys: [], runs: [] }));
    const ledger = readLedger(path);
    assert.deepEqual(ledger.requirements, []);
    assert.equal(ledger.planFrozen, null);
    assert.deepEqual(ledger.defects, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a copy of the ledger is independent of the original', () => {
  const ledger = approved();
  const copy = clone(ledger);
  run(copy, 'TC-AUTH-02', 'passed');
  assert.equal(ledger.runs.length, 0);
});
