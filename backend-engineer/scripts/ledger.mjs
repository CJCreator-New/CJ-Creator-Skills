#!/usr/bin/env node
// Ledger for one backend-engineer run. It holds requirements, user journeys, UI interactions,
// gaps, decisions, tasks and verification evidence in <project>/.claude/backend-engineer/ledger.json.
//
// The ledger checks what can be checked: references between records, required fields, the gap
// lifecycle, and that a result counts only while the files it depends on are unchanged. Check
// results and reviews are recorded here, by running the command or reading the verdict, so they
// cannot be typed in. Journey states and the release status are computed from that evidence.
//
// What it cannot check is whether a requirement, a journey or a review is right. Those are
// judgments for the agents and the reviewer, and the final report must say so.
//
// Usage:
//   ledger.mjs init
//   ledger.mjs add <requirements|journeys|interactions|gaps|decisions|tasks> '<json>'
//   ledger.mjs set <section> <id> '<json>'
//   ledger.mjs gap <id> <next-status>
//   ledger.mjs run <name> [--scope focused|regression|e2e|full] [--journey J-01,J-02] [--gap G-01] [--cwd dir] -- <command>
//   ledger.mjs review <passed|findings-open|rejected> [--report path] [--notes text]
//   ledger.mjs validate
//   ledger.mjs status
//   ledger.mjs release
//   ledger.mjs ownership
//   ledger.mjs finish
//   ledger.mjs abort

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { pathsHash, treeHash } from './fingerprint.mjs';
import { unionEntries } from './ownership.mjs';

export const PREFIX = {
  requirements: 'R',
  journeys: 'J',
  interactions: 'I',
  gaps: 'G',
  decisions: 'D',
  tasks: 'T',
  evidence: 'E',
};
export const SOURCES = ['confirmed', 'inferred', 'proposed', 'unresolved', 'defect', 'assumption', 'out-of-scope'];
export const PRIORITIES = ['high', 'medium', 'low'];
export const REQUIREMENT_STATUSES = ['open', 'implemented', 'not-implemented', 'out-of-scope'];
export const CLASSIFICATIONS = ['local', 'backend'];
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
export const CATEGORIES = [
  'Requirements',
  'User Flow',
  'Frontend',
  'API Contract',
  'Business Logic',
  'Authorization',
  'Database Integrity',
  'Integration',
  'Testing',
  'Observability',
  'Performance',
  'Documentation',
];
export const GAP_LIFECYCLE = [
  'Detected',
  'Triaged',
  'Assigned',
  'Root Cause Confirmed',
  'Fix Implemented',
  'Focused Tests Passed',
  'Regression Verified',
  'Closed',
];
export const DECISION_STATUSES = ['open', 'answered'];
export const TASK_STATUSES = ['planned', 'in-progress', 'done', 'blocked'];
export const JOURNEY_STATUSES = ['planned', 'implemented'];
export const SCOPES = ['focused', 'regression', 'e2e', 'full'];
export const REVIEW_VERDICTS = ['passed', 'findings-open', 'rejected'];
export const MODES = ['fast', 'standard', 'high-assurance'];
export const REVIEWERS = ['release-reviewer', 'security-reviewer'];
export const DETECTED_IN = [
  'requirements',
  'journeys',
  'contract',
  'schema',
  'implementation',
  'integration',
  'frontend',
  'e2e',
  'review',
  'release',
];
// Gaps detected at these points were missed until integration or later.
export const AFTER_INTEGRATION = ['integration', 'frontend', 'e2e', 'review', 'release'];

