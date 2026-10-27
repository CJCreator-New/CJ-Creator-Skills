#!/usr/bin/env node
// Enforces the quality gates of one frontend-engineer run. The orchestrator uses it to check a
// gate before advancing, to record check results, and to end the run.
//
// Recorded check results (run) come only from this script: it executes the command itself and
// stores its exit code and output tail, so a result cannot be typed in by hand. A result is
// current only while the working tree still matches the state it was recorded against.
//
// State lives in <project>/.claude/frontend-engineer/state.json. The orchestrator edits the
// matrix, handoffs, visual, review, approval and limitations fields directly. This script checks
// them. Commands:
//
//   gates.mjs init
//   gates.mjs package <id> <path...>      add or replace a work package and its owned paths
//   gates.mjs ownership                   write ownership.json from the packages
//   gates.mjs run <name> [--scope focused|full|baseline] [--cwd dir] -- <command>
//   gates.mjs iterate                     count one visual correction round, up to the limit
//   gates.mjs check <1-5>                 list every failure of a gate; exit 1 when it fails
//   gates.mjs finish                      end the run: check gates 4 and 5, then remove ownership.json
//   gates.mjs abort                       end the run without checks, removing ownership.json

import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { covers, overlaps, unionEntries } from './ownership.mjs';

export const DEFAULT_MAX_ITERATIONS = 3;
export const APPROVALS = ['pending', 'approved', 'changes requested'];
export const SCOPES = ['focused', 'full', 'baseline'];
const VISUAL_STATUSES = ['passing', 'incomplete', 'not performed'];
const IMPLEMENTED = ['implemented', 'tested', 'verified'];
const TAIL_LINES = 40;
const MAX_BUFFER = 64 * 1024 * 1024;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const USAGE =
  'usage: gates.mjs init | package <id> <path...> | ownership | run <name> [--scope s] [--cwd dir] -- <command> | ' +
  'iterate | check <1-5> | finish | abort';

export function stateDir(projectDir) {
  return join(projectDir, '.claude', 'frontend-engineer');
}

export function statePath(projectDir) {
  return join(stateDir(projectDir), 'state.json');
}

export function ownershipPath(projectDir) {
  return join(stateDir(projectDir), 'ownership.json');
}

export function emptyState() {
  return {
    matrix: [],
    packages: [],
    handoffs: [],
    runs: [],
    visual: { status: 'not performed', reason: 'not started', viewports: [], iterations: 0, remaining: [] },
    review: { verdict: 'not run' },
    allowedFailures: [],
    approval: 'pending',
    limitations: [],
  };
}

export function loadState(projectDir) {
  if (!existsSync(statePath(projectDir))) return emptyState();
  return JSON.parse(readFileSync(statePath(projectDir), 'utf8'));
}

export function saveState(projectDir, state) {
  mkdirSync(stateDir(projectDir), { recursive: true });
  writeFileSync(statePath(projectDir), `${JSON.stringify(state, null, 2)}\n`);
}

// Hash of the changes a check ran against: tracked diff against HEAD plus untracked file contents.
// The .claude folder is excluded, so recording results does not make them stale. Null when there
// is no git state to hash, which makes every recorded result non-current.
export function diffHash(cwd) {
  const pathspec = ['--', '.', ':(exclude).claude'];
  try {
    const diff = execFileSync('git', ['diff', 'HEAD', '--binary', ...pathspec], { cwd, maxBuffer: MAX_BUFFER });
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard', '-z', ...pathspec], {
      cwd,
      maxBuffer: MAX_BUFFER,
    })
      .toString('utf8')
      .split('\0')
      .filter(Boolean)
      .sort();
    const hash = createHash('sha256').update(diff);
    for (const file of untracked) {
      hash.update(`\0${file}\0`);
      hash.update(readFileSync(join(cwd, file)));
    }
    return hash.digest('hex');
  } catch {
    return null;
  }
}

