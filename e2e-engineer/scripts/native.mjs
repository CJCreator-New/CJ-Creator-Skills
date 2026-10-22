// Native checks, for the static and native test cases. A static check reads the files of the mobile
// project and needs no device. A flow check runs a Maestro flow on an attached Android device or a
// booted iOS simulator, and it needs the binary recorded in the ledger to match the build handover. A
// missing project, flow, binary, device or tool blocks the check with its reason, and never passes it.
//
// Secret values are never written. A hardcoded-secret finding names the file and the string's name,
// never its value.

import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Blocked } from './checks.mjs';
import { probeAll } from './probe.mjs';
import { redactString } from './redact.mjs';

export const STATIC_KINDS = ['manifest-attribute', 'no-hardcoded-secret'];
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
      if (check?.kind !== 'flow') {
        problems.push(`${at}: a ${testCase.layer} test case uses kind flow`);
        return;
      }
      if (typeof check.flow !== 'string' || check.flow === '') problems.push(`${at}: flow needs the name of a flow`);
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

// Runs a Maestro flow, after the checks that come before it. The command runner is injected, so the
// logic is tested without a device. The default runs the real tool.
export function defaultExec(command, args, { env, timeoutMs }) {
  const result = spawnSync(command, args, { env, encoding: 'utf8', timeout: timeoutMs });
  if (result.error) return { status: null, output: result.error.message, timedOut: result.error.code === 'ETIMEDOUT' };
  return { status: result.status, output: `${result.stdout || ''}${result.stderr || ''}`, timedOut: false };
}

const FLOW_TIMEOUT_MS = 300000;

// Runs one flow check. The binary must match the target's expected hash, when the config declares one.
export function runFlowCheck(check, { target, targetConfig, binaries, probes, env, secrets, root, exec = defaultExec }) {
  if (!targetConfig) throw new Blocked(`target ${target} is not in scope for this run`);
  const flowPath = targetConfig.flows?.[check.flow];
  if (!flowPath) throw new Blocked(`flow ${check.flow} is not declared for target ${target}`);
  const binary = binaries.find((b) => b.target === target);
  if (!binary) throw new Blocked(`no binary is recorded for ${target}; record it with ledger.mjs binary`);
  if (targetConfig.binarySha256 && targetConfig.binarySha256 !== binary.sha256) {
    throw new Blocked(`the recorded ${target} binary does not match the build handover`);
  }
  if (target === 'android') {
    if (probes.android.devices.length === 0) throw new Blocked('no Android device or emulator is connected');
    if (!probes.automation.maestro) throw new Blocked('Maestro is not installed');
    const install = exec('adb', ['install', '-r', resolve(root, binary.file)], { env, timeoutMs: FLOW_TIMEOUT_MS });
    if (install.status !== 0) throw new Blocked(`the binary did not install: ${redactString(install.output.split('\n')[0], secrets)}`);
  } else {
    if (!probes.ios.available || probes.ios.booted === 0) throw new Blocked('no iOS simulator is booted');
    if (!probes.automation.maestro) throw new Blocked('Maestro is not installed');
    throw new Blocked('installing the iOS binary is not implemented yet; the flow needs the app installed on the simulator');
  }

  const run = exec('maestro', ['test', resolve(root, flowPath)], { env, timeoutMs: FLOW_TIMEOUT_MS });
  if (run.timedOut) throw new Blocked(`the flow ${check.flow} timed out`);
  if (run.status === 0) return { ok: true, message: '' };
  // The first line that names the failure: an assertion, a failure, or an error.
  const line = run.output.split('\n').find((l) => /assert|fail|error/i.test(l)) || 'the flow did not complete';
  return { ok: false, message: redactString(line.trim(), secrets) };
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
      outcome = check.kind === 'static' ? runStaticCheck(check, ctx) : runFlowCheck(check, { ...ctx, target: testCase.layer });
    } catch (error) {
      if (error instanceof Blocked) return { result: 'blocked', failures: [], reasons: [`${label}: ${error.message}`], evidence };
      throw error;
    }
    evidence.push({ check: label, ok: outcome.ok, message: outcome.message });
    if (!outcome.ok) return { result: 'failed', failures: [{ check: label, message: outcome.message }], reasons: [], evidence };
  }
  return { result: 'passed', failures: [], reasons: [], evidence };
}

// The probes, taken at the time of the run.
export function currentProbes(env) {
  return probeAll({ env, platform: process.platform });
}