const DEFAULTS = {
  requirements: { status: 'open' },
  journeys: { status: 'planned', requirementIds: [], failureBranches: [], dependsOn: [] },
  interactions: {},
  gaps: { status: 'Detected', journeyIds: [], requirementIds: [] },
  decisions: { status: 'open', blocks: [] },
  tasks: { status: 'planned', dependsOn: [] },
};
const TAIL_LINES = 40;
const MAX_BUFFER = 64 * 1024 * 1024;
const RUN_TIMEOUT_MS = 30 * 60 * 1000;
const USAGE =
  'usage: ledger.mjs init | add <section> <json> | set <section> <id> <json> | gap <id> <status> | ' +
  'run <name> [--scope s] [--journey ids] [--gap ids] [--cwd dir] -- <command> | ' +
  'review <verdict> [--report path] [--notes text] | validate | status | release | ownership | finish | abort';

export const stateDir = (projectDir) => join(projectDir, '.claude', 'backend-engineer');
export const ledgerPath = (projectDir) => join(stateDir(projectDir), 'ledger.json');
export const ownershipPath = (projectDir) => join(stateDir(projectDir), 'ownership.json');

export function emptyLedger() {
  return {
    counters: {},
    project: {},
    requirements: [],
    journeys: [],
    interactions: [],
    gaps: [],
    decisions: [],
    tasks: [],
    evidence: [],
  };
}

export function loadLedger(projectDir) {
  if (!existsSync(ledgerPath(projectDir))) return emptyLedger();
  const ledger = JSON.parse(readFileSync(ledgerPath(projectDir), 'utf8'));
  ledger.project ??= {};
  return ledger;
}

export function saveLedger(projectDir, ledger) {
  mkdirSync(stateDir(projectDir), { recursive: true });
  writeFileSync(ledgerPath(projectDir), `${JSON.stringify(ledger, null, 2)}\n`);
}

// Fingerprints are memoised per command, so each file is read once. Recording a result never
// uses the memo, because a result needs the fingerprint from before and after the command.
export function makeContext(projectDir) {
  const memo = new Map();
  const once = (key, compute) => {
    if (!memo.has(key)) memo.set(key, compute());
    return memo.get(key);
  };
  const ctx = {
    projectDir,
    treeHash: () => once('tree', () => treeHash(projectDir)),
    pathsHash: (paths) => once(`paths:${JSON.stringify(paths)}`, () => pathsHash(projectDir, paths)),
  };
  ctx.journeyHash = (journey) => ctx.pathsHash(journey.dependsOn ?? []);
  return ctx;
}

const matches = (stored, now) => now !== null && now !== undefined && (stored?.before === now || stored?.after === now);

export function findItem(ledger, section, id) {
  return (ledger[section] ?? []).find((item) => item.id === id);
}

function findRequired(ledger, section, id) {
  const item = findItem(ledger, section, id);
  if (!item) throw new Error(`no ${section} record with id ${id}`);
  return item;
}

function nextId(ledger, section) {
  const prefix = PREFIX[section];
  ledger.counters[prefix] = (ledger.counters[prefix] ?? 0) + 1;
  return `${prefix}-${String(ledger.counters[prefix]).padStart(2, '0')}`;
}

export function addItem(ledger, section, data) {
  if (section === 'evidence') throw new Error('evidence is recorded by run or review, not added');
  if (!DEFAULTS[section]) throw new Error(`unknown section ${section}\n${USAGE}`);
  if (data === null || typeof data !== 'object' || Array.isArray(data)) throw new Error('add needs a JSON object');
  if ('id' in data) throw new Error('ids are assigned by the ledger');
  if (section === 'gaps' && 'status' in data) throw new Error('a gap starts at Detected; change its status with the gap command');
  const item = { id: nextId(ledger, section), ...DEFAULTS[section], ...data };
  ledger[section].push(item);
  return item;
}

export function setItem(ledger, section, id, patch) {
  if (section === 'evidence') throw new Error('evidence is recorded by run or review, not set');
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('set needs a JSON object');
  if (section === 'project') {
    Object.assign(ledger.project, patch);
    return;
  }
  if ('id' in patch && patch.id !== id) throw new Error('an id cannot be changed');
  if (section === 'gaps' && 'status' in patch) throw new Error('gap status changes only through the gap command');
  Object.assign(findRequired(ledger, section, id), patch);
}