export function parseRun(args) {
  const split = args.indexOf('--');
  if (split < 1 || split === args.length - 1) throw new Error(`run needs a name and a command after "--"\n${USAGE}`);
  const [name, ...flags] = args.slice(0, split);
  const command = args.slice(split + 1).join(' ');
  let scope = 'focused';
  let cwd;
  for (let i = 0; i < flags.length; i += 2) {
    const [flag, value] = [flags[i], flags[i + 1]];
    if (flag === '--scope' && value) scope = value;
    else if (flag === '--cwd' && value) cwd = value;
    else throw new Error(`unknown run option: ${flag}`);
  }
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
  return { name, scope, cwd, command };
}

// Executes one check and records it. The state is updated in place; the caller saves it.
export function runCheck(state, { name, scope, command, cwd, hash = diffHash, now = () => new Date() }) {
  const hashBefore = hash(cwd);
  const startedAt = now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: RUN_TIMEOUT_MS,
  });
  const hashAfter = hash(cwd);
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').slice(-TAIL_LINES).join('\n');
  const entry = {
    name,
    scope,
    command,
    cwd,
    exitCode: result.error ? -1 : (result.status ?? -1),
    startedAt: startedAt.toISOString(),
    durationMs: now() - startedAt,
    hashBefore,
    hashAfter,
    tail: output,
  };
  state.runs.push(entry);
  return entry;
}

export function latestRun(state, name, scope) {
  return [...state.runs].reverse().find((r) => r.name === name && (scope === undefined || r.scope === scope));
}

// A run is current when it passed and the changes it saw are still the changes in the tree.
export function isCurrent(run, hash) {
  return Boolean(run) && run.exitCode === 0 && hash !== null && (run.hashBefore === hash || run.hashAfter === hash);
}

export function upsertPackage(state, id, owned) {
  if (!id) throw new Error(`package needs an id\n${USAGE}`);
  if (owned.length === 0) throw new Error(`package ${id} needs at least one path`);
  const normalized = unionEntries([owned]);
  const existing = state.packages.find((p) => p.id === id);
  if (existing) existing.owned = normalized;
  else state.packages.push({ id, owned: normalized });
}

export function plannedOwnership(state) {
  return unionEntries(state.packages.map((p) => p.owned));
}

export function readOwnershipFile(projectDir) {
  try {
    const data = JSON.parse(readFileSync(ownershipPath(projectDir), 'utf8'));
    return Array.isArray(data?.owned) ? data.owned : null;
  } catch {
    return null;
  }
}

export function maxIterations(projectDir) {
  try {
    const value = JSON.parse(readFileSync(join(stateDir(projectDir), 'config.json'), 'utf8')).maxVisualIterations;
    if (Number.isInteger(value) && value >= 1) return value;
  } catch {
    // No config file, or it is not valid JSON: use the default.
  }
  return DEFAULT_MAX_ITERATIONS;
}

export function recordIteration(state, limit) {
  if (state.visual.iterations >= limit) {
    throw new Error(
      `visual iteration limit reached (${limit}). Report the remaining defects and ask the user for a decision.`,
    );
  }
  state.visual.iterations += 1;
  return state.visual.iterations;
}

// ---- Gate rules. Each adds one message per failure. Later gates include the earlier ones. ----

function gate1(state, ctx, fail) {
  if (state.matrix.length === 0) fail('traceability matrix is empty');
  if (state.packages.length === 0) fail('no work packages: add one with "package <id> <path...>"');
  for (const row of state.matrix) {
    if (!row.requirement) fail(`${row.id}: requirement text is missing`);
    if (!row.files?.length) fail(`${row.id}: no source files named`);
  }
  state.packages.forEach((a, i) => {
    for (const b of state.packages.slice(i + 1)) {
      for (const x of a.owned) {
        for (const y of b.owned) {
          if (overlaps(x, y)) fail(`${a.id} and ${b.id} both own ${x} and ${y}; give each file one owner`);
        }
      }
    }
  });
  const owned = plannedOwnership(state);
  for (const row of state.matrix) {
    for (const file of row.files ?? []) {
      if (!covers(owned, file, ctx.projectDir)) fail(`${row.id}: ${file} is not owned by any work package`);
    }
  }
  const written = readOwnershipFile(ctx.projectDir);
  if (JSON.stringify(written) !== JSON.stringify(owned)) {
    fail('ownership.json does not match the work packages; run "ownership"');
  }
}

