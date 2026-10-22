import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Blocked } from '../scripts/checks.mjs';
import { applicationAttributes, runFlowCheck, runNativeTestCase, runStaticCheck, stringResources, validateNativeChecks } from '../scripts/native.mjs';

const FIXTURES = new URL('../fixtures/', import.meta.url).pathname;
const PLANTED = `${FIXTURES}planted-android-config`;
const CLEAN = `${FIXTURES}clean-android-config`;

const probesWith = ({ devices = ['emulator-5554'], maestro = true, booted = 0, iosAvailable = false } = {}) => ({
  android: { adb: true, emulatorTool: true, devices },
  ios: { available: iosAvailable, booted, reason: iosAvailable ? null : 'iOS simulators need macOS' },
  automation: { appium: false, maestro },
});

// A fake command runner. It records each call, and answers with the result for each command name.
function fakeExec(answers = {}) {
  const calls = [];
  const exec = (command, args) => {
    calls.push({ command, args });
    return answers[command] ?? { status: 0, output: '' };
  };
  exec.calls = calls;
  return exec;
}

describe('validateNativeChecks', () => {
  test('a static test case takes static checks, and a native one takes flow checks', () => {
    assert.deepEqual(validateNativeChecks({ id: 'TC-S', layer: 'static', checks: [{ kind: 'static', check: 'no-hardcoded-secret', file: 'x.xml' }] }), []);
    assert.deepEqual(validateNativeChecks({ id: 'TC-A', layer: 'android', checks: [{ kind: 'flow', target: 'android', flow: 'sign-in' }] }), []);
    assert.match(validateNativeChecks({ id: 'TC-A', layer: 'android', checks: [{ kind: 'http' }] })[0], /uses kind flow/);
    assert.match(validateNativeChecks({ id: 'TC-S', layer: 'static', checks: [{ kind: 'flow' }] })[0], /uses kind static/);
  });

  test('a manifest attribute check needs its attribute and its expected value', () => {
    const problems = validateNativeChecks({ id: 'TC-S', layer: 'static', checks: [{ kind: 'static', check: 'manifest-attribute', file: 'AndroidManifest.xml' }] });
    assert.match(problems[0], /needs attribute and equals/);
  });
});

describe('the manifest and resource readers', () => {
  test('read the application attributes, and the string resources, from the planted fixture', () => {
    const planted = readFixture('AndroidManifest.xml', PLANTED);
    assert.equal(applicationAttributes(planted)['android:debuggable'], 'true');
    assert.deepEqual(stringResources(readFixture('res/values/strings.xml', PLANTED)).map((s) => s.name), ['app_name', 'api_key']);
  });

  test('a manifest with no application element has no attributes', () => {
    assert.equal(applicationAttributes('<manifest></manifest>'), null);
  });
});

describe('static checks', () => {
  test('the planted manifest fails on debuggable, and says so, with the value it found', () => {
    const outcome = runStaticCheck({ kind: 'static', check: 'manifest-attribute', file: 'AndroidManifest.xml', attribute: 'android:debuggable', equals: 'false' }, { projectDir: PLANTED });
    assert.equal(outcome.ok, false);
    assert.equal(outcome.message, 'android:debuggable is "true" in AndroidManifest.xml, expected "false"');
  });

  test('the clean manifest passes the same check', () => {
    const outcome = runStaticCheck({ kind: 'static', check: 'manifest-attribute', file: 'AndroidManifest.xml', attribute: 'android:debuggable', equals: 'false' }, { projectDir: CLEAN });
    assert.equal(outcome.ok, true);
  });

  test('an attribute that is not declared is a failure, not a pass', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-native-'));
    try {
      writeFileSync(join(dir, 'AndroidManifest.xml'), '<manifest><application android:label="x"></application></manifest>');
      const outcome = runStaticCheck({ kind: 'static', check: 'manifest-attribute', file: 'AndroidManifest.xml', attribute: 'android:debuggable', equals: 'false' }, { projectDir: dir });
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /not declared/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a hardcoded secret is reported by its string name, and its value is never in the message', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-native-'));
    try {
      mkdirSync(join(dir, 'res/values'), { recursive: true });
      writeFileSync(join(dir, 'res/values/strings.xml'), '<resources><string name="api_key">FIXTURE-KEY-0000-NOT-REAL</string><string name="app_name">Orders</string></resources>');
      const outcome = runStaticCheck({ kind: 'static', check: 'no-hardcoded-secret', file: 'res/values/strings.xml' }, { projectDir: dir });
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /hardcoded secret in string api_key/);
      assert.ok(!outcome.message.includes('FIXTURE-KEY'), 'the value must not appear in the message');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a placeholder value is not a secret', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-native-'));
    try {
      mkdirSync(join(dir, 'res/values'), { recursive: true });
      writeFileSync(join(dir, 'res/values/strings.xml'), '<resources><string name="api_key">${API_KEY}</string></resources>');
      assert.equal(runStaticCheck({ kind: 'static', check: 'no-hardcoded-secret', file: 'res/values/strings.xml' }, { projectDir: dir }).ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('a file that is not in the project blocks the check, and does not pass it', () => {
    assert.throws(() => runStaticCheck({ kind: 'static', check: 'no-hardcoded-secret', file: 'missing.xml' }, { projectDir: CLEAN }), (e) => e instanceof Blocked);
  });
});