// A run linked to journeys is current while each journey's files have the fingerprint the run
// saw, before or after the command. A run with no journeys is current while the whole tree is.
export function runIsCurrent(run, ledger, ctx) {
  if (run.journeyIds.length === 0) {
    return matches({ before: run.treeBefore, after: run.treeAfter }, ctx.treeHash());
  }
  return run.journeyIds.every((id) => {
    const journey = findItem(ledger, 'journeys', id);
    return journey !== undefined && matches(run.journeyHashes[id], ctx.journeyHash(journey));
  });
}

export function reviewIsCurrent(review, ctx) {
  return review.treeHash !== null && review.treeHash !== undefined && review.treeHash === ctx.treeHash();
}

// planned | implemented | blocked | verified | failed | stale
// Blocked: an open decision blocks the journey. Verified and failed come from the latest current
// run linked to it. Stale: runs exist, but the files have changed since they ran.
export function journeyState(ledger, journey, ctx) {
  if (ledger.decisions.some((d) => d.status === 'open' && (d.blocks ?? []).includes(journey.id))) return 'blocked';
  const runs = ledger.evidence.filter((e) => e.kind === 'run' && e.journeyIds.includes(journey.id));
  if (runs.length === 0) return journey.status === 'implemented' ? 'implemented' : 'planned';
  const current = runs.filter((run) => runIsCurrent(run, ledger, ctx));
  if (current.length === 0) return 'stale';
  return current[current.length - 1].exitCode === 0 ? 'verified' : 'failed';
}

export function gapTransition(ledger, gap, target, ctx) {
  const reasons = [];
  if (!GAP_LIFECYCLE.includes(target)) return { ok: false, reasons: [`${target} is not a gap status`] };
  const next = GAP_LIFECYCLE[GAP_LIFECYCLE.indexOf(gap.status) + 1];
  if (target !== next) reasons.push(`the next step is ${next ?? 'none; the gap is closed'}, not ${target}`);

  const passingRuns = ledger.evidence.filter(
    (e) => e.kind === 'run' && e.gapIds.includes(gap.id) && e.exitCode === 0 && runIsCurrent(e, ledger, ctx),
  );
  if (target === 'Assigned' && !gap.owner) reasons.push('set an owner first');
  if (target === 'Root Cause Confirmed' && !gap.rootCause) reasons.push('record rootCause first');
  if (target === 'Fix Implemented' && !gap.fix) reasons.push('record fix first');
  if (target === 'Focused Tests Passed' && passingRuns.length === 0) {
    reasons.push('no current passing run is linked to this gap');
  }
  if (target === 'Regression Verified') {
    if (!gap.regressionTests?.length) reasons.push('record regressionTests first');
    if (!passingRuns.some((e) => e.scope === 'regression')) {
      reasons.push('no current passing regression-scope run is linked to this gap');
    }
  }
  if (target === 'Closed' && !gap.acceptance?.length) reasons.push('record acceptance criteria first');
  return { ok: reasons.length === 0, reasons };
}

