// The mobile run, end to end on the fixture plan: the static check on the planted and clean manifests,
// and the native cases with and without a target, a binary and a device. A fake command runner stands in
// for adb and Maestro, because no device exists in this environment.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clone, fixtureLedger, NOW, seededDatabase } from './helpers.mjs';
import { freezePlan, approvePlan } from '../scripts/plan.mjs';
import { readLedger, recordBinary, writeLedger } from '../scripts/ledger.mjs';
import { runMobile } from '../scripts/run-mobile.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const PLANTED = join(HERE, '../fixtures/planted-android-config');
const CLEAN = join(HERE, '../fixtures/clean-android-config');
const ACCOUNTS = { E2E_MANAGER_USERNAME: 'manager', E2E_MANAGER_PASSWORD: 'manager-pass' };

const DEVICE = { android: { adb: true, emulatorTool: true, devices: ['emulator-5554'] }, ios: { available: false, reason: 'iOS simulators need macOS', booted: 0 }, automation: { appium: false, maestro: true } };
const NO_DEVICE = { android: { adb: false, emulatorTool: false, devices: [] }, ios: { available: false, reason: 'iOS simulators need macOS', booted: 0 }, automation: { appium: false, maestro: false } };

function fakeExec() {
  const calls = [];
  const exec = (command, args) => {
    calls.push({ command, args });
    return { status: 0, output: '' };
  };
  exec.calls = calls;
  return exec;
}

// A ledger for the fixture plan, approved, with an apk recorded for android when asked.
async function environment({ projectDir, android = null, withBinary = false } = {}) {
  const db = seededDatabase();
  const dir = mkdtempSync(join(tmpdir(), 'e2e-mobile-'));
  const ledgerPath = join(dir, 'ledger.json');
  const configPath = join(dir, 'qa.config.json');
  const config = clone(db.config);
  config.targets = { web: { baseUrl: 'http://127.0.0.1:4173' } };
  if (projectDir) config.mobileProjects = { android: projectDir };
  if (android) {
    config.targets.android = android;
    config.allowlist.packageNames = [android.packageName];
  }
  writeFileSync(configPath, JSON.stringify(config));
  const ledger = fixtureLedger({ web: { status: 'ready' } });
  // The fixture plan takes the native cases out of scope. A test that declares an android target puts
  // TC-AND-01 back in scope, to exercise the native path.
  if (android) {
    ledger.intake.targets.android = android;
    delete ledger.testCases.find((t) => t.id === 'TC-AND-01').outOfScope;
  }
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  if (withBinary) {
    const apk = join(dir, 'orders.apk');
    writeFileSync(apk, 'apk bytes');
    await recordBinary(ledger, { target: 'android', file: apk, versionName: '1.0.0', buildNumber: '1', now: NOW });
  }
  writeLedger(ledgerPath, ledger);
  return {
    dir,
    root: db.root,
    ledgerPath,
    configPath,
    close: () => {
      db.cleanup();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

function run(env, { probes = NO_DEVICE, exec = fakeExec() } = {}) {
  return runMobile({
    ledgerPath: env.ledgerPath,
    configPath: env.configPath,
    root: env.root,
    env: ACCOUNTS,
    now: NOW,
    exec,
    probes,
  });
}

describe('the planted manifest', () => {
  let env;
  let summary;
  before(async () => {
    env = await environment({ projectDir: PLANTED });
    summary = await run(env);
  });
  after(() => env.close());

  test('fails the static test case on debuggable, and opens defect 13 for it', () => {
    assert.ok(summary.failed.some((f) => f.id === 'TC-SEC-01'));
    const ledger = readLedger(env.ledgerPath);
    const defect = ledger.defects.find((d) => d.testCases.includes('TC-SEC-01'));
    assert.ok(defect, 'a defect is opened for TC-SEC-01');
    assert.match(defect.evidence[0].message, /android:debuggable is "true"/);
  });

  test('does not run the native cases, because the plan takes them out of scope', () => {
    assert.equal(summary.ran, 1);
    assert.deepEqual(summary.blocked, []);
    assert.ok(!readLedger(env.ledgerPath).runs.some((r) => ['TC-AND-01', 'TC-IOS-01'].includes(r.testCase)));
  });
});

describe('the clean manifest', () => {
  let env;
  let summary;
  before(async () => {
    env = await environment({ projectDir: CLEAN });
    summary = await run(env);
  });
  after(() => env.close());

  test('passes the static test case, and opens no defect', () => {
    assert.ok(!summary.failed.length);
    assert.equal(readLedger(env.ledgerPath).defects.length, 0);
    assert.ok(summary.results.passed >= 1);
  });
});

describe('the native cases', () => {
  test('with a declared target and a recorded binary, and a device, the flow runs and passes', async () => {
    const env = await environment({
      projectDir: CLEAN,
      android: { packageName: 'com.example.orders', flows: { 'sign-in-and-list': 'flows/sign-in-and-list.yaml' } },
      withBinary: true,
    });
    try {
      const exec = fakeExec();
      const summary = await run(env, { probes: DEVICE, exec });
      assert.ok(!summary.blocked.some((b) => b.id === 'TC-AND-01'), 'TC-AND-01 is not blocked');
      assert.deepEqual(exec.calls.map((c) => c.command), ['adb', 'maestro']);
      const run01 = readLedger(env.ledgerPath).runs.find((r) => r.testCase === 'TC-AND-01');
      assert.equal(run01.result, 'passed');
    } finally {
      env.close();
    }
  });

  test('with a declared target and no recorded binary, the case is blocked, and nothing runs', async () => {
    const env = await environment({
      projectDir: CLEAN,
      android: { packageName: 'com.example.orders', flows: { 'sign-in-and-list': 'flows/sign-in-and-list.yaml' } },
    });
    try {
      const exec = fakeExec();
      const summary = await run(env, { probes: DEVICE, exec });
      const blocked = summary.blocked.find((b) => b.id === 'TC-AND-01');
      assert.ok(blocked, 'TC-AND-01 is blocked');
      assert.match(blocked.reasons.join(' '), /no binary is recorded for android/);
      assert.equal(exec.calls.length, 0);
    } finally {
      env.close();
    }
  });

  test('with a declared target, a binary, and no device, the case is blocked with the device reason', async () => {
    const env = await environment({
      projectDir: CLEAN,
      android: { packageName: 'com.example.orders', flows: { 'sign-in-and-list': 'flows/sign-in-and-list.yaml' } },
      withBinary: true,
    });
    try {
      const summary = await run(env, { probes: NO_DEVICE });
      const blocked = summary.blocked.find((b) => b.id === 'TC-AND-01');
      assert.match(blocked.reasons.join(' '), /no Android device or emulator is connected/);
    } finally {
      env.close();
    }
  });

  test('a static test case with no mobile project is blocked, and says which setting is missing', async () => {
    const env = await environment({});
    try {
      const summary = await run(env);
      const blocked = summary.blocked.find((b) => b.id === 'TC-SEC-01');
      assert.match(blocked.reasons[0], /no Android project is declared in mobileProjects/);
    } finally {
      env.close();
    }
  });

  test('a run against a plan that changed after approval is refused, and nothing is recorded', async () => {
    const env = await environment({ projectDir: CLEAN });
    try {
      const ledger = readLedger(env.ledgerPath);
      ledger.requirements[0].text = 'a changed requirement';
      writeLedger(env.ledgerPath, ledger);
      await assert.rejects(run(env), /the plan changed after approval/);
      assert.equal(readLedger(env.ledgerPath).runs.length, 0);
    } finally {
      env.close();
    }
  });
});
