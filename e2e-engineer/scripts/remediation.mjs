// The defect lifecycle after detection: triage, an independent second review for Critical findings,
// merging duplicates, the handoff packet, the developer's fix claim, and the retest and regression
// evaluation that closes a defect. The skill never edits application code (G7). A fix comes back as a
// new build, and only runs on that build can close the defect.
//
// States, in order: Detected, Confirmed, Triaged, Handed Off, Fix Claimed, Retest Passed,
// Regression Passed, Closed. A developer's claim moves a defect to Fix Claimed only. The evaluation
// moves it on: Retest Passed when every test case of the defect passes on the current build, then
// Regression Passed and Closed when the regression set passes on that build too. A failing retest
// sends a handed-off defect back to Handed Off.

import { inScope } from './traceability.mjs';
import { testState } from './results.mjs';

export const DEFECT_STATES = ['Detected', 'Confirmed', 'Triaged', 'Handed Off', 'Fix Claimed', 'Retest Passed', 'Regression Passed', 'Closed'];
export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];
export const DISPOSITIONS = ['product', 'test'];

const RANK = { Critical: 4, High: 3, Medium: 2, Low: 1 };

const text = (value) => typeof value === 'string' && value.trim() !== '';

function find(ledger, id) {
  const defect = (ledger.defects || []).find((d) => d.id === id);
  if (!defect) throw new Error(`defect ${id} is not in the ledger`);
  return defect;
}

function move(defect, status, { at, by = 'e2e-engineer', note = '' }) {
  defect.status = status;
  defect.history = defect.history || [];
  defect.history.push({ status, at, by, note });
}

export function isOpen(defect) {
  return defect.status !== 'Closed';
}

function currentBuild(ledger) {
  return ledger.intake?.build?.treeHash ?? null;
}

// The lowest severity the plan allows for a defect, with the reason. A defect on a requirement the plan
// marks with a Critical risk (another tenant's data, an authentication bypass, exposed data, lost data,
// money) is Critical. A defect on a P0 journey, or on an access-control case, is at least High.
// Critical always needs a second review.
export function severityFloor(ledger, defect) {
  for (const reqId of defect.requirements || []) {
    const risk = (ledger.requirements || []).find((r) => r.id === reqId)?.risk || [];
    if (risk.length > 0) return { severity: 'Critical', reason: `${reqId} carries the risk ${risk.join(', ')}` };
  }
  const journeys = new Map((ledger.journeys || []).map((j) => [j.id, j]));
  for (const tcId of defect.testCases || []) {
    const tc = ledger.testCases.find((t) => t.id === tcId);
    if (!tc) continue;
    const p0 = (tc.journeys || []).find((id) => journeys.get(id)?.priority === 'P0');
    if (p0) return { severity: 'High', reason: `${tcId} is on P0 journey ${p0}` };
    if ((tc.permissions || []).length > 0) return { severity: 'High', reason: `${tcId} is an access-control case (${tc.permissions.join(', ')})` };
  }
  return { severity: 'Low', reason: null };
}

function checkFloor(ledger, defect, severity) {
  const floor = severityFloor(ledger, defect);
  if (RANK[severity] < RANK[floor.severity]) {
    throw new Error(`${defect.id} cannot be ${severity}: ${floor.reason}, so it is at least ${floor.severity}`);
  }
}

// Records the triage decision. Allowed until the defect is handed off. A test disposition means the
// test, not the app, is wrong: the fix is a plan change, which needs a new approval.
export function triageDefect(ledger, id, { severity, owner, rootCause, disposition = 'product', rationale = '', by, now }) {
  const defect = find(ledger, id);
  if (!['Detected', 'Confirmed', 'Triaged'].includes(defect.status)) throw new Error(`${id} is ${defect.status}; triage is only before handoff`);
  if (!SEVERITIES.includes(severity)) throw new Error(`severity must be one of ${SEVERITIES.join(', ')}`);
  if (!DISPOSITIONS.includes(disposition)) throw new Error(`disposition must be one of ${DISPOSITIONS.join(', ')}`);
  if (!text(owner)) throw new Error('an owner is required, such as backend-engineer or frontend-engineer');
  if (!text(rootCause)) throw new Error('a root cause is required');
  if (!text(by)) throw new Error('the triager is required');
  checkFloor(ledger, defect, severity);
  Object.assign(defect, { severity, owner, rootCause, disposition, rationale, triagedBy: by });
  if (severity === 'Critical') defect.secondReview = { status: 'pending' };
  else delete defect.secondReview;
  move(defect, 'Triaged', { at: now, by, note: `${severity}, ${disposition}, owner ${owner}` });
  return defect;
}