export function validateLedger(ledger) {
  const errors = [];
  const fail = (message) => errors.push(message);
  const idSets = {};

  for (const section of Object.keys(PREFIX)) {
    const items = ledger[section];
    if (!Array.isArray(items)) {
      fail(`${section} must be a list`);
      idSets[section] = new Set();
      continue;
    }
    const seen = new Set();
    for (const item of items) {
      if (typeof item.id !== 'string' || !item.id.startsWith(`${PREFIX[section]}-`)) {
        fail(`${section}: id ${item.id} must start with ${PREFIX[section]}-`);
      } else if (seen.has(item.id)) {
        fail(`${section}: duplicate id ${item.id}`);
      }
      seen.add(item.id);
    }
    idSets[section] = seen;
  }
  const known = (section, id) => idSets[section]?.has(id);
  const refs = (owner, field, values, section) => {
    for (const value of values ?? []) {
      if (!known(section, value)) fail(`${owner}: ${field} references missing ${value}`);
    }
  };
  const isStringList = (value) => Array.isArray(value) && value.every((v) => typeof v === 'string' && v !== '');

  for (const r of ledger.requirements ?? []) {
    if (!SOURCES.includes(r.source)) fail(`${r.id}: source must be one of ${SOURCES.join(', ')}`);
    if (!PRIORITIES.includes(r.priority)) fail(`${r.id}: priority must be high, medium or low`);
    if (!REQUIREMENT_STATUSES.includes(r.status)) fail(`${r.id}: status must be one of ${REQUIREMENT_STATUSES.join(', ')}`);
    if (typeof r.text !== 'string' || r.text === '') fail(`${r.id}: text is required`);
    if (['not-implemented', 'out-of-scope'].includes(r.status) && !r.reason) fail(`${r.id}: a ${r.status} requirement needs a reason`);
    if (r.source === 'unresolved' && r.status === 'implemented') {
      fail(`${r.id}: an unresolved business rule cannot be implemented until it is decided`);
    }
  }

  for (const j of ledger.journeys ?? []) {
    if (!PRIORITIES.includes(j.priority)) fail(`${j.id}: priority must be high, medium or low`);
    if (!JOURNEY_STATUSES.includes(j.status)) fail(`${j.id}: status must be planned or implemented`);
    for (const field of ['role', 'start', 'outcomeSuccess']) {
      if (typeof j[field] !== 'string' || j[field] === '') fail(`${j.id}: ${field} is required`);
    }
    if (!isStringList(j.requirementIds) || j.requirementIds.length === 0) fail(`${j.id}: requirementIds must name at least one requirement`);
    refs(j.id, 'requirementIds', j.requirementIds, 'requirements');
    if (!Array.isArray(j.steps) || j.steps.length === 0) fail(`${j.id}: steps must list at least one step`);
    for (const step of j.steps ?? []) {
      if (typeof step?.ui !== 'string' || step.ui === '') fail(`${j.id}: every step needs a ui description`);
    }
    if (!isStringList(j.dependsOn) || j.dependsOn.length === 0) fail(`${j.id}: dependsOn must list the paths the journey depends on`);
    if (!Array.isArray(j.failureBranches)) fail(`${j.id}: failureBranches must be a list`);
  }

  for (const i of ledger.interactions ?? []) {
    for (const field of ['route', 'element']) {
      if (typeof i[field] !== 'string' || i[field] === '') fail(`${i.id}: ${field} is required`);
    }
    if (!CLASSIFICATIONS.includes(i.classification)) fail(`${i.id}: classification must be local or backend`);
    if (i.classification === 'backend') {
      if (!i.journeyId) fail(`${i.id}: a backend interaction must name its journeyId`);
      else refs(i.id, 'journeyId', [i.journeyId], 'journeys');
    }
    if (i.classification === 'local' && !i.reason) fail(`${i.id}: a local interaction needs a reason`);
  }

  for (const g of ledger.gaps ?? []) {
    if (typeof g.title !== 'string' || g.title === '') fail(`${g.id}: title is required`);
    if (!SEVERITIES.includes(g.severity)) fail(`${g.id}: severity must be Critical, High, Medium or Low`);
    if (!CATEGORIES.includes(g.category)) fail(`${g.id}: category is not in the allowed list`);
    if (g.detectedIn !== undefined && !DETECTED_IN.includes(g.detectedIn)) {
      fail(`${g.id}: detectedIn must be one of ${DETECTED_IN.join(', ')}`);
    }
    const stage = GAP_LIFECYCLE.indexOf(g.status);
    if (stage < 0) fail(`${g.id}: status must be one of the gap lifecycle steps`);
    if (stage >= GAP_LIFECYCLE.indexOf('Assigned') && !g.owner) fail(`${g.id}: owner is required from Assigned onwards`);
    if (stage >= GAP_LIFECYCLE.indexOf('Root Cause Confirmed') && !g.rootCause) fail(`${g.id}: rootCause is required from Root Cause Confirmed onwards`);
    if (stage >= GAP_LIFECYCLE.indexOf('Fix Implemented') && !g.fix) fail(`${g.id}: fix is required from Fix Implemented onwards`);
    if (stage >= GAP_LIFECYCLE.indexOf('Regression Verified') && !g.regressionTests?.length) fail(`${g.id}: regressionTests are required from Regression Verified onwards`);
    if (stage >= GAP_LIFECYCLE.indexOf('Closed') && !g.acceptance?.length) fail(`${g.id}: acceptance criteria are required to close`);
    refs(g.id, 'journeyIds', g.journeyIds, 'journeys');
    refs(g.id, 'requirementIds', g.requirementIds, 'requirements');
  }

  for (const d of ledger.decisions ?? []) {
    if (!DECISION_STATUSES.includes(d.status)) fail(`${d.id}: status must be open or answered`);
    if (typeof d.question !== 'string' || d.question === '') fail(`${d.id}: question is required`);
    if (d.status === 'answered' && !d.answer) fail(`${d.id}: an answered decision needs an answer`);
    for (const id of d.blocks ?? []) {
      if (!known('journeys', id) && !known('requirements', id)) fail(`${d.id}: blocks references missing ${id}`);
    }
  }

  for (const t of ledger.tasks ?? []) {
    if (typeof t.owner !== 'string' || t.owner === '') fail(`${t.id}: owner is required`);
    if (!isStringList(t.files) || t.files.length === 0) fail(`${t.id}: files must list the paths the task owns`);
    if (!TASK_STATUSES.includes(t.status)) fail(`${t.id}: status must be one of ${TASK_STATUSES.join(', ')}`);
    refs(t.id, 'dependsOn', t.dependsOn, 'tasks');
  }

  for (const e of ledger.evidence ?? []) {
    if (e.kind === 'run') {
      if (typeof e.name !== 'string' || e.name === '') fail(`${e.id}: name is required`);
      if (!SCOPES.includes(e.scope)) fail(`${e.id}: scope must be one of ${SCOPES.join(', ')}`);
      if (typeof e.command !== 'string') fail(`${e.id}: command is required`);
      if (!Number.isInteger(e.exitCode)) fail(`${e.id}: exitCode must be an integer`);
      refs(e.id, 'journeyIds', e.journeyIds, 'journeys');
      refs(e.id, 'gapIds', e.gapIds, 'gaps');
    } else if (e.kind === 'review') {
      if (!REVIEW_VERDICTS.includes(e.verdict)) fail(`${e.id}: verdict must be one of ${REVIEW_VERDICTS.join(', ')}`);
      if (!('treeHash' in e)) fail(`${e.id}: treeHash is required`);
      if (e.reviewer !== undefined && !REVIEWERS.includes(e.reviewer)) {
        fail(`${e.id}: reviewer must be one of ${REVIEWERS.join(', ')}`);
      }
    } else {
      fail(`${e.id}: kind must be run or review`);
    }
  }
  if (ledger.project !== undefined) {
    if (typeof ledger.project !== 'object' || Array.isArray(ledger.project)) {
      fail('project must be an object');
    } else if (ledger.project.mode !== undefined && !MODES.includes(ledger.project.mode)) {
      fail(`project.mode must be one of ${MODES.join(', ')}`);
    }
  }
  return errors;
}

