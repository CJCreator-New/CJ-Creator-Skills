import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Blocked } from '../scripts/checks.mjs';
import { DeviceLost, applicationAttributes, runFlowCheck, runNativeTestCase, runStaticCheck, stringResources, treeProblems, validateNativeChecks } from '../scripts/native.mjs';

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
    assert.match(validateNativeChecks({ id: 'TC-A', layer: 'android', checks: [{ kind: 'http' }] })[0], /uses kind flow, compat, a11y-tree/);
    assert.deepEqual(validateNativeChecks({ id: 'TC-A', layer: 'android', checks: [{ kind: 'a11y-tree' }] }), []);
    assert.match(validateNativeChecks({ id: 'TC-A', layer: 'android', checks: [{ kind: 'compat' }] })[0], /compat needs the name of a flow/);
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
  const targetConfig = { flows: { 'sign-in-and-list': 'flows/sign-in-and-list.yaml' }, packageName: 'com.example.orders' };
  const binaries = [{ target: 'android', role: 'current', file: 'builds/orders.apk', sha256: 'abc123', versionName: '2.0.0' }];
  const base = { target: 'android', targetConfig, binaries, probes: probesWith(), env: {}, secrets: [], root: '/repo' };
  const check = { kind: 'flow', target: 'android', flow: 'sign-in-and-list' };
  const commands = (exec) => exec.calls.map((c) => [c.command, ...c.args.filter((a) => !a.startsWith('/'))].join(' '));

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

  test('a flow that passes installs the binary on the device, then runs the flow on it', () => {
    const exec = fakeExec();
    assert.deepEqual(runFlowCheck(check, { ...base, exec }), { ok: true, message: '', evidence: [] });
    assert.deepEqual(commands(exec), ['adb -s emulator-5554 install -r', 'maestro --device emulator-5554 test']);
  });

  test('the device matrix runs on every listed device, and a missing one blocks the check', () => {
    const exec = fakeExec();
    const matrix = { ...base, targetConfig: { ...targetConfig, devices: ['pixel-7', 'pixel-4a'] }, probes: probesWith({ devices: ['pixel-7', 'pixel-4a'] }), exec };
    assert.equal(runFlowCheck(check, matrix).ok, true);
    assert.deepEqual(commands(exec).filter((c) => c.startsWith('maestro')), ['maestro --device pixel-7 test', 'maestro --device pixel-4a test']);
    assert.throws(() => runFlowCheck(check, { ...matrix, probes: probesWith({ devices: ['pixel-7'] }) }), /the device matrix needs pixel-4a, which is not connected/);
  });

  test('a failure on one device of the matrix fails the check, and names the device', () => {
    const exec = (command, args) => (command === 'maestro' && args[1] === 'pixel-4a' ? { status: 1, output: 'Assertion is false: "Orders" is visible' } : { status: 0, output: '' });
    const outcome = runFlowCheck(check, { ...base, targetConfig: { ...targetConfig, devices: ['pixel-7', 'pixel-4a'] }, probes: probesWith({ devices: ['pixel-7', 'pixel-4a'] }), exec });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /^pixel-4a: Assertion is false/);
  });

  test('a failing flow reports its failing line, with any credential redacted', () => {
    const exec = fakeExec({ maestro: { status: 1, output: 'Running flow\nAssertion is false: "Orders" is visible, password manager-pass\nFAILED' } });
    const outcome = runFlowCheck(check, { ...base, exec, secrets: ['manager-pass'] });
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /Assertion is false/);
    assert.ok(!outcome.message.includes('manager-pass'));
  });

  test('a device that disconnects during the flow is lost, not a failure in the app', () => {
    const exec = fakeExec({ maestro: { status: 1, output: 'device offline' } });
    assert.throws(() => runFlowCheck(check, { ...base, exec, reprobe: () => probesWith({ devices: [] }) }), (e) => e instanceof DeviceLost && /emulator-5554 disconnected during the flow/.test(e.message));
  });

  test('a flow that times out is blocked, and is not a failure', () => {
    const exec = fakeExec({ maestro: { status: null, output: 'timed out', timedOut: true } });
    assert.throws(() => runFlowCheck(check, { ...base, exec }), /timed out/);
  });

  test('device evidence: a screenshot pulled from the device and a redacted log', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-native-'));
    try {
      const exec = fakeExec({ adb: { status: 0, output: 'I/Orders: signed in with manager-pass' } });
      const outcome = runFlowCheck(check, { ...base, exec, secrets: ['manager-pass'], stem: 'TC-AND-01', evidence: { dir, rel: 'evidence/run' } });
      assert.deepEqual(outcome.evidence, ['evidence/run/TC-AND-01-emulator-5554.png', 'evidence/run/TC-AND-01-emulator-5554.log']);
      assert.ok(commands(exec).includes('adb -s emulator-5554 shell screencap -p'));
      const log = readFileSync(join(dir, 'TC-AND-01-emulator-5554.log'), 'utf8');
      assert.ok(!log.includes('manager-pass'), 'the device log is redacted');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  describe('on iOS', () => {
    const iosBase = {
      ...base,
      target: 'ios',
      probes: probesWith({ iosAvailable: true, booted: 1 }),
      targetConfig: { flows: { 'sign-in-and-list': 'flows/sign-in-and-list.yaml' }, bundleId: 'com.example.orders' },
    };

    test('a simulator build (.app) installs with simctl, and the flow runs on the booted simulator', () => {
      const exec = fakeExec();
      const outcome = runFlowCheck({ ...check, target: 'ios' }, { ...iosBase, exec, binaries: [{ target: 'ios', file: 'builds/Orders.app', sha256: 'def456' }] });
      assert.equal(outcome.ok, true);
      assert.deepEqual(commands(exec), ['xcrun simctl install booted', 'maestro --device booted test']);
    });

    test('an .ipa is for a device, so the simulator run is blocked with the reason', () => {
      assert.throws(
        () => runFlowCheck({ ...check, target: 'ios' }, { ...iosBase, exec: fakeExec(), binaries: [{ target: 'ios', file: 'builds/Orders.ipa', sha256: 'def456' }] }),
        /an \.ipa installs on a device, not a simulator/,
      );
    });

    test('the iOS accessibility tree needs XCUITest, so it is blocked', () => {
      assert.throws(() => runFlowCheck({ kind: 'a11y-tree' }, { ...iosBase, binaries: [] }), /needs XCUITest/);
    });
  });

  describe('previous-version compatibility', () => {
    const compat = { kind: 'compat', flow: 'sign-in-and-list' };
    const both = [...binaries, { target: 'android', role: 'previous', file: 'builds/orders-1.9.apk', sha256: 'old', versionName: '1.9.0' }];

    test('installs the previous release clean, runs the flow, installs the new build over it, and runs it again', () => {
      const exec = fakeExec();
      assert.equal(runFlowCheck(compat, { ...base, binaries: both, exec }).ok, true);
      assert.deepEqual(commands(exec), [
        'adb -s emulator-5554 uninstall com.example.orders',
        'adb -s emulator-5554 install',
        'maestro --device emulator-5554 test',
        'adb -s emulator-5554 install -r',
        'maestro --device emulator-5554 test',
      ]);
    });

    test('a flow that fails after the upgrade fails the check, and says it was after the upgrade', () => {
      let flows = 0;
      const exec = (command) => (command === 'maestro' && (flows += 1) === 2 ? { status: 1, output: 'Assertion is false: session kept' } : { status: 0, output: '' });
      const outcome = runFlowCheck(compat, { ...base, binaries: both, exec });
      assert.match(outcome.message, /^after the upgrade to 2\.0\.0: emulator-5554: Assertion is false/);
    });

    test('without a recorded previous release, the check is blocked', () => {
      assert.throws(() => runFlowCheck(compat, { ...base, exec: fakeExec() }), /no previous android release is recorded/);
    });
  });

  describe('the Android accessibility tree', () => {
    const dump = `<hierarchy><node class="android.widget.Button" text="Approve" clickable="true" bounds="[0,0][300,147]"/>
      <node class="android.widget.ImageButton" resource-id="com.example.orders:id/export" content-desc="" text="" clickable="true" bounds="[0,200][84,284]"/>
      <node class="android.widget.TextView" text="Orders" clickable="false" bounds="[0,300][500,350]"/></hierarchy>`;

    test('finds clickable controls with no label and controls under 48 dp, and passes a clean screen', () => {
      // 420 dpi: 147 px is 56 dp; 84 px is 32 dp.
      assert.deepEqual(treeProblems(dump, 420), [
        'com.example.orders:id/export can be clicked but has no text or content description',
        'com.example.orders:id/export is 32 by 32 dp, under 48 dp',
      ]);
      assert.deepEqual(treeProblems('<node text="Approve" clickable="true" bounds="[0,0][300,300]"/>', 420), []);
    });

    test('runs the flow to the screen first, then reads the tree and the density from the device', () => {
      const exec = (command, args) => {
        if (args.includes('cat')) return { status: 0, output: dump };
        if (args.includes('density')) return { status: 0, output: 'Physical density: 420' };
        return { status: 0, output: '' };
      };
      const outcome = runFlowCheck({ kind: 'a11y-tree', flow: 'sign-in-and-list' }, { ...base, exec });
      assert.equal(outcome.ok, false);
      assert.match(outcome.message, /^emulator-5554: com\.example\.orders:id\/export can be clicked but has no text/);
    });
  });

  test('a native test case with a blocked check is blocked, with the reason, and not failed', async () => {
    const result = await runNativeTestCase({
      testCase: { id: 'TC-AND-01', layer: 'android', checks: [check] },
      ctx: { ...base, targetConfig: null },
    });
    assert.equal(result.result, 'blocked');
    assert.match(result.reasons[0], /not in scope/);
  });

  test('a lost device makes the test case blocked and marks it, so the run stops', async () => {
    const result = await runNativeTestCase({
      testCase: { id: 'TC-AND-01', layer: 'android', checks: [check] },
      ctx: { ...base, exec: fakeExec({ maestro: { status: 1, output: 'device offline' } }), reprobe: () => probesWith({ devices: [] }) },
    });
    assert.equal(result.result, 'blocked');
    assert.equal(result.deviceLost, true);
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
