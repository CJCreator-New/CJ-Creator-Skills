// Native checks, for the static and native test cases. A static check reads the files of the mobile
// project and needs no device. A flow, compat or a11y-tree check runs on each device the target names
// (the device matrix), and it needs the binary recorded in the ledger to match the build handover. A
// missing project, flow, binary, device or tool blocks the check with its reason, and never passes it.
// A device that disconnects during a check blocks it as infrastructure, and the run stops.
//
// Secret values are never written. A hardcoded-secret finding names the file and the string's name,
// never its value.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Blocked } from './checks.mjs';
import { probeAll } from './probe.mjs';
import { redactString } from './redact.mjs';

export const STATIC_KINDS = ['manifest-attribute', 'no-hardcoded-secret'];
// flow: a Maestro flow. compat: the previous release, then the new build over it (M6). a11y-tree: the
// Android accessibility tree of a screen, optionally reached by a flow first (M8).
export const NATIVE_CHECK_KINDS = ['flow', 'compat', 'a11y-tree'];
const SECRET_NAME = /(key|secret|token|password)/i;
const PLACEHOLDER = /^\s*($|\$\{|@|TODO|CHANGEME|\*+)/;
const MIN_SECRET_VALUE = 8;

// Returns the problems with a test case's native checks. An empty list means they can run.
export function validateNativeChecks(testCase) {
  const id = testCase.id;
  if (!Array.isArray(testCase.checks) || testCase.checks.length === 0) return [`test case ${id} has no checks`];
  const problems = [];
  testCase.checks.forEach((check, i) => {
    const at = `${id} check ${i + 1}`;
    if (testCase.layer === 'static') {
      if (check?.kind !== 'static' || !STATIC_KINDS.includes(check.check)) {
        problems.push(`${at}: a static test case uses kind static with check ${STATIC_KINDS.join(' or ')}`);
        return;
      }
      if (typeof check.file !== 'string' || check.file === '') problems.push(`${at}: needs file`);
      if (check.check === 'manifest-attribute' && (typeof check.attribute !== 'string' || typeof check.equals !== 'string')) {
        problems.push(`${at}: manifest-attribute needs attribute and equals, as text`);
      }
    } else {
      if (!NATIVE_CHECK_KINDS.includes(check?.kind)) {
        problems.push(`${at}: a ${testCase.layer} test case uses kind ${NATIVE_CHECK_KINDS.join(', ')}`);
        return;
      }
      if (check.kind !== 'a11y-tree' && (typeof check.flow !== 'string' || check.flow === '')) problems.push(`${at}: ${check.kind} needs the name of a flow`);
      if (check.minDp !== undefined && !(Number.isInteger(check.minDp) && check.minDp > 0)) problems.push(`${at}: minDp must be a positive integer`);
    }
  });
  return problems;
}

// The attributes of the application element of an Android manifest, read as text.
export function applicationAttributes(xml) {
  const tag = xml.match(/<application\b([^>]*)>/);
  if (!tag) return null;
  const attributes = {};
  for (const [, name, value] of tag[1].matchAll(/([A-Za-z:]+)\s*=\s*"([^"]*)"/g)) attributes[name] = value;
  return attributes;
}

// The name and value of every string resource. Used only to find hardcoded secrets.
export function stringResources(xml) {
  return [...xml.matchAll(/<string\s+name="([^"]+)"[^>]*>([\s\S]*?)<\/string>/g)].map(([, name, value]) => ({ name, value: value.trim() }));
}

// Runs one static check against the mobile project's files. Returns { ok, message } or { blocked }.
export function runStaticCheck(check, { projectDir }) {
  const path = join(projectDir, check.file);
  if (!existsSync(path)) throw new Blocked(`${check.file} is not in the mobile project`);
  const text = readFileSync(path, 'utf8');
  if (check.check === 'manifest-attribute') {
    const attributes = applicationAttributes(text);
    if (!attributes) return { ok: false, message: `${check.file} has no application element` };
    const actual = attributes[check.attribute];
    if (actual !== check.equals) {
      return { ok: false, message: `${check.attribute} is ${actual === undefined ? 'not declared' : `"${actual}"`} in ${check.file}, expected "${check.equals}"` };
    }
    return { ok: true, message: '' };
  }
  const findings = stringResources(text).filter(
    ({ name, value }) => SECRET_NAME.test(name) && value.length >= MIN_SECRET_VALUE && !PLACEHOLDER.test(value),
  );
  if (findings.length > 0) {
    // The string's value is never in the message. Only its name and its file are.
    return { ok: false, message: `${check.file} holds a hardcoded secret in string ${findings.map((f) => f.name).join(', ')}` };
  }
  return { ok: true, message: '' };
}

// The command runner is injected, so the logic is tested without a device. The default runs the real
// tool.
export function defaultExec(command, args, { env, timeoutMs }) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: timeoutMs });
  if (result.error) return { status: null, output: result.error.message, timedOut: result.error.code === 'ETIMEDOUT' };
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`, timedOut: false };
}

const FLOW_TIMEOUT_MS = 300000;
const SHORT_MS = 60000;

// A device that went away while a check ran. The check is blocked, and the run stops (stops.mjs).
export class DeviceLost extends Blocked {}

const firstLine = (text) => String(text || '').split('\n')[0];

// The devices a native check runs on. Android: each serial in targets.android.devices (the device
// matrix), every one of which must be attached, or else the first attached device. iOS: each UDID in
// targets.ios.devices, or the booted simulator.
export function devicesFor(target, targetConfig, probes) {
  if (target === 'android') {
    const attached = probes.android.devices;
    if (attached.length === 0) throw new Blocked('no Android device or emulator is connected');
    const wanted = targetConfig.devices;
    if (Array.isArray(wanted) && wanted.length > 0) {
      const missing = wanted.filter((serial) => !attached.includes(serial));
      if (missing.length > 0) throw new Blocked(`the device matrix needs ${missing.join(', ')}, which ${missing.length === 1 ? 'is' : 'are'} not connected`);
      return wanted;
    }
    return [attached[0]];
  }
  if (!probes.ios.available || probes.ios.booted === 0) throw new Blocked('no iOS simulator is booted');
  return Array.isArray(targetConfig.devices) && targetConfig.devices.length > 0 ? targetConfig.devices : ['booted'];
}

function bothBinaries(target, targetConfig, binaries, { needPrevious = false } = {}) {
  const current = binaries.find((b) => b.target === target && (b.role ?? 'current') === 'current');
  if (!current) throw new Blocked(`no binary is recorded for ${target}; record it with ledger.mjs binary`);
  if (targetConfig.binarySha256 && targetConfig.binarySha256 !== current.sha256) {
    throw new Blocked(`the recorded ${target} binary does not match the build handover`);
  }
  const previous = binaries.find((b) => b.target === target && b.role === 'previous');
  if (needPrevious && !previous) throw new Blocked(`no previous ${target} release is recorded; record it with ledger.mjs binary --previous true`);
  return { current, previous };
}

// The steps that touch a device, as commands. Every one goes through exec.
function deviceOps({ target, targetConfig, exec, env, root, secrets, reprobe }) {
  const run = (command, args, timeoutMs = SHORT_MS) => exec(command, args, { env, timeoutMs });
  const lostOrBlocked = (device, what, output) => {
    if (reprobe) {
      const now = reprobe();
      const present = target === 'android' ? now.android.devices.includes(device) : now.ios.available && now.ios.booted > 0;
      if (!present) throw new DeviceLost(`infrastructure: the device ${device} disconnected during ${what}`);
    }
    throw new Blocked(`${what} did not complete on ${device}: ${redactString(firstLine(output), secrets)}`);
  };
  return {
    install(device, binary, { replace = true } = {}) {
      const path = resolve(root, binary.file);
      if (target === 'android') {
        const result = run('adb', ['-s', device, 'install', ...(replace ? ['-r'] : []), path], FLOW_TIMEOUT_MS);
        if (result.status !== 0) lostOrBlocked(device, 'the install', result.output);
        return;
      }
      if (!binary.file.toLowerCase().endsWith('.app')) {
        throw new Blocked('an .ipa installs on a device, not a simulator; record the simulator build (.app) for this target');
      }
      const result = run('xcrun', ['simctl', 'install', device, path], FLOW_TIMEOUT_MS);
      if (result.status !== 0) lostOrBlocked(device, 'the install', result.output);
    },
    uninstall(device) {
      if (target === 'android') run('adb', ['-s', device, 'uninstall', targetConfig.packageName]);
      else run('xcrun', ['simctl', 'uninstall', device, targetConfig.bundleId]);
    },
    flow(device, flowName, flowPath) {
      const result = run('maestro', ['--device', device, 'test', resolve(root, flowPath)], FLOW_TIMEOUT_MS);
      if (result.timedOut) throw new Blocked(`the flow ${flowName} timed out on ${device}`);
      if (result.status === 0) return { ok: true, message: '' };
      if (reprobe) {
        const now = reprobe();
        const present = target === 'android' ? now.android.devices.includes(device) : now.ios.available && now.ios.booted > 0;
        if (!present) throw new DeviceLost(`infrastructure: the device ${device} disconnected during the flow ${flowName}`);
      }
      // The first line that names the failure: an assertion, a failure, or an error.
      const line = result.output.split('\n').find((l) => /assert|fail|error/i.test(l)) || 'the flow did not complete';
      return { ok: false, message: `${device}: ${redactString(line.trim(), secrets)}` };
    },
    // A screenshot and a redacted log from the device, into the evidence folder. Video is not
    // recorded: it is large and can hold personal data (M9).
    capture(device, evidence, stem) {
      if (!evidence) return [];
      mkdirSync(evidence.dir, { recursive: true });
      const safe = device.replace(/[^A-Za-z0-9._-]/g, '_');
      const shot = join(evidence.dir, `${stem}-${safe}.png`);
      const files = [];
      if (target === 'android') {
        run('adb', ['-s', device, 'shell', 'screencap', '-p', '/sdcard/e2e-shot.png']);
        if (run('adb', ['-s', device, 'pull', '/sdcard/e2e-shot.png', shot]).status === 0) files.push(join(evidence.rel, `${stem}-${safe}.png`));
        const log = run('adb', ['-s', device, 'logcat', '-d', '-t', '300']);
        if (log.status === 0) {
          writeFileSync(join(evidence.dir, `${stem}-${safe}.log`), `${redactString(log.output, secrets)}\n`);
          files.push(join(evidence.rel, `${stem}-${safe}.log`));
        }
      } else if (run('xcrun', ['simctl', 'io', device, 'screenshot', shot]).status === 0) {
        files.push(join(evidence.rel, `${stem}-${safe}.png`));
      }
      return files;
    },
    // The Android accessibility tree of the screen on show, from uiautomator, and the screen density.
    tree(device) {
      const dump = run('adb', ['-s', device, 'shell', 'uiautomator', 'dump', '/sdcard/e2e-ui.xml']);
      if (dump.status !== 0) lostOrBlocked(device, 'the accessibility dump', dump.output);
      const xml = run('adb', ['-s', device, 'shell', 'cat', '/sdcard/e2e-ui.xml']);
      const density = run('adb', ['-s', device, 'shell', 'wm', 'density']);
      const values = [...String(density.output).matchAll(/density:\s*(\d+)/gi)].map((m) => Number(m[1]));
      return { xml: xml.output, density: values.length ? values[values.length - 1] : 160 };
    },
  };
}

// The problems on an Android screen, from its uiautomator dump: a control that can be clicked but has
// no text and no content description (TalkBack has nothing to read), and a control smaller than
// minDp density-independent pixels (48 by default) in either direction.
export function treeProblems(xml, density, minDp = 48) {
  const problems = [];
  for (const [, attrs] of String(xml).matchAll(/<node\b([^>]*?)\/?>/g)) {
    const attr = (name) => (attrs.match(new RegExp(`\\b${name}="([^"]*)"`)) || [])[1] ?? '';
    if (attr('clickable') !== 'true') continue;
    const label = attr('text') || attr('content-desc');
    const id = attr('resource-id') || attr('class');
    if (!label) problems.push(`${id} can be clicked but has no text or content description`);
    const b = attr('bounds').match(/\[(\d+),(\d+)\]\[(\d+),(\d+)\]/);
    if (b) {
      const toDp = (px) => Math.round((px * 160) / density);
      const w = toDp(Number(b[3]) - Number(b[1]));
      const h = toDp(Number(b[4]) - Number(b[2]));
      if (w < minDp || h < minDp) problems.push(`${label || id} is ${w} by ${h} dp, under ${minDp} dp`);
    }
  }
  return problems;
}