// The independent second review of a Critical defect. The reviewer is not the triager. The reviewer
// confirms Critical, or changes the severity, within the floor.
export function reviewDefect(ledger, id, { by, verdict, severity, note = '', now }) {
  const defect = find(ledger, id);
  if (defect.secondReview?.status !== 'pending') throw new Error(`${id} has no second review pending`);
  if (!text(by)) throw new Error('the reviewer is required');
  if (by === defect.triagedBy) throw new Error(`${id} was triaged by ${by}; the second review needs a different reviewer`);
  if (verdict === 'changed') {
    if (!SEVERITIES.includes(severity) || severity === 'Critical') throw new Error('a changed verdict names the new severity, below Critical');
    checkFloor(ledger, defect, severity);
    defect.severity = severity;
  } else if (verdict !== 'confirmed') {
    throw new Error('verdict must be confirmed or changed');
  }
  defect.secondReview = { status: 'done', by, verdict, note, at: now };
  defect.history.push({ status: defect.status, at: now, by, note: `second review: ${verdict}${verdict === 'changed' ? ` to ${severity}` : ''}` });
  return defect;
}

// Merges a duplicate into the defect with the same root cause. The duplicate closes as a duplicate,
// and its test cases and evidence move to the defect it merges into.
export function mergeDefect(ledger, duplicateId, intoId, { by, note = '', now }) {
  if (duplicateId === intoId) throw new Error('a defect cannot merge into itself');
  const duplicate = find(ledger, duplicateId);
  const into = find(ledger, intoId);
  if (!isOpen(duplicate) || !isOpen(into)) throw new Error('only open defects merge');
  if (!text(by)) throw new Error('the person merging is required');
  const union = (a, b) => [...new Set([...(a || []), ...(b || [])])];
  into.testCases = union(into.testCases, duplicate.testCases);
  into.requirements = union(into.requirements, duplicate.requirements);
  into.evidence = [...(into.evidence || []), ...(duplicate.evidence || [])];
  into.history = into.history || [];
  into.history.push({ status: into.status, at: now, by, note: `merged ${duplicateId}${note ? `: ${note}` : ''}` });
  duplicate.disposition = 'duplicate';
  duplicate.mergedInto = intoId;
  move(duplicate, 'Closed', { at: now, by, note: `duplicate of ${intoId}` });
  return into;
}

// The test cases that must pass, on the fixed build, before a defect closes: every in-scope,
// implemented test case on the defect's journeys, and every one on a P0 journey.
export function regressionSet(ledger, defect) {
  const tests = ledger.testCases.filter((tc) => tc.automation === 'implemented' && inScope(tc));
  const journeys = new Set(
    (defect.testCases || []).flatMap((id) => ledger.testCases.find((t) => t.id === id)?.journeys || []),
  );
  const p0 = new Set((ledger.journeys || []).filter((j) => j.priority === 'P0').map((j) => j.id));
  return tests
    .filter((tc) => (defect.testCases || []).includes(tc.id) || (tc.journeys || []).some((j) => journeys.has(j) || p0.has(j)))
    .map((tc) => tc.id)
    .sort();
}

