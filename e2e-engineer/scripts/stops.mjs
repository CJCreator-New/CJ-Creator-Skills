// Stop conditions for a run. A runner asks before each test case whether to go on, and tells the
// stopper what each test case did. When a condition holds, the remaining test cases are not run: they
// are recorded as blocked, with the reason, and the stop is recorded in the ledger, so the gate reads
// BLOCKED until the stopped test cases run again.
//
// Conditions, from the plan:
//   - the environment fails its health check twice (checked before the run, in target.mjs);
//   - more than `stops.infrastructureRate` (default 30%) of a lane's test cases fail on infrastructure,
//     once at least `stops.minSample` (default 3) have run;
//   - a device disconnects during a mutating journey;
//   - a security probe fails: the mutating test cases against that host stop, and the finding is
//     reported;
//   - the run budget is spent: `budget.maxMinutes` since intake, `budget.maxRuns` recorded runs, or
//     `budget.maxTokens` reported in the run's telemetry.

import { existsSync, readFileSync } from 'node:fs';
import { parseEntries, summarize, telemetryPath } from './telemetry.mjs';
import { checkHealth } from './target.mjs';

export const STOP_DEFAULTS = { infrastructureRate: 0.3, minSample: 3 };

const isInfrastructure = (result) => result.result === 'blocked' && (result.reasons || []).some((r) => /infrastructure:/.test(r));

function tokensUsed(root) {
  const file = telemetryPath(root);
  if (!existsSync(file)) return null;
  const tokens = summarize(parseEntries(readFileSync(file, 'utf8'))).tokens;
  return tokens === 'unavailable' ? null : tokens.input + tokens.output;
}

export function createStopper({ config = {}, ledger, root = null, runner, clock = () => Date.now() }) {
  const limits = { ...STOP_DEFAULTS, ...(config.stops || {}) };
  const budget = config.budget || {};
  const state = { total: 0, infrastructure: 0, all: null, mutating: null, stopped: [] };

  function budgetReason() {
    if (budget.maxMinutes && ledger.intake?.recordedAt) {
      const minutes = (clock() - Date.parse(ledger.intake.recordedAt)) / 60000;
      if (minutes > budget.maxMinutes) return `the run budget of ${budget.maxMinutes} minutes is spent`;
    }
    if (budget.maxRuns && ledger.runs.length + state.total >= budget.maxRuns) return `the run budget of ${budget.maxRuns} recorded runs is spent`;
    if (budget.maxTokens && root) {
      const used = tokensUsed(root);
      if (used !== null && used >= budget.maxTokens) return `the token budget of ${budget.maxTokens} is spent (${used} reported)`;
    }
    return null;
  }

  return {
    // The reason this test case must not run, or null.
    check(testCase) {
      if (state.all) return state.all;
      const spent = budgetReason();
      if (spent) {
        state.all = spent;
        return spent;
      }
      if (testCase.mutates && state.mutating) return state.mutating;
      return null;
    },
    // Records what a test case did, and raises any condition it triggers.
    note(result, { testCase = null, deviceLost = false } = {}) {
      state.total += 1;
      if (isInfrastructure(result)) state.infrastructure += 1;
      if (deviceLost && testCase?.mutates) state.all = state.all ?? `the device disconnected during the mutating journey ${result.id}`;
      const probeFailed = result.result === 'failed' && (result.failures || []).some((f) => /\(probe/.test(f.check));
      if (probeFailed) state.mutating = state.mutating ?? `security probe ${result.id} failed, so mutating test cases against this host stop`;
      if (state.total >= limits.minSample && state.infrastructure / state.total > limits.infrastructureRate) {
        state.all = state.all ?? `${state.infrastructure} of ${state.total} test cases in the ${runner} lane failed on infrastructure, over the limit of ${Math.round(limits.infrastructureRate * 100)}%`;
      }
    },
    // A blocked result for a test case the stopper held back.
    stoppedResult(testCase, reason) {
      state.stopped.push({ id: testCase.id, reason });
      return { result: 'blocked', failures: [], reasons: [`stopped: ${reason}`], evidence: [] };
    },
    // The stops to record in the ledger, one per reason.
    stops() {
      const byReason = new Map();
      for (const { id, reason } of state.stopped) byReason.set(reason, [...(byReason.get(reason) || []), id]);
      return [...byReason].map(([reason, tests]) => ({ runner, reason, tests }));
    },
  };
}

// The health check before a lane runs. When the environment fails it twice, no test case runs: each
// is blocked with the reason, and the stop is returned for the ledger. Otherwise null.
export async function healthStop({ config, testCases, runner, check = checkHealth }) {
  if (!config.healthUrl || testCases.length === 0) return null;
  const health = await check(config);
  if (health.healthy !== false) return null;
  const reason = `the environment failed its health check twice (${health.reason})`;
  return {
    stops: [{ runner, reason, tests: testCases.map((tc) => tc.id) }],
    results: testCases.map((tc) => ({ id: tc.id, result: 'blocked', failures: [], reasons: [`stopped: ${reason}`], evidence: [] })),
  };
}
