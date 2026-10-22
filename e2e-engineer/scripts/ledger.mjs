#!/usr/bin/env node
// The ledger for one e2e-engineer run. It is the only writer of the run's state. It computes the
// hashes it records (the native binary and the frozen plan) itself, so a caller cannot supply them.
// Run state lives in <repo>/.claude/e2e-engineer/ledger.json, which the target repo ignores.

import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
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

// Gate status with the precedence in the plan (G19): a failed mandatory gate gives FAIL; an unmet or
// blocked mandatory gate gives BLOCKED; work that has not run gives PARTIALLY TESTED; otherwise PASS.
// An approval counts only for the plan it was given for. A later change to the plan makes it stale.
export function status(ledger) {
  const reasons = [];
  const failed = ledger.runs.filter((run) => run.result === 'failed');
  if (failed.length > 0) return { status: 'FAIL', reasons: failed.map((run) => `failed run ${run.id}`) };

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

  for (const [target, readiness] of Object.entries(ledger.intake.readiness)) {
    if (readiness.status === 'blocked') reasons.push(`${target} is blocked: ${readiness.reason}`);
  }
  if (reasons.length > 0) return { status: 'BLOCKED', reasons };

  if (ledger.journeys.length === 0) return { status: 'PARTIALLY TESTED', reasons: ['no journeys discovered yet'] };
  const p0 = ledger.journeys.filter((journey) => journey.priority === 'P0');
  const verified = new Set(ledger.runs.filter((run) => run.result === 'passed').map((run) => run.journey));
  const unverified = p0.filter((journey) => !verified.has(journey.id));
  if (unverified.length > 0) {
    return { status: 'PARTIALLY TESTED', reasons: unverified.map((j) => `P0 journey ${j.id} is not verified`) };
  }
  return { status: 'PASS', reasons: [] };
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
    throw new Error('usage: ledger.mjs <status|load|add|design|freeze|approve|binary> <ledger.json> [...]');
  }
  const { flags, positional } = parseFlags(rest);
  const now = new Date().toISOString();
  if (command === 'status') {
    console.log(JSON.stringify(status(readLedger(ledgerPath)), null, 2));
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
