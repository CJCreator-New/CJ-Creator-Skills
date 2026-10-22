#!/usr/bin/env node
// Runs the perf test cases of the approved plan: bounded, read-only load against the test target, with
// the latency and error-rate thresholds the plan states. It is opt-in (G21). It refuses to start unless
// the config sets loadLimits and the run sets E2E_ALLOW_LOAD=1, and a check over the limits is blocked.
// Each run, and a defect for each confirmed breach, is recorded in the ledger.
//
// node scripts/run-perf.mjs <ledger.json> <config.json> --root <repo> [--only TC-1,TC-2] [--base <url>]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blocked, Infrastructure, classify } from './checks.mjs';
import { readLedger, recordResults, writeLedger } from './ledger.mjs';
import { planDigest } from './plan.mjs';
import { selectTestCases } from './results.mjs';
import { createStopper, healthStop } from './stops.mjs';
import { createContext } from './run-api.mjs';
import { judgeLoad, loadRefusal, runLoad, validateLoadChecks } from './load.mjs';

export async function runPerf({ ledgerPath, configPath, root, base, env, now, only = null, fetchImpl = fetch, health = undefined }) {
  const ledger = readLedger(ledgerPath);
  if (!ledger.intake || !ledger.intake.safety.allowed) throw new Error('the run is not allowed; run intake first');
  if (!ledger.approval) throw new Error('the test plan is not approved');
  if (ledger.approval.planHash !== planDigest(ledger)) throw new Error('the plan changed after approval; freeze and approve it again');

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const refusal = loadRefusal(config, env);
  if (refusal) throw new Error(`the load run is refused: ${refusal}`);
  const baseUrl = base ?? config.targets?.web?.baseUrl ?? config.targets?.['mobile-web']?.baseUrl;
  if (!baseUrl) throw new Error('no base URL: pass --base, or declare targets.web.baseUrl');

  const ctx = createContext({ ledger, config, root, base: baseUrl, env, fetchImpl });
  const requirementsById = new Map((ledger.requirements || []).map((r) => [r.id, r]));
  const testCases = selectTestCases(ledger, ['perf'], only);
  const results = [];
  const held = await healthStop({ config, testCases, runner: 'perf', ...(health ? { check: health } : {}) });
  const stopper = createStopper({ config, ledger, root, runner: 'perf' });
  // One perf test case at a time, so two loads never add up past the limits.
  for (const testCase of held ? [] : testCases) {
    const finish = (outcome) => ({
      id: testCase.id,
      result: classify(outcome.result, testCase, requirementsById),
      failures: outcome.failures || [],
      reasons: outcome.reasons || [],
      evidence: outcome.evidence || [],
    });
    const why = stopper.check(testCase);
    if (why) {
      results.push(finish(stopper.stoppedResult(testCase, why)));
      continue;
    }
    const problems = validateLoadChecks(testCase);
    if (problems.length > 0) {
      results.push(finish({ result: 'blocked', reasons: problems }));
      continue;
    }
    const evidence = [];
    let outcome = null;
    for (const [i, check] of testCase.checks.entries()) {
      const label = `check ${i + 1} (load)`;
      try {
        const headers = {};
        if (check.as) headers.authorization = `Bearer ${await ctx.sessionFor(check.as)}`;
        const url = new URL(check.request.path, baseUrl);
        const send = async () => {
          const res = await fetchImpl(url, { method: 'GET', headers });
          await res.arrayBuffer();
          return res.status;
        };
        const measured = await runLoad(check, { limits: config.loadLimits, send });
        const verdict = judgeLoad(check, measured);
        evidence.push({ check: label, ok: verdict.ok, message: verdict.message, measured, thresholds: check.thresholds });
        if (!verdict.ok) {
          outcome = { result: 'failed', failures: [{ check: label, message: verdict.message }], evidence };
          break;
        }
      } catch (error) {
        if (!(error instanceof Blocked) && !(error instanceof Infrastructure)) throw error;
        const kind = error instanceof Infrastructure ? 'infrastructure: ' : '';
        outcome = { result: 'blocked', reasons: [`${label}: ${kind}${error.message}`], evidence };
        break;
      }
    }
    const result = finish(outcome ?? { result: 'passed', evidence });
    stopper.note(result, { testCase });
    results.push(result);
  }
  if (held) results.push(...held.results);

  const recorded = recordResults(ledger, results, { now, stops: held ? held.stops : stopper.stops() });
  writeLedger(ledgerPath, ledger);

  const tally = {};
  for (const result of results) tally[result.result] = (tally[result.result] || 0) + 1;
  return {
    ran: results.length,
    results: tally,
    measured: results.map((r) => ({ id: r.id, result: r.result, evidence: r.evidence.map((e) => e.measured).filter(Boolean) })),
    failed: results.filter((r) => r.result === 'failed').map((r) => ({ id: r.id, failures: r.failures })),
    blocked: results.filter((r) => r.result === 'blocked').map((r) => ({ id: r.id, reasons: r.reasons })),
    defects: ledger.defects.length,
    opened: recorded.opened,
    flaky: recorded.flaky,
    transitions: recorded.transitions,
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  const [ledgerPath, configPath] = positional;
  if (!ledgerPath || !configPath) {
    console.error('usage: run-perf.mjs <ledger.json> <config.json> --root <repo> [--only TC-1,TC-2] [--base <url>]');
    process.exit(1);
  }
  runPerf({
    ledgerPath: resolve(ledgerPath),
    configPath: resolve(configPath),
    root: resolve(flags.root ?? '.'),
    base: flags.base,
    env: process.env,
    now: new Date().toISOString(),
    only: flags.only ? flags.only.split(',') : null,
  })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