export function recordRun(ledger, ctx, { name, scope, command, cwd, journeyIds = [], gapIds = [], now = () => new Date() }) {
  if (!SCOPES.includes(scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
  const journeys = journeyIds.map((id) => findRequired(ledger, 'journeys', id));
  gapIds.forEach((id) => findRequired(ledger, 'gaps', id));

  const treeBefore = treeHash(ctx.projectDir);
  const before = Object.fromEntries(journeys.map((j) => [j.id, pathsHash(ctx.projectDir, j.dependsOn)]));
  const startedAt = now();
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
    timeout: RUN_TIMEOUT_MS,
  });
  const journeyHashes = Object.fromEntries(
    journeys.map((j) => [j.id, { before: before[j.id], after: pathsHash(ctx.projectDir, j.dependsOn) }]),
  );
  const output = `${result.stdout ?? ''}${result.stderr ?? ''}`.split('\n').slice(-TAIL_LINES).join('\n');
  const entry = {
    id: nextId(ledger, 'evidence'),
    kind: 'run',
    name,
    scope,
    command,
    cwd,
    exitCode: result.error ? -1 : (result.status ?? -1),
    startedAt: startedAt.toISOString(),
    durationMs: now() - startedAt,
    treeBefore,
    treeAfter: treeHash(ctx.projectDir),
    journeyIds,
    gapIds,
    journeyHashes,
    tail: output,
  };
  ledger.evidence.push(entry);
  return entry;
}

