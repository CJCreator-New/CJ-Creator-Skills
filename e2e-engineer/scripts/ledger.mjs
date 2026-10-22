#!/usr/bin/env node
// The ledger for one e2e-engineer run. It is the only writer of the run's state. It computes the
// hashes it records (the native binary and the approved plan) itself, so a caller cannot supply
// them. Run state lives in <repo>/.claude/e2e-engineer/ledger.json, which the target repo ignores.

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describeBinary } from './binary.mjs';

export const SCHEMA = 1;
export const STATUSES = ['PASS', 'PASS WITH ACCEPTED RISKS', 'FAIL', 'BLOCKED', 'PARTIALLY TESTED'];

export function defaultLedgerPath(root) {
  return join(root, '.claude', 'e2e-engineer', 'ledger.json');
}

export function emptyLedger() {
  return { schema: SCHEMA, intake: null, approval: null, binaries: [], journeys: [], runs: [] };
}

export function readLedger(path) {
  if (!existsSync(path)) return emptyLedger();
  const ledger = JSON.parse(readFileSync(path, 'utf8'));
  if (ledger.schema !== SCHEMA) throw new Error(`ledger schema ${ledger.schema} is not supported (expected ${SCHEMA})`);
  return ledger;
}

// Writes through a temporary file, so an interrupted write cannot leave a half-written ledger.
export function writeLedger(path, ledger) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(tmp, path);
}

export function planHash(planPath) {
  return createHash('sha256').update(readFileSync(planPath)).digest('hex');
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

// Records the approval of the test plan, against the plan's hash computed here.
export function recordApproval(ledger, { planPath, approver, approvedAt }) {
  if (!ledger.intake || !ledger.intake.safety.allowed) throw new Error('a plan cannot be approved for a refused run');
  if (typeof approver !== 'string' || approver.trim() === '') throw new Error('an approver name or identifier is required');
  ledger.approval = { planPath, sha256: planHash(planPath), approver, approvedAt };
  return ledger.approval;
}

// Gate status with the precedence in the plan (G19): a failed mandatory gate gives FAIL; an unmet or
// blocked mandatory gate gives BLOCKED; work that has not run gives PARTIALLY TESTED; otherwise PASS.
export function status(ledger) {
  const reasons = [];
  const failed = ledger.runs.filter((run) => run.result === 'failed');
  if (failed.length > 0) return { status: 'FAIL', reasons: failed.map((run) => `failed run ${run.id}`) };

  if (!ledger.intake) return { status: 'BLOCKED', reasons: ['intake has not run'] };
  if (!ledger.intake.safety.allowed) {
    return { status: 'BLOCKED', reasons: ledger.intake.safety.problems.map((p) => `refused: ${p}`) };
  }
  if (!ledger.approval) return { status: 'BLOCKED', reasons: ['the test plan is not approved'] };

  for (const [target, readiness] of Object.entries(ledger.intake.readiness)) {
    if (readiness.status === 'blocked') reasons.push(`${target} is blocked: ${readiness.reason}`);
  }
  if (reasons.length > 0) return { status: 'BLOCKED', reasons };

  const p0 = ledger.journeys.filter((journey) => journey.priority === 'P0');
  const verified = new Set(ledger.runs.filter((run) => run.result === 'passed').map((run) => run.journey));
  const unverified = p0.filter((journey) => !verified.has(journey.id));
  if (ledger.journeys.length === 0) return { status: 'PARTIALLY TESTED', reasons: ['no journeys discovered yet'] };
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
  const { flags, positional } = parseFlags(rest);
  const now = new Date().toISOString();
  if (!command || !ledgerPath) {
    throw new Error('usage: ledger.mjs <status|approve|binary> <ledger.json> [...]');
  }
  if (command === 'status') {
    console.log(JSON.stringify(status(readLedger(ledgerPath)), null, 2));
    return;
  }
  const ledger = readLedger(ledgerPath);
  if (command === 'approve') {
    const [planPath] = positional;
    const approval = recordApproval(ledger, { planPath, approver: flags.approver, approvedAt: flags.date || now.slice(0, 10) });
    writeLedger(ledgerPath, ledger);
    console.log(JSON.stringify(approval, null, 2));
    return;
  }
  if (command === 'binary') {
    const [target, file] = positional;
    const entry = await recordBinary(ledger, { target, file, versionName: flags.version, buildNumber: flags.build, now });
    writeLedger(ledgerPath, ledger);
    console.log(JSON.stringify(entry, null, 2));
    return;
  }
  throw new Error(`unknown command: ${command}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