// The handoff packet for the owner. It holds what the owner needs to reproduce and fix the defect, and
// the acceptance criteria the retest checks: the requirement, the test cases, what was observed, and
// the regression set. It never holds a credential; the evidence was redacted before it was recorded.
export function handOff(ledger, id, { now }) {
  const defect = find(ledger, id);
  if (!['Triaged', 'Handed Off'].includes(defect.status)) throw new Error(`${id} is ${defect.status}; only a triaged defect is handed off`);
  if (defect.secondReview?.status === 'pending') throw new Error(`${id} is Critical and its second review is pending`);
  const requirements = (defect.requirements || [])
    .map((rid) => (ledger.requirements || []).find((r) => r.id === rid))
    .filter(Boolean)
    .map(({ id: rid, text: t, oracle, source }) => ({ id: rid, text: t, oracle, source }));
  const testCases = (defect.testCases || [])
    .map((tid) => ledger.testCases.find((t) => t.id === tid))
    .filter(Boolean)
    .map((tc) => ({
      id: tc.id,
      title: tc.title,
      layer: tc.layer,
      roles: tc.roles || [],
      viewport: tc.viewport,
      expected: tc.expected || [],
      ...(tc.steps ? { steps: tc.steps } : {}),
      ...(tc.checks ? { checks: tc.checks } : {}),
    }));
  ledger.handoffs = ledger.handoffs || [];
  const version = ledger.handoffs.filter((h) => h.defect === id).length + 1;
  const regression = regressionSet(ledger, defect);
  const packet = {
    id: `HO-${id}-${version}`,
    defect: id,
    version,
    title: defect.title,
    owner: defect.owner,
    severity: defect.severity,
    disposition: defect.disposition,
    rootCause: defect.rootCause,
    detectedOnBuild: defect.build,
    issuedOnBuild: currentBuild(ledger),
    issuedAt: now,
    requirements,
    testCases,
    observed: defect.evidence || [],
    acceptance: [
      ...testCases.flatMap((tc) => tc.expected.map((line) => `${tc.id}: ${line}`)),
      'every test case in the regression set passes on the fixed build, or fails only on a defect that was open before it',
    ],
    retest: defect.testCases,
    regression,
    rules:
      defect.disposition === 'test'
        ? ['The test, not the app, is wrong. The fix is a change to the test plan, and the changed plan needs a new approval.']
        : [
            'Fix the application. Do not change the test cases, the plan or the ledger to make a test pass.',
            'A fix is a new build. A pass on the build where the test failed is flaky, not a fix.',
            'Saying the fix is done moves the defect to Fix Claimed only. It closes after the retest and the regression run pass.',
          ],
  };
  ledger.handoffs.push(packet);
  defect.handoff = packet.id;
  move(defect, 'Handed Off', { at: now, note: `${packet.id} to ${defect.owner}` });
  return packet;
}

export function renderHandoff(packet) {
  const list = (items) => (items.length ? items.map((item) => `- ${item}`).join('\n') : '- none');
  const lines = [
    `# ${packet.id}: ${packet.title}`,
    '',
    `Defect ${packet.defect}, ${packet.severity}, for ${packet.owner}. Disposition: ${packet.disposition}.`,
    '',
    `Detected on build ${packet.detectedOnBuild}. Packet issued on build ${packet.issuedOnBuild}, ${packet.issuedAt}.`,
    '',
    '## Root cause',
    '',
    packet.rootCause,
    '',
    '## Requirements',
    '',
    list(packet.requirements.map((r) => `${r.id} (${r.oracle}): ${r.text} Source: ${r.source}`)),
    '',
    '## What was observed',
    '',
    list(packet.observed.map((e) => `${e.check ?? e.step ?? 'check'}: ${e.message}`)),
    '',
    '## How to reproduce',
    '',
  ];
  for (const tc of packet.testCases) {
    lines.push(`### ${tc.id}: ${tc.title} (${tc.layer}${tc.viewport ? `, ${tc.viewport}` : ''})`, '');
    if (tc.roles.length) lines.push(`Roles: ${tc.roles.join(', ')}.`, '');
    lines.push('```json', JSON.stringify(tc.steps ?? tc.checks ?? [], null, 2), '```', '');
  }
  lines.push(
    '## Acceptance criteria',
    '',
    list(packet.acceptance),
    '',
    '## Retest',
    '',
    `The retest runs ${packet.retest.join(', ')} on the fixed build:`,
    '',
    '```',
    `node "\${CLAUDE_PLUGIN_ROOT}/scripts/retest.mjs" <ledger.json> <qa.config.json> --root <repo> --defect ${packet.defect}`,
    '```',
    '',
    `Then the regression set: ${packet.regression.join(', ')}.`,
    '',
    '## Rules',
    '',
    list(packet.rules),
    '',
  );
  return lines.join('\n');
}

// A named decision to release with an open defect (G18). Only a person accepts a risk, and each accepted
// defect needs its own decision with its reason. The defect stays open, its failures stay in the
// report, and the gate reads PASS WITH ACCEPTED RISKS instead of PASS. A Critical defect cannot be
// accepted until its second review is done.
export function acceptRisk(ledger, id, { by, reason, now }) {
  const defect = find(ledger, id);
  if (!isOpen(defect)) throw new Error(`${id} is closed; there is no risk to accept`);
  if (!text(by) || by === 'e2e-engineer') throw new Error('a risk is accepted by a named person, not by the skill');
  if (!text(reason)) throw new Error('the reason for accepting the risk is required');
  if (!SEVERITIES.includes(defect.severity)) throw new Error(`${id} is not triaged; triage it before accepting its risk`);
  if (defect.secondReview?.status === 'pending') throw new Error(`${id} is Critical and its second review is pending`);
  defect.acceptedRisk = { by, reason, at: now, build: currentBuild(ledger) };
  defect.history = defect.history || [];
  defect.history.push({ status: defect.status, at: now, by, note: `risk accepted: ${reason}` });
  return defect;
}