export function recordReview(ledger, ctx, { verdict, reviewer = 'release-reviewer', report = null, notes = '', now = () => new Date() }) {
  if (!REVIEW_VERDICTS.includes(verdict)) throw new Error(`verdict must be one of ${REVIEW_VERDICTS.join(', ')}`);
  if (!REVIEWERS.includes(reviewer)) throw new Error(`reviewer must be one of ${REVIEWERS.join(', ')}`);
  const entry = {
    id: nextId(ledger, 'evidence'),
    kind: 'review',
    reviewer,
    verdict,
    report,
    notes,
    recordedAt: now().toISOString(),
    treeHash: ctx.treeHash(),
  };
  ledger.evidence.push(entry);
  return entry;
}

// Computes the release status from the ledger and current evidence. Complete requires every
// requirement traced to a verified journey, no open Critical or High gap, a current passing full
// suite run, and a current passing independent review.
export function releaseStatus(ledger, ctx) {
  const blockers = [];
  const notReady = [];
  const partial = [];

  if (ledger.requirements.length === 0) notReady.push('no requirements recorded');
  if (ledger.journeys.length === 0) notReady.push('no user journeys mapped');

  for (const d of ledger.decisions) {
    if (d.status !== 'open') continue;
    (d.blocks?.length ? blockers : partial).push(`${d.id} is open: ${d.question}`);
  }

  for (const g of ledger.gaps) {
    if (g.status === 'Closed') continue;
    const line = `${g.id} ${g.severity} is open at ${g.status}: ${g.title}`;
    (['Critical', 'High'].includes(g.severity) ? notReady : partial).push(line);
  }

  for (const j of ledger.journeys) {
    const state = journeyState(ledger, j, ctx);
    if (state === 'verified') continue;
    const line = `${j.id} (${j.priority} priority) is ${state}`;
    if (state === 'blocked') blockers.push(line);
    else if (state === 'failed' || j.priority === 'high') notReady.push(line);
    else partial.push(line);
  }

  for (const r of ledger.requirements) {
    if (r.status === 'out-of-scope' || r.source === 'out-of-scope') continue;
    if (r.status === 'not-implemented') {
      (r.priority === 'high' ? notReady : partial).push(`${r.id} is not implemented: ${r.reason}`);
      continue;
    }
    const traced = ledger.journeys.some((j) => j.requirementIds.includes(r.id));
    if (!traced) (r.priority === 'high' ? notReady : partial).push(`${r.id} has no user journey`);
  }

  const runs = ledger.evidence.filter((e) => e.kind === 'run');
  const latestCurrent = (name, scope) =>
    [...runs].reverse().find((e) => e.name === name && e.scope === scope && runIsCurrent(e, ledger, ctx));
  for (const run of runs.filter((e) => ['regression', 'e2e', 'full'].includes(e.scope))) {
    if (!runIsCurrent(run, ledger, ctx) || run.exitCode === 0) continue;
    if (latestCurrent(run.name, run.scope)?.id === run.id) notReady.push(`${run.id} ${run.name} [${run.scope}] failed (exit ${run.exitCode})`);
  }
  const fullRun = latestCurrent('test', 'full');
  if (!fullRun || fullRun.exitCode !== 0) notReady.push('no current passing full suite run (run test --scope full)');

  const reviews = ledger.evidence.filter((e) => e.kind === 'review');
  const review = reviews[reviews.length - 1];
  if (!review) notReady.push('no independent review recorded');
  else if (review.verdict !== 'passed') notReady.push(`independent review ${review.id} is ${review.verdict}`);
  else if (!reviewIsCurrent(review, ctx)) notReady.push(`independent review ${review.id} is stale: the tree changed after it`);

  if (ledger.project?.mode === 'high-assurance') {
    const security = [...reviews].reverse().find((e) => e.reviewer === 'security-reviewer');
    if (!security || security.verdict !== 'passed' || !reviewIsCurrent(security, ctx)) {
      notReady.push('high-assurance mode needs a current passing security review');
    }
  }

  const status = blockers.length
    ? 'Blocked'
    : notReady.length
      ? 'Not Release Ready'
      : partial.length
        ? 'Partially Complete'
        : 'Complete';
  return { status, blockers, notReady, partial };
}