describe('flow checks', () => {
  const targetConfig = { flows: { 'sign-in-and-list': 'flows/sign-in-and-list.yaml' } };
  const binaries = [{ target: 'android', file: 'builds/orders.apk', sha256: 'abc123' }];
  const base = { target: 'android', targetConfig, binaries, probes: probesWith(), env: {}, secrets: [], root: '/repo' };
  const check = { kind: 'flow', target: 'android', flow: 'sign-in-and-list' };

  test('a target that is not in scope is blocked', () => {
    assert.throws(() => runFlowCheck(check, { ...base, targetConfig: null }), /target android is not in scope/);
  });

  test('a flow that is not declared is blocked', () => {
    assert.throws(() => runFlowCheck({ ...check, flow: 'other' }, base), /flow other is not declared for target android/);
  });

  test('a missing binary is blocked, and the message says how to record it', () => {
    assert.throws(() => runFlowCheck(check, { ...base, binaries: [] }), /record it with ledger.mjs binary/);
  });

  test('a binary that does not match the build handover is blocked, not run', () => {
    const exec = fakeExec();
    assert.throws(() => runFlowCheck(check, { ...base, targetConfig: { ...targetConfig, binarySha256: 'expected' }, exec }), /does not match the build handover/);
    assert.equal(exec.calls.length, 0, 'nothing runs against a binary that does not match');
  });

  test('no device, and no Maestro, each block the check with its reason', () => {
    assert.throws(() => runFlowCheck(check, { ...base, probes: probesWith({ devices: [] }) }), /no Android device or emulator is connected/);
    assert.throws(() => runFlowCheck(check, { ...base, probes: probesWith({ maestro: false }) }), /Maestro is not installed/);
  });

  test('an iOS flow is blocked, because installing the iOS binary is not implemented yet', () => {
    const iosBase = {
      ...base,
      target: 'ios',
      probes: probesWith({ iosAvailable: true, booted: 1 }),
      targetConfig: { flows: { 'sign-in-and-list': 'flows/sign-in-and-list.yaml' } },
      binaries: [{ target: 'ios', file: 'builds/Orders.ipa', sha256: 'def456' }],
    };
    assert.throws(() => runFlowCheck({ ...check, target: 'ios' }, iosBase), /installing the iOS binary is not implemented/);
  });

  test('a flow that passes runs against the installed binary, and the run is reported as passed', () => {
    const exec = fakeExec();
    assert.deepEqual(runFlowCheck(check, { ...base, exec }), { ok: true, message: '' });
    assert.deepEqual(exec.calls.map((c) => c.command), ['adb', 'maestro']);
  });

  test('a failing flow reports its failing line, with any credential redacted', () => {
    const exec = fakeExec({ maestro: { status: 1, output: 'Running flow\nAssertion is false: "Orders" is visible, password manager-pass\nFAILED' } });
    const outcome = runFlowCheck(check, { ...base, exec, secrets: ['manager-pass'] });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Assertion is false/);
    assert.ok(!outcome.message.includes('manager-pass'));
  });

  test('a flow that times out is blocked, and is not a failure', () => {
    const exec = fakeExec({ maestro: { status: null, output: 'timed out', timedOut: true } });
    assert.throws(() => runFlowCheck(check, { ...base, exec }), /timed out/);
  });

  test('a native test case with a blocked check is blocked, with the reason, and not failed', async () => {
    const result = await runNativeTestCase({
      testCase: { id: 'TC-AND-01', layer: 'android', checks: [check] },
      ctx: { ...base, targetConfig: null },
    });
    assert.equal(result.result, 'blocked');
    assert.match(result.reasons[0], /not in scope/);
  });
});

describe('a static test case', () => {
  test('passes on the clean project and fails on the planted one, at its first failing check', async () => {
    const checks = [
      { kind: 'static', check: 'manifest-attribute', file: 'AndroidManifest.xml', attribute: 'android:debuggable', equals: 'false' },
      { kind: 'static', check: 'no-hardcoded-secret', file: 'res/values/strings.xml' },
    ];
    assert.equal((await runNativeTestCase({ testCase: { id: 'TC-SEC-01', layer: 'static', checks }, ctx: { projectDir: CLEAN } })).result, 'passed');
    const planted = await runNativeTestCase({ testCase: { id: 'TC-SEC-01', layer: 'static', checks }, ctx: { projectDir: PLANTED } });
    assert.equal(planted.result, 'failed');
    assert.equal(planted.failures[0].check, 'check 1 (static:manifest-attribute)');
  });
});

function readFixture(name, dir) {
  return readFileSync(join(dir, name), 'utf8');
}