function requireRun(state, ctx, name, fail) {
  const run = latestRun(state, name);
  if (!run) {
    fail(`no "${name}" run recorded; run it with: run ${name} -- "<command>"`);
  } else if (run.exitCode !== 0) {
    fail(`"${name}" failed (exit ${run.exitCode}) on its last run`);
  } else if (!isCurrent(run, ctx.hash)) {
    fail(`"${name}" passed, but the changes were modified after it ran; run it again`);
  }
}

function gate2(state, ctx, fail) {
  for (const h of state.handoffs) {
    if (!h.resolved) fail(`open handoff from ${h.from}: ${h.file}: ${h.change}`);
  }
  requireRun(state, ctx, 'lint', fail);
  requireRun(state, ctx, 'typecheck', fail);
}

function gate3(state, ctx, fail) {
  gate2(state, ctx, fail);
  for (const row of state.matrix) {
    if (!IMPLEMENTED.includes(row.status)) fail(`${row.id}: status is "${row.status}"; it must be implemented`);
  }
}

function fullTestRun(state, ctx, fail) {
  const full = latestRun(state, 'test', 'full');
  if (!full) {
    fail('no full test run recorded; run it with: run test --scope full -- "<command>"');
    return;
  }
  if (full.exitCode !== 0) {
    const baseline = latestRun(state, 'test', 'baseline');
    const preExisting =
      baseline !== undefined &&
      baseline.exitCode !== 0 &&
      baseline.command === full.command &&
      state.allowedFailures.length > 0 &&
      state.allowedFailures.every((f) => f.test && f.reason);
    if (!preExisting) {
      fail(
        `full test run failed (exit ${full.exitCode}). Failures may be excluded only when the base commit ` +
          'fails the same command (run test --scope baseline) and each one is listed in allowedFailures with a reason',
      );
    }
    return;
  }
  if (!isCurrent(full, ctx.hash)) fail('full test run passed, but the changes were modified after it ran; run it again');
}

function gate4(state, ctx, fail) {
  gate3(state, ctx, fail);
  for (const row of state.matrix) {
    if (['tested', 'verified'].includes(row.status) && !row.tests?.length) {
      fail(`${row.id}: marked ${row.status} with no test named`);
    }
    if (row.status === 'verified') {
      if (!row.evidence?.length) fail(`${row.id}: marked verified with no visual evidence`);
      for (const path of row.evidence ?? []) {
        if (!ctx.exists(path)) fail(`${row.id}: evidence file does not exist: ${path}`);
      }
    }
  }
  requireRun(state, ctx, 'build', fail);
  fullTestRun(state, ctx, fail);

  const visual = state.visual;
  const blocking = (visual.remaining ?? []).filter((d) => d.severity === 'critical' || d.severity === 'high');
  if (!VISUAL_STATUSES.includes(visual.status)) {
    fail(`visual status "${visual.status}" must be one of ${VISUAL_STATUSES.join(', ')}`);
  } else if (visual.status === 'passing') {
    if (!visual.viewports?.length) fail('visual status is passing with no viewports recorded');
    if (blocking.length) fail(`visual status is passing but ${blocking.length} critical or high defects are listed`);
  } else if (visual.status === 'not performed') {
    if (!visual.reason) fail('visual verification is not performed, and no reason is recorded');
  } else if (blocking.length) {
    fail(`${blocking.length} critical or high visual defects remain`);
  }

  if (state.review?.verdict !== 'passed') {
    fail(`independent review has not passed (verdict: ${state.review?.verdict ?? 'missing'})`);
  }
}

