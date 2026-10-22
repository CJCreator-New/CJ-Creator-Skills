import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { allowedLedger, fixtureLedger, NOW } from './helpers.mjs';
import { emptyLedger, readLedger, recordBinary, recordIntake, status, writeLedger } from '../scripts/ledger.mjs';
import { approvePlan, freezePlan } from '../scripts/plan.mjs';

const P0_JOURNEYS = ['J-01', 'J-02', 'J-03', 'J-04'];

function withRuns(ledger, journeyIds) {
  ledger.runs = journeyIds.map((journey, i) => ({ id: `R-${i}`, journey, result: 'passed' }));
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

test('an approved plan with no runs is partially tested', () => {
  const ledger = fixtureLedger();
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  const result = status(ledger);
  assert.equal(result.status, 'PARTIALLY TESTED');
  assert.deepEqual(result.reasons, P0_JOURNEYS.map((id) => `P0 journey ${id} is not verified`));
});

test('the gate passes only when every P0 journey has a passing run', () => {
  const ledger = fixtureLedger();
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  withRuns(ledger, P0_JOURNEYS.slice(0, 3));
  assert.equal(status(ledger).status, 'PARTIALLY TESTED');
  withRuns(ledger, P0_JOURNEYS);
  assert.deepEqual(status(ledger), { status: 'PASS', reasons: [] });
});

test('a target in scope that is blocked keeps the run blocked, with the reason', () => {
  const ledger = fixtureLedger({ web: { status: 'ready' }, android: { status: 'blocked', reason: 'adb is not installed' } });
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  assert.deepEqual(status(ledger), { status: 'BLOCKED', reasons: ['android is blocked: adb is not installed'] });
});

test('a failed run gives FAIL, and FAIL takes precedence over a blocked target', () => {
  const ledger = fixtureLedger({ android: { status: 'blocked', reason: 'no device' } });
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  ledger.runs = [{ id: 'R-9', journey: 'J-01', result: 'failed' }];
  assert.deepEqual(status(ledger), { status: 'FAIL', reasons: ['failed run R-9'] });
});

test('a change to the plan after approval makes the approval stale, and the gate blocks', () => {
  const ledger = fixtureLedger();
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  ledger.testCases[0].expected = ['a different expected result'];
  assert.deepEqual(status(ledger), {
    status: 'BLOCKED',
    reasons: ['the plan changed after it was approved; freeze and approve the new version'],
  });
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
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