export function parseRun(args) {
  const split = args.indexOf('--');
  if (split < 1 || split === args.length - 1) throw new Error(`run needs a name and a command after "--"\n${USAGE}`);
  const [name, ...flags] = args.slice(0, split);
  const opts = { name, scope: 'focused', journeyIds: [], gapIds: [], cwd: undefined, command: args.slice(split + 1).join(' ') };
  const list = (value) => value.split(',').map((s) => s.trim()).filter(Boolean);
  for (let i = 0; i < flags.length; i += 2) {
    const [flag, value] = [flags[i], flags[i + 1]];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === '--scope') opts.scope = value;
    else if (flag === '--journey') opts.journeyIds = list(value);
    else if (flag === '--gap') opts.gapIds = list(value);
    else if (flag === '--cwd') opts.cwd = value;
    else throw new Error(`unknown run option: ${flag}`);
  }
  if (!SCOPES.includes(opts.scope)) throw new Error(`scope must be one of ${SCOPES.join(', ')}`);
  return opts;
}

export function writeOwnership(projectDir, ledger) {
  const owned = unionEntries(ledger.tasks.map((t) => t.files));
  if (owned.length === 0) throw new Error('no tasks with files; add one with "add tasks"');
  mkdirSync(stateDir(projectDir), { recursive: true });
  writeFileSync(ownershipPath(projectDir), `${JSON.stringify({ owned }, null, 2)}\n`);
  return owned;
}

const parseJson = (raw) => {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error('the value must be valid JSON');
  }
};

// Validates before saving, so an invalid change is never written.
function commit(projectDir, ledger) {
  const errors = validateLedger(ledger);
  if (errors.length) throw new Error(`change refused; the ledger would be invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}`);
  saveLedger(projectDir, ledger);
}

