#!/usr/bin/env node
// The ledger for one e2e-engineer run. It is the only writer of the run's state. It computes the
// hashes it records (the native binary and the frozen plan) itself, so a caller cannot supply them.
// Run state lives in <repo>/.claude/e2e-engineer/ledger.json, which the target repo ignores.

import { readFileSync, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeBinary } from './binary.mjs';
import { PLAN_COLLECTIONS, addItem, approvePlan, freezePlan, loadPlan, planDigest } from './plan.mjs';

export const SCHEMA = 1;
export const STATUSES = ['PASS', 'PASS WITH ACCEPTED RISKS', 'FAIL', 'BLOCKED', 'PARTIALLY TESTED'];

export function defaultLedgerPath(root) {
  return join(root, '.claude', 'e2e-engineer', 'ledger.json');
}

export function emptyLedger() {
  const plan = Object.fromEntries(PLAN_COLLECTIONS.map((key) => [key, []]));
  return { schema: SCHEMA, intake: null, designMap: null, planFrozen: null, approval: null, binaries: [], runs: [], defects: [], ...plan };
}

export function readLedger(path) {
  if (!existsSync(path)) return emptyLedger();
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  if (ledger.schema !== SCHEMA) throw new Error(`ledger schema ${ledger.schema} is not supported (expected ${SCHEMA})`);
  return { ...emptyLedger(), ...ledger };
}

// Writes through a temporary file, so an interrupted write cannot leave a half-written ledger.
export function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

// Records what intake found. A refused run is recorded too, so the status can say why nothing ran.
export function recordIntake(ledger, { configName, safety, build, probes, readiness, targets, now }) {
  ledger.intake = {
    configName,
    recordedAt: now,
    build,
    safety,
    probes,
    targets: targets || {},
    readiness: readiness || {},
  };
  return ledger;
}

// The native binary is hashed by the ledger. It must belong to an Android or iOS target in scope.
export async function recordBinary(ledger, { target, file, versionName, buildNumber, now }) {
  if (!ledger.intake || !ledger.intake.safety.allowed) throw new Error('a binary cannot be recorded before a run is allowed');
  if (!['android', 'ios'].includes(target)) throw new Error(`binaries belong to android or ios, not ${target}`);
  if (!ledger.intake.targets[target]) throw new Error(`target ${target} is not in scope for this run`);
  if (!versionName || !buildNumber) throw new Error('versionName and buildNumber are required');
  const described = await describeBinary(file);
  const entry = { target, ...described, versionName, buildNumber, recordedAt: now };
  ledger.binaries = ledger.binaries.filter((b) => !(b.target === target && b.file === file));
  ledger.binaries.push(entry);
  return entry;
}

// The state of one test case, from its latest run. A run counts only for the build it ran on. A run
// from an earlier build is stale, and it does not count.
export function testState(ledger, testCaseId) {
  const runs = ledger.runs.filter((run) => run.testCase === testCaseId);
  if (runs.length === 0) return { state: 'not run' };
  const latest = runs[runs.length - 1];
  if (!ledger.intake?.build?.current || latest.build !== ledger.intake.build.treeHash) return { state: 'stale', run: latest.id };
  return { state: latest.result, run: latest.id, reasons: latest.reasons || [] };
}

function journeyTests(ledger, journeyId) {
  return ledger.testCases.filter((tc) => (tc.journeys || []).includes(journeyId));
}

// Gate status with the precedence in the plan (G19): a failed test gives FAIL; an unmet or blocked
// mandatory gate gives BLOCKED; a P0 journey that is not verified gives PARTIALLY TESTED; otherwise
// PASS. A P0 journey is verified only when every test case linked to it has a current pass.
// An approval counts only for the plan it was given for. A later change to the plan makes it stale.
export function status(ledger) {
  const failed = ledger.testCases.filter((tc) => testState(ledger, tc.id).state === 'failed');
  if (failed.length > 0) return { status: 'FAIL', reasons: failed.map((tc) => `${tc.id} failed`) };

  if (!ledger.intake) return { status: 'BLOCKED', reasons: ['intake has not run'] };
  if (!ledger.intake.safety.allowed) {
    return { status: 'BLOCKED', reasons: ledger.intake.safety.problems.map((p) => `refused: ${p}`) };
  }
  if (!ledger.approval) {
    const reason = ledger.planFrozen ? 'the test plan is not approved' : 'the test plan is not frozen and approved';
    return { status: 'BLOCKED', reasons: [reason] };
  }
  if (ledger.approval.planHash !== planDigest(ledger)) {
    return { status: 'BLOCKED', reasons: ['the plan changed after it was approved; freeze and approve the new version'] };
  }

  const reasons = [];
  for (const [target, readiness] of Object.entries(ledger.intake.readiness)) {
    if (readiness.status === 'blocked') reasons.push(`${target} is blocked: ${readiness.reason}`);
  }
  const p0 = ledger.journeys.filter((journey) => journey.priority === 'P0');
  for (const journey of p0) {
    for (const tc of journeyTests(ledger, journey.id)) {
      const { state, reasons: why = [] } = testState(ledger, tc.id);
      if (state === 'blocked') reasons.push(`P0 journey ${journey.id}: ${tc.id} is blocked: ${why.join('; ')}`);
    }
  }
  if (reasons.length > 0) return { status: 'BLOCKED', reasons };

  if (ledger.journeys.length === 0) return { status: 'PARTIALLY TESTED', reasons: ['no journeys discovered yet'] };
  const unverified = [];
  for (const journey of p0) {
    const tests = journeyTests(ledger, journey.id);
    if (tests.length === 0) {
      unverified.push(`P0 journey ${journey.id} is not verified: no test case`);
      continue;
    }
    const notPassed = tests.filter((tc) => testState(ledger, tc.id).state !== 'passed');
    if (notPassed.length > 0) {
      const detail = notPassed.map((tc) => `${tc.id} ${testState(ledger, tc.id).state}`).join(', ');
      unverified.push(`P0 journey ${journey.id} is not verified: ${detail}`);
    }
  }
  // G19: a planned test case that has not passed keeps the gate at PARTIALLY TESTED, even when every P0
  // journey is verified. PASS needs every test case in the plan to have a current pass.
  const p0Tests = new Set(p0.flatMap((journey) => journeyTests(ledger, journey.id).map((tc) => tc.id)));
  const others = ledger.testCases
    .filter((tc) => !p0Tests.has(tc.id) && testState(ledger, tc.id).state !== 'passed')
    .map((tc) => `${tc.id} ${testState(ledger, tc.id).state}`);
  if (unverified.length > 0 || others.length > 0) return { status: 'PARTIALLY TESTED', reasons: [...unverified, ...others] };
  return { status: 'PASS', reasons: [] };
}

