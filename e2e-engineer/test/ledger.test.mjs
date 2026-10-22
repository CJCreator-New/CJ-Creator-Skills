import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emptyLedger, readLedger, recordApproval, recordBinary, recordIntake, status, writeLedger } from '../scripts/ledger.mjs';

const NOW = '2026-10-22T00:00:00.000Z';

function workdir() {
  return mkdtempSync(join(tmpdir(), 'e2e-ledger-'));
}

function allowedIntake(ledger, readiness = { web: { status: 'ready' } }) {
  recordIntake(ledger, {
    configName: 'test',
    safety: { allowed: true, problems: [], resetAllowed: false, securityProbes: { allowed: false, reason: 'none' } },
    build: { commit: 'abc', treeHash: 'def', current: true },
    probes: {},
    readiness,
    targets: { web: { baseUrl: 'http://localhost:4173' } },
    now: NOW,
  });
  return ledger;
}

function approved(ledger, dir) {
  const planPath = join(dir, 'plan.md');
  writeFileSync(planPath, 'plan body');
  recordApproval(ledger, { planPath, approver: 'tester', approvedAt: '2026-10-22' });
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
  const result = status(ledger);
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.reasons, ['refused: db "orders" does not match allowlist.dbNamePattern']);
});

test('an allowed run without an approved plan is blocked', () => {
  const result = status(allowedIntake(emptyLedger()));
  assert.equal(result.status, 'BLOCKED');
  assert.deepEqual(result.reasons, ['the test plan is not approved']);
});

test('a target in scope that is blocked keeps the run blocked, with the reason', () => {
  const dir = workdir();
  try {
    const ledger = approved(allowedIntake(emptyLedger(), { web: { status: 'ready' }, android: { status: 'blocked', reason: 'adb is not installed' } }), dir);
    assert.deepEqual(status(ledger), { status: 'BLOCKED', reasons: ['android is blocked: adb is not installed'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an approved run with no journeys is partially tested, not passed', () => {
  const dir = workdir();
  try {
    const result = status(approved(allowedIntake(emptyLedger()), dir));
    assert.deepEqual(result, { status: 'PARTIALLY TESTED', reasons: ['no journeys discovered yet'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a P0 journey without a passing run is partially tested', () => {
  const dir = workdir();
  try {
    const ledger = approved(allowedIntake(emptyLedger()), dir);
    ledger.journeys = [{ id: 'J-01', priority: 'P0' }];
    assert.deepEqual(status(ledger), { status: 'PARTIALLY TESTED', reasons: ['P0 journey J-01 is not verified'] });
    ledger.runs = [{ id: 'R-1', journey: 'J-01', result: 'passed' }];
    assert.deepEqual(status(ledger), { status: 'PASS', reasons: [] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed run gives FAIL, and FAIL takes precedence over a blocked target', () => {
  const dir = workdir();
  try {
    const ledger = approved(allowedIntake(emptyLedger(), { android: { status: 'blocked', reason: 'no device' } }), dir);
    ledger.runs = [{ id: 'R-9', journey: 'J-01', result: 'failed' }];
    assert.deepEqual(status(ledger), { status: 'FAIL', reasons: ['failed run R-9'] });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the approval hash is computed from the plan file, not supplied by the caller', () => {
  const dir = workdir();
  try {
    const ledger = allowedIntake(emptyLedger());
    const planPath = join(dir, 'plan.md');
    writeFileSync(planPath, 'plan body');
    const approval = recordApproval(ledger, { planPath, approver: 'tester', approvedAt: '2026-10-22' });
    assert.equal(approval.sha256, createHash('sha256').update('plan body').digest('hex'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a plan cannot be approved for a refused run, and an approver is required', () => {
  const dir = workdir();
  try {
    const refused = emptyLedger();
    recordIntake(refused, { configName: 't', safety: { allowed: false, problems: ['x'], resetAllowed: false }, build: {}, probes: {}, readiness: {}, targets: {}, now: NOW });
    const planPath = join(dir, 'plan.md');
    writeFileSync(planPath, 'plan body');
    assert.throws(() => recordApproval(refused, { planPath, approver: 'tester', approvedAt: '2026-10-22' }), /refused run/);
    assert.throws(() => recordApproval(allowedIntake(emptyLedger()), { planPath, approver: '  ', approvedAt: '2026-10-22' }), /approver/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a binary is hashed by the ledger, belongs to android or ios, and replaces an earlier record of the same file', async () => {
  const dir = workdir();
  try {
    const ledger = allowedIntake(emptyLedger(), { android: { status: 'ready' } });
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
  const dir = workdir();
  try {
    const path = join(dir, 'ledger.json');
    const ledger = allowedIntake(emptyLedger());
    writeLedger(path, ledger);
    assert.equal(existsSync(`${path}.tmp`), false);
    assert.deepEqual(readLedger(path).intake.configName, 'test');
    writeFileSync(path, JSON.stringify({ schema: 99 }));
    assert.throws(() => readLedger(path), /schema 99 is not supported/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