// Runs one native check: a flow, a previous-version compatibility run, or an accessibility-tree check.
// Each runs on every device the target names, and the check passes only when it passes on each.
export function runFlowCheck(check, ctx) {
  const { target, targetConfig, binaries, probes, root, exec = defaultExec } = ctx;
  if (!targetConfig) throw new Blocked(`target ${target} is not in scope for this run`);
  const kind = check.kind;
  if (kind === 'a11y-tree' && target === 'ios') {
    throw new Blocked('the iOS accessibility tree needs XCUITest, which this runner does not drive; check it in the app\'s UI tests');
  }
  const flowPath = check.flow ? targetConfig.flows?.[check.flow] : null;
  if (check.flow && !flowPath) throw new Blocked(`flow ${check.flow} is not declared for target ${target}`);
  const { current, previous } = bothBinaries(target, targetConfig, binaries, { needPrevious: kind === 'compat' });
  const devices = devicesFor(target, targetConfig, probes);
  if (!probes.automation.maestro && kind !== 'a11y-tree') throw new Blocked('Maestro is not installed');
  const ops = deviceOps({ ...ctx, exec, root });
  const evidence = [];
  const failures = [];
  for (const device of devices) {
    if (kind === 'compat') {
      // The previous release first, signed in and used, then the new build over it, keeping its data.
      ops.uninstall(device);
      ops.install(device, previous, { replace: false });
      const before = ops.flow(device, check.flow, flowPath);
      if (!before.ok) failures.push(`on the previous release (${previous.versionName}): ${before.message}`);
      ops.install(device, current, { replace: true });
      const after = ops.flow(device, check.flow, flowPath);
      if (!after.ok) failures.push(`after the upgrade to ${current.versionName}: ${after.message}`);
    } else if (kind === 'a11y-tree') {
      if (flowPath) {
        ops.install(device, current);
        const reach = ops.flow(device, check.flow, flowPath);
        if (!reach.ok) failures.push(`the flow to the screen failed: ${reach.message}`);
      }
      if (failures.length === 0) {
        const { xml, density } = ops.tree(device);
        const problems = treeProblems(xml, density, check.minDp ?? 48);
        if (problems.length > 0) failures.push(`${device}: ${problems.slice(0, 5).join('; ')}${problems.length > 5 ? `; and ${problems.length - 5} more` : ''}`);
      }
    } else {
      ops.install(device, current);
      const outcome = ops.flow(device, check.flow, flowPath);
      if (!outcome.ok) failures.push(outcome.message);
    }
    evidence.push(...ops.capture(device, ctx.evidence, ctx.stem ?? 'native'));
  }
  return { ok: failures.length === 0, message: failures.join('; '), evidence };
}