// Whether the current failure of a test case is covered by an open defect whose risk was accepted.
export function acceptedFailure(ledger, testCaseId) {
  return (ledger.defects || []).some((d) => isOpen(d) && d.acceptedRisk && (d.testCases || []).includes(testCaseId));
}

// The owner says the fix is in. This does not close anything; the retest decides.
export function claimFix(ledger, id, { by, note = '', now }) {
  const defect = find(ledger, id);
  if (defect.status !== 'Handed Off') throw new Error(`${id} is ${defect.status}; a fix is claimed only for a handed-off defect`);
  if (!text(by)) throw new Error('the person claiming the fix is required');
  defect.claim = { by, note, at: now, build: currentBuild(ledger), runsBefore: ledger.runs.length };
  move(defect, 'Fix Claimed', { at: now, by, note: note || 'fix claimed' });
  return defect;
}

// A failure on a test case is known when another open defect covers it and was detected on an earlier
// build. A failure first seen on the fixed build is a regression.
function knownFailure(ledger, defect, tcId) {
  const build = currentBuild(ledger);
  return (ledger.defects || []).some(
    (d) => d.id !== defect.id && isOpen(d) && (d.testCases || []).includes(tcId) && d.build !== build,
  );
}

function runNumber(runId) {
  return Number.parseInt(String(runId).replace(/^R-/, ''), 10) || 0;
}

// Moves each open defect on from the runs recorded so far. Returns the transitions made.
export function evaluateDefects(ledger, { now }) {
  const transitions = [];
  const build = currentBuild(ledger);
  for (const defect of ledger.defects || []) {
    if (!isOpen(defect)) continue;
    const states = (defect.testCases || []).map((id) => ({ id, ...testState(ledger, id) }));
    const from = defect.status;

    if (states.some((s) => s.state === 'flaky')) {
      defect.flaky = states.filter((s) => s.state === 'flaky').map((s) => s.id);
    }
    // A claimed fix is judged only by runs recorded after the claim. The failure that opened the
    // defect is older than the claim, so it does not send the defect back on its own.
    const after = (s) => defect.status !== 'Fix Claimed' || runNumber(s.run) > (defect.claim?.runsBefore ?? 0);
    const failing = states.filter((s) => s.state === 'failed' && after(s));
    if (failing.length > 0) {
      if (['Fix Claimed', 'Retest Passed', 'Regression Passed'].includes(defect.status)) {
        delete defect.retest;
        delete defect.regression;
        move(defect, 'Handed Off', { at: now, note: `retest failed on build ${build}: ${failing.map((s) => s.id).join(', ')}` });
      }
    } else if (states.length > 0 && states.every((s) => s.state === 'passed')) {
      if (!['Retest Passed', 'Regression Passed'].includes(defect.status)) {
        defect.retest = { build, runs: states.map((s) => s.run), at: now };
        move(defect, 'Retest Passed', { at: now, note: `${states.map((s) => s.id).join(', ')} passed on build ${build}` });
      }
      const set = regressionSet(ledger, defect);
      const missing = [];
      const regressions = [];
      const known = [];
      for (const id of set) {
        const { state } = testState(ledger, id);
        if (state === 'passed' || state === 'needs-confirmation') continue;
        if (state === 'failed' && knownFailure(ledger, defect, id)) known.push(id);
        else if (state === 'failed') regressions.push(id);
        else missing.push(`${id} ${state}`);
      }
      if (regressions.length > 0) {
        defect.regression = { status: 'failed', build, failing: regressions, at: now };
      } else if (missing.length > 0) {
        defect.regression = { status: 'incomplete', build, missing, at: now };
      } else {
        defect.regression = { status: 'passed', build, tests: set, knownFailures: known, at: now };
        move(defect, 'Regression Passed', { at: now, note: `${set.length} regression test case(s) on build ${build}` });
        defect.closedAt = now;
        defect.closedOnBuild = build;
        move(defect, 'Closed', { at: now, note: 'retest and regression passed on the current build' });
      }
    }
    if (defect.status !== from) transitions.push({ defect: defect.id, from, to: defect.status });
  }
  return transitions;
}
