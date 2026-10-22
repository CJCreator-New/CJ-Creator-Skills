#!/usr/bin/env node
// Orchestration for one backend-engineer run. It owns three things the skill used to leave to
// memory: the order of the phases, the contract approval that gates implementation, and the
// execution plan that says which agents may run in parallel.
//
// A phase is completed only when its prerequisites hold in the ledger. The contract is approved
// only when the OpenAPI document passes the journey check, and the approval records the file's
// hash, so a later edit to the contract makes the approval void. The plan puts tasks into waves:
// a wave holds the tasks whose dependencies are all done. Tasks that share files are ordered by
// the ledger's validation, so no two tasks in a wave own the same file.
//
// Usage:
//   orchestrate.mjs status
//   orchestrate.mjs advance <phase>
//   orchestrate.mjs approve contract <openapi.json>
//   orchestrate.mjs plan

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { checkContract } from './contract.mjs';
import {
  PHASES,
  commit,
  loadLedger,
  makeContext,
  releaseStatus,
  runIsCurrent,
  withLock,
} from './ledger.mjs';
import { route } from './route.mjs';

export const KIND_FOR_OWNER = {
  'api-architect': 'contract',
  'db-integrity': 'migration',
  'backend-implementer': 'implementation',
  'integration-engineer': 'integration',
  'frontend-integrator': 'frontend',
  'test-engineer': 'tests',
};
const USAGE = 'usage: orchestrate.mjs status | advance <phase> | approve contract <openapi.json> | plan';

const hasPhase = (ledger, name) => ledger.phases.some((p) => p.name === name);

export function approvalFor(ledger, name) {
  return ledger.approvals.find((a) => a.name === name);
}

// True when the approved file still has the hash it had at approval.
export function approvalCurrent(ledger, name, readFile = readFileSync) {
  const approval = approvalFor(ledger, name);
  if (!approval) return false;
  try {
    return createHash('sha256').update(readFile(approval.file)).digest('hex') === approval.sha256;
  } catch {
    return false;
  }
}

// The reasons a phase cannot be completed yet. An empty list means it can.
export function prerequisites(ledger, phase, ctx, readFile) {
  const reasons = [];
  const need = (name) => {
    if (!hasPhase(ledger, name)) reasons.push(`the ${name} phase is not complete`);
  };
  switch (phase) {
    case 'discover':
      break;
    case 'understand':
      need('discover');
      break;
    case 'plan':
      need('understand');
      if (ledger.requirements.length === 0) reasons.push('record requirements first');
      if (ledger.journeys.length === 0) reasons.push('record user journeys first');
      break;
    case 'contract':
      need('plan');
      if (!approvalFor(ledger, 'contract')) {
        reasons.push('approve the contract first: orchestrate.mjs approve contract <openapi.json>');
      } else if (!approvalCurrent(ledger, 'contract', readFile)) {
        reasons.push('the contract changed after it was approved; approve it again');
      }
      break;
    case 'implement':
      need('contract');
      if (ledger.tasks.length === 0) reasons.push('plan at least one task');
      break;
    case 'verify': {
      need('implement');
      const open = ledger.tasks.filter((t) => t.status !== 'done').map((t) => t.id);
      if (open.length) reasons.push(`tasks are not done: ${open.join(', ')}`);
      break;
    }
    case 'e2e':
      need('verify');
      break;
    case 'review': {
      need('e2e');
      const full = [...ledger.evidence].reverse().find((e) => e.kind === 'run' && e.name === 'test' && e.scope === 'full');
      if (!full || full.exitCode !== 0 || !runIsCurrent(full, ledger, ctx)) {
        reasons.push('no current passing full suite run (run test --scope full)');
      }
      break;
    }
    case 'deliver': {
      need('review');
      const status = releaseStatus(ledger, ctx).status;
      if (status !== 'Complete') reasons.push(`the release status is ${status}, not Complete`);
      break;
    }
    default:
      reasons.push(`${phase} is not a phase; the phases are ${PHASES.join(', ')}`);
  }
  return reasons;
}

export function nextPhase(ledger) {
  return PHASES[ledger.phases.length] ?? null;
}