// Runs one native test case. Stops at the first failing check, as the other runners do.
export async function runNativeTestCase({ testCase, ctx }) {
  const problems = validateNativeChecks(testCase);
  if (problems.length > 0) return { result: 'blocked', failures: [], reasons: problems, evidence: [] };
  const evidence = [];
  for (const [i, check] of testCase.checks.entries()) {
    const label = `check ${i + 1} (${check.kind}${check.check ? `:${check.check}` : ''})`;
    let outcome;
    try {
      outcome = check.kind === 'static' ? runStaticCheck(check, ctx) : runFlowCheck(check, { ...ctx, target: testCase.layer, stem: testCase.id });
    } catch (error) {
      if (error instanceof Blocked) {
        return { result: 'blocked', failures: [], reasons: [`${label}: ${error.message}`], evidence, deviceLost: error instanceof DeviceLost };
      }
      throw error;
    }
    evidence.push(...(outcome.evidence || []));
    evidence.push({ check: label, ok: outcome.ok, message: outcome.message });
    if (!outcome.ok) return { result: 'failed', failures: [{ check: label, message: outcome.message }], reasons: [], evidence };
  }
  return { result: 'passed', failures: [], reasons: [], evidence };
}

// The probes, taken at the time of the run.
export function currentProbes(env) {
  return probeAll({ env, platform: process.platform });
}
