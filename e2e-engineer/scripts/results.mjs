// The state of each test case, read from its runs. A run is evidence for one build and one version of
// the test case. When either changes, the run is stale and does not count.
//
// States: passed, failed, blocked, needs-confirmation, flaky, stale, not run. A test case that passed
// and failed on the same build, under the same definition, is flaky (G23). Flaky is never passed, and
// it is not a defect in the app until triage says so.

import { createHash } from 'node:crypto';
import { canonical } from './plan.mjs';
import { inScope } from './traceability.mjs';

export function testHash(testCase) {
  return createHash('sha256').update(JSON.stringify(canonical(testCase))).digest('hex');
}

function runIsCurrent(ledger, run, hash) {
  if (!ledger.intake?.build?.current || run.build !== ledger.intake.build.treeHash) return false;
  return run.testHash === undefined || run.testHash === hash;
}

export function testState(ledger, testCaseId) {
  const runs = ledger.runs.filter((run) => run.testCase === testCaseId);
  if (runs.length === 0) return { state: 'not run' };
  const latest = runs[runs.length - 1];
  const tc = ledger.testCases.find((t) => t.id === testCaseId);
  const hash = tc ? testHash(tc) : undefined;
  if (!runIsCurrent(ledger, latest, hash)) return { state: 'stale', run: latest.id };
  const current = runs.filter((run) => runIsCurrent(ledger, run, hash));
  const results = new Set(current.map((run) => run.result));
  if (results.has('passed') && results.has('failed')) {
    return { state: 'flaky', run: latest.id, reasons: [`passed and failed on the same build (${current.map((r) => `${r.id} ${r.result}`).join(', ')})`] };
  }
  return { state: latest.result, run: latest.id, reasons: latest.reasons || [] };
}

// The implemented, in-scope test cases of the given layers. With `only`, just those IDs; an ID that is
// not in the plan, is out of scope, or is not implemented is an error, so a retest never silently runs
// less than it was asked to.
export function selectTestCases(ledger, layers, only = null) {
  const runnable = (tc) => layers.includes(tc.layer) && tc.automation === 'implemented' && inScope(tc);
  if (!only) return ledger.testCases.filter(runnable);
  for (const id of only) {
    const tc = ledger.testCases.find((t) => t.id === id);
    if (!tc) throw new Error(`test case ${id} is not in the plan`);
    if (!inScope(tc)) throw new Error(`test case ${id} is out of scope: ${tc.outOfScope}`);
    if (tc.automation !== 'implemented') throw new Error(`test case ${id} is not implemented`);
  }
  return ledger.testCases.filter((tc) => runnable(tc) && only.includes(tc.id));
}