// Completes the next phase, if its prerequisites hold. The ledger is locked for the whole check so
// that two advances cannot both succeed.
export function advance(projectDir, phase, { now = () => new Date(), readFile = readFileSync } = {}) {
  return withLock(projectDir, () => {
    const ledger = loadLedger(projectDir);
    const expected = nextPhase(ledger);
    if (phase !== expected) {
      return { ok: false, reasons: [`the next phase is ${expected ?? 'none; the run is complete'}, not ${phase}`] };
    }
    const reasons = prerequisites(ledger, phase, makeContext(projectDir), readFile);
    if (reasons.length) return { ok: false, reasons };
    ledger.phases.push({ name: phase, completedAt: now().toISOString() });
    commit(projectDir, ledger);
    return { ok: true, reasons: [] };
  });
}

// Records the approval of the contract. The OpenAPI document must pass the journey check first.
export function approve(projectDir, name, file, { now = () => new Date(), readFile = readFileSync } = {}) {
  if (name !== 'contract') throw new Error('only the contract can be approved');
  return withLock(projectDir, () => {
    const ledger = loadLedger(projectDir);
    const bytes = readFile(file);
    const problems = checkContract(ledger, JSON.parse(bytes.toString('utf8')));
    if (problems.length) return { ok: false, reasons: problems };
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    ledger.approvals = ledger.approvals.filter((a) => a.name !== name);
    // The absolute path, so that the currency check reads the same file from any directory.
    ledger.approvals.push({ name, file: resolve(file), sha256, approvedAt: now().toISOString() });
    commit(projectDir, ledger);
    return { ok: true, reasons: [] };
  });
}

export function dispatchFor(task, pick = route) {
  const kind = task.kind ?? KIND_FOR_OWNER[task.owner] ?? 'implementation';
  const decision = pick({ kind, risk: task.risk ?? 'low', ambiguous: task.ambiguous ?? false, retries: 0 });
  return { id: task.id, owner: task.owner, files: task.files, kind, model: decision.model, reasons: decision.reasons };
}

// Waves of tasks that may run in parallel. A task is ready when every task it depends on is done.
// Blocked tasks are listed, not scheduled. Tasks that never become ready are listed as waiting, which
// happens when a dependency is blocked or a dependency points at a task that does not exist.
export function planWaves(ledger, pick = route) {
  const placed = new Set(ledger.tasks.filter((t) => t.status === 'done').map((t) => t.id));
  const blocked = ledger.tasks.filter((t) => t.status === 'blocked').map((t) => t.id);
  let remaining = ledger.tasks.filter((t) => t.status !== 'done' && t.status !== 'blocked');
  const waves = [];
  while (remaining.length) {
    const ready = remaining.filter((t) => (t.dependsOn ?? []).every((d) => placed.has(d)));
    if (ready.length === 0) break;
    waves.push({ wave: waves.length + 1, tasks: ready.map((t) => dispatchFor(t, pick)) });
    for (const t of ready) placed.add(t.id);
    remaining = remaining.filter((t) => !placed.has(t.id));
  }
  return { waves, blocked, waiting: remaining.map((t) => t.id) };
}

export function statusOf(ledger, ctx) {
  const next = nextPhase(ledger);
  return {
    completed: ledger.phases.map((p) => p.name),
    next,
    nextBlockers: next ? prerequisites(ledger, next, ctx, readFileSync) : [],
    release: releaseStatus(ledger, ctx).status,
  };
}

// Returns { code, out }. The CLI prints out and exits with code.
export function main(argv, env = process.env, clock) {
  const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
  const [command, ...args] = argv;
  const options = clock ? { now: clock } : {};
  const json = (value) => ({ code: 0, out: `${JSON.stringify(value, null, 2)}\n` });
  const verdict = (result, success) =>
    result.ok
      ? { code: 0, out: `${success}\n` }
      : { code: 1, out: `refused:\n${result.reasons.map((r) => `  - ${r}`).join('\n')}\n` };

  switch (command) {
    case 'status':
      return json(statusOf(loadLedger(projectDir), makeContext(projectDir)));
    case 'advance': {
      if (!args[0]) throw new Error(USAGE);
      return verdict(advance(projectDir, args[0], options), `phase ${args[0]} complete`);
    }
    case 'approve': {
      const [name, file] = args;
      if (!name || !file) throw new Error(USAGE);
      return verdict(approve(projectDir, name, file, options), `${name} approved`);
    }
    case 'plan':
      return json(planWaves(loadLedger(projectDir)));
    default:
      throw new Error(USAGE);
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const { code, out } = main(process.argv.slice(2));
    process.stdout.write(out);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