// Returns { code, out }. The CLI prints out and exits with code.
export function main(argv, env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
  const [command, ...args] = argv;
  const ok = (out) => ({ code: 0, out: `${out}\n` });
  const json = (value) => ({ code: 0, out: `${JSON.stringify(value, null, 2)}\n` });

  switch (command) {
    case 'init': {
      if (!existsSync(ledgerPath(projectDir))) saveLedger(projectDir, emptyLedger());
      return ok(`ledger: ${ledgerPath(projectDir)}`);
    }
    case 'add': {
      const [section, raw] = args;
      const ledger = loadLedger(projectDir);
      const item = addItem(ledger, section, parseJson(raw));
      commit(projectDir, ledger);
      return ok(item.id);
    }
    case 'set': {
      const [section, ...rest] = args;
      const ledger = loadLedger(projectDir);
      if (section === 'project') {
        setItem(ledger, section, null, parseJson(rest[0]));
        commit(projectDir, ledger);
        return ok('project updated');
      }
      const [id, raw] = rest;
      setItem(ledger, section, id, parseJson(raw));
      commit(projectDir, ledger);
      return ok(`${id} updated`);
    }
    case 'gap': {
      const [id, target] = args;
      const ledger = loadLedger(projectDir);
      const gap = findRequired(ledger, 'gaps', id);
      const result = gapTransition(ledger, gap, target, makeContext(projectDir));
      if (!result.ok) {
        return { code: 1, out: `${id} stays ${gap.status}:\n${result.reasons.map((r) => `  - ${r}`).join('\n')}\n` };
      }
      gap.status = target;
      commit(projectDir, ledger);
      return ok(`${id}: ${target}`);
    }
    case 'run': {
      const opts = parseRun(args);
      const ledger = loadLedger(projectDir);
      const entry = recordRun(ledger, makeContext(projectDir), { ...opts, cwd: opts.cwd ?? projectDir });
      commit(projectDir, ledger);
      const status = entry.exitCode === 0 ? 'passed' : `failed (exit ${entry.exitCode})`;
      return { code: entry.exitCode === 0 ? 0 : 1, out: `${entry.id} ${opts.name} [${opts.scope}] ${status}\n${entry.tail}\n` };
    }
    case 'review': {
      const [verdict, ...flags] = args;
      const opts = { verdict, report: null, notes: '', reviewer: 'release-reviewer' };
      for (let i = 0; i < flags.length; i += 2) {
        if (flags[i + 1] === undefined) throw new Error(`${flags[i]} needs a value`);
        if (flags[i] === '--report') opts.report = flags[i + 1];
        else if (flags[i] === '--notes') opts.notes = flags[i + 1];
        else if (flags[i] === '--reviewer') opts.reviewer = flags[i + 1];
        else throw new Error(`unknown review option: ${flags[i]}`);
      }
      const ledger = loadLedger(projectDir);
      const entry = recordReview(ledger, makeContext(projectDir), opts);
      commit(projectDir, ledger);
      return ok(`${entry.id} review ${verdict}`);
    }
    case 'validate': {
      const errors = validateLedger(loadLedger(projectDir));
      if (errors.length) return { code: 1, out: `ledger invalid:\n${errors.map((e) => `  - ${e}`).join('\n')}\n` };
      return ok('ledger valid');
    }
    case 'status': {
      const ledger = loadLedger(projectDir);
      const ctx = makeContext(projectDir);
      return json({
        journeys: ledger.journeys.map((j) => ({ id: j.id, priority: j.priority, state: journeyState(ledger, j, ctx) })),
        openGaps: ledger.gaps.filter((g) => g.status !== 'Closed').map((g) => ({ id: g.id, severity: g.severity, status: g.status })),
        release: releaseStatus(ledger, ctx).status,
      });
    }
    case 'release': {
      const result = releaseStatus(loadLedger(projectDir), makeContext(projectDir));
      return { code: result.status === 'Complete' ? 0 : 1, out: `${JSON.stringify(result, null, 2)}\n` };
    }
    case 'ownership': {
      const owned = writeOwnership(projectDir, loadLedger(projectDir));
      return ok(`ownership.json: ${owned.length} path(s)`);
    }
    case 'finish': {
      const result = releaseStatus(loadLedger(projectDir), makeContext(projectDir));
      if (result.status !== 'Complete') {
        return { code: 1, out: `run not finished: release status is ${result.status}\n${JSON.stringify(result, null, 2)}\n` };
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