// Appends one run for a test case. The run is bound to the current build, so a later change makes it
// stale. The result is one of the run states; a failure that needs confirmation is not a failure.
export function recordRun(ledger, { testCase, result, reasons = [], failures = [], evidence = [], now }) {
  if (!ledger.intake || !ledger.intake.safety.allowed) throw new Error('a run cannot be recorded for a refused run');
  const tc = ledger.testCases.find((t) => t.id === testCase);
  if (!tc) throw new Error(`test case ${testCase} is not in the plan`);
  const run = {
    id: `R-${String(ledger.runs.length + 1).padStart(4, '0')}`,
    testCase,
    journeys: tc.journeys || [],
    layer: tc.layer,
    result,
    reasons,
    failures,
    evidence,
    build: ledger.intake.build.treeHash,
    at: now,
  };
  ledger.runs.push(run);
  return run;
}

// Opens one defect for a failing test case. A test case with an open defect adds no second one.
export function recordDefect(ledger, { testCase, failures, now }) {
  const open = ledger.defects.find((d) => (d.testCases || []).includes(testCase) && d.status !== 'Closed');
  if (open) return open;
  const tc = ledger.testCases.find((t) => t.id === testCase);
  if (!tc) throw new Error(`test case ${testCase} is not in the plan`);
  const defect = {
    id: `DEF-${String(ledger.defects.length + 1).padStart(3, '0')}`,
    title: tc.title || testCase,
    severity: 'unassigned',
    status: 'Confirmed',
    testCases: [testCase],
    requirements: tc.requirements || [],
    evidence: failures,
    detectedAt: now,
    build: ledger.intake.build.treeHash,
  };
  ledger.defects.push(defect);
  return defect;
}

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

async function main(argv) {
  const [command, ledgerPath, ...rest] = argv;
  if (!command || !ledgerPath) {
    throw new Error('usage: ledger.mjs <status|finish|load|add|design|freeze|approve|binary> <ledger.json> [...]');
  }
  const { flags, positional } = parseFlags(rest);
  const now = new Date().toISOString();
  if (command === 'status') {
    console.log(JSON.stringify(status(readLedger(ledgerPath)), null, 2));
    return;
  }
  if (command === 'finish') {
    // Removes the active-run marker. The guard stops restricting writes once it is gone.
    rmSync(join(dirname(ledgerPath), 'active'), { force: true });
    console.log(JSON.stringify({ finished: true, status: status(readLedger(ledgerPath)).status }, null, 2));
    return;
  }

  const ledger = readLedger(ledgerPath);
  let output;
  if (command === 'load') {
    const [file] = positional;
    output = loadPlan(ledger, JSON.parse(readFileSync(resolve(file), 'utf8')));
  } else if (command === 'add') {
    const [kind, file] = positional;
    output = addItem(ledger, kind, JSON.parse(readFileSync(resolve(file), 'utf8')));
  } else if (command === 'design') {
    const [file] = positional;
    if (!ledger.intake || !ledger.intake.safety.allowed) throw new Error('a design map cannot be recorded for a refused run');
    ledger.designMap = JSON.parse(readFileSync(resolve(file), 'utf8'));
    output = { designMap: ledger.designMap.source };
  } else if (command === 'freeze') {
    output = freezePlan(ledger, { now });
  } else if (command === 'approve') {
    output = approvePlan(ledger, { approver: flags.approver, approvedAt: flags.date || now.slice(0, 10) });
  } else if (command === 'binary') {
    const [target, file] = positional;
    output = await recordBinary(ledger, { target, file, versionName: flags.version, buildNumber: flags.build, now });
  } else {
    throw new Error(`unknown command: ${command}`);
  }
  writeLedger(ledgerPath, ledger);
  console.log(JSON.stringify(output, null, 2));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