function gate5(state, ctx, fail) {
  gate4(state, ctx, fail);
  if (!APPROVALS.includes(state.approval)) fail(`approval must be one of ${APPROVALS.join(', ')}`);
  if (!Array.isArray(state.limitations)) fail('limitations must be a list, which may be empty');
  if (state.visual.status === 'incomplete' && !state.visual.remaining?.length) {
    fail('visual verification is incomplete, but no remaining defects are listed');
  }
}

const GATES = { 1: gate1, 2: gate2, 3: gate3, 4: gate4, 5: gate5 };

export function checkGate(gate, state, ctx) {
  const check = GATES[gate];
  if (!check) throw new Error(`gate must be 1 to 5, got ${gate}`);
  const failures = [];
  check(state, ctx, (message) => failures.push(message));
  return { gate, ok: failures.length === 0, failures };
}

export function contextFor(projectDir, hash = diffHash) {
  return {
    projectDir,
    hash: hash(projectDir),
    exists: (path) => existsSync(isAbsolute(path) ? path : join(projectDir, path)),
  };
}

export function writeOwnership(projectDir, state) {
  const owned = plannedOwnership(state);
  if (owned.length === 0) throw new Error('no work packages to write; add one with "package <id> <path...>"');
  mkdirSync(stateDir(projectDir), { recursive: true });
  writeFileSync(ownershipPath(projectDir), `${JSON.stringify({ owned }, null, 2)}\n`);
  return owned;
}

// Returns { code, out }. The CLI prints out and exits with code.
export function main(argv, env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
  const [command, ...args] = argv;
  const ok = (out) => ({ code: 0, out: `${out}\n` });

  switch (command) {
    case 'init': {
      if (!existsSync(statePath(projectDir))) saveState(projectDir, emptyState());
      return ok(`state: ${statePath(projectDir)}`);
    }
    case 'package': {
      const [id, ...owned] = args;
      const state = loadState(projectDir);
      upsertPackage(state, id, owned);
      saveState(projectDir, state);
      return ok(`package ${id}: ${unionEntries([owned]).length} path(s)`);
    }
    case 'ownership': {
      const owned = writeOwnership(projectDir, loadState(projectDir));
      return ok(`ownership.json: ${owned.length} path(s)`);
    }
    case 'run': {
      const { name, scope, cwd, command: shell } = parseRun(args);
      const state = loadState(projectDir);
      const entry = runCheck(state, { name, scope, command: shell, cwd: cwd ?? projectDir });
      saveState(projectDir, state);
      const status = entry.exitCode === 0 ? 'passed' : `failed (exit ${entry.exitCode})`;
      return { code: entry.exitCode === 0 ? 0 : 1, out: `${name} [${scope}] ${status}\n${entry.tail}\n` };
    }
    case 'iterate': {
      const state = loadState(projectDir);
      const count = recordIteration(state, maxIterations(projectDir));
      saveState(projectDir, state);
      return ok(`visual iteration ${count}`);
    }
    case 'check': {
      const gate = Number(args[0]);
      const result = checkGate(gate, loadState(projectDir), contextFor(projectDir));
      const out = result.ok ? `gate ${gate}: passed` : `gate ${gate}: failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}`;
      return { code: result.ok ? 0 : 1, out: `${out}\n` };
    }
    case 'finish': {
      const result = checkGate(5, loadState(projectDir), contextFor(projectDir));
      if (!result.ok) {
        return { code: 1, out: `run not finished: gate 5 failed\n${result.failures.map((f) => `  - ${f}`).join('\n')}\n` };
      }
      rmSync(ownershipPath(projectDir), { force: true });
      return ok('run finished; ownership.json removed');
    }
    case 'abort': {
      rmSync(ownershipPath(projectDir), { force: true });
      return ok('run aborted; ownership.json removed');
    }
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
