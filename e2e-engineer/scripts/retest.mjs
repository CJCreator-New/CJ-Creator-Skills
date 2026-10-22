#!/usr/bin/env node
// Retests by test ID. Given a defect, it runs the defect's test cases; with --regression, the defect's
// regression set; with --tests, the named test cases. Each test case goes to the runner for its layer,
// and the runners record the runs, so the defect evaluation runs on what was recorded. The plan must be
// approved and current, as for any run.
//
// node scripts/retest.mjs <ledger.json> <config.json> --root <repo> --defect DEF-001 [--regression]
// node scripts/retest.mjs <ledger.json> <config.json> --root <repo> --tests TC-1,TC-2

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedger } from './ledger.mjs';
import { regressionSet } from './remediation.mjs';
import { testState } from './results.mjs';
import { runApi } from './run-api.mjs';
import { runWeb } from './run-web.mjs';
import { runE2e } from './run-e2e.mjs';
import { runMobile } from './run-mobile.mjs';
import { runPerf } from './run-perf.mjs';

const RUNNERS = [
  { name: 'api', layers: ['api', 'db'], run: runApi },
  { name: 'web', layers: ['web', 'mobile-web'], run: runWeb },
  { name: 'e2e', layers: ['e2e'], run: runE2e },
  { name: 'mobile', layers: ['static', 'android', 'ios'], run: runMobile },
  { name: 'perf', layers: ['perf'], run: runPerf },
];

// The test IDs to run, from a defect or a list.
export function retestTargets(ledger, { defect, regression = false, tests = null }) {
  if (tests) return tests;
  const found = (ledger.defects || []).find((d) => d.id === defect);
  if (!found) throw new Error(`defect ${defect} is not in the ledger`);
  if (found.status === 'Closed') throw new Error(`${defect} is closed`);
  return regression ? regressionSet(ledger, found) : found.testCases;
}

// Runs the IDs through their runners, in the order api, web, e2e, mobile, perf. `runners` lets a test
// replace a runner. Returns the summary of each runner that ran, and the defect after the runs.
export async function retest({ ledgerPath, configPath, root, env, now, defect = null, regression = false, tests = null, runners = {}, options = {} }) {
  const ledger = readLedger(ledgerPath);
  const ids = retestTargets(ledger, { defect, regression, tests });
  const unknown = ids.filter((id) => !ledger.testCases.some((t) => t.id === id));
  if (unknown.length > 0) throw new Error(`not in the plan: ${unknown.join(', ')}`);
  const summaries = {};
  for (const { name, layers, run } of RUNNERS) {
    const only = ids.filter((id) => layers.includes(ledger.testCases.find((t) => t.id === id).layer));
    if (only.length === 0) continue;
    summaries[name] = await (runners[name] ?? run)({ ledgerPath, configPath, root, env, now, only, ...(options[name] || {}) });
  }
  const after = readLedger(ledgerPath);
  const record = defect ? after.defects.find((d) => d.id === defect) : null;
  return {
    ran: ids,
    states: Object.fromEntries(ids.map((id) => [id, testState(after, id).state])),
    summaries,
    ...(record ? { defect: { id: record.id, status: record.status, regression: record.regression ?? null } } : {}),
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--regression') {
      flags.regression = true;
    } else if (args[i].startsWith('--')) {
      flags[args[i].slice(2)] = args[i + 1];
      i += 1;
    } else {
      positional.push(args[i]);
    }
  }
  const [ledgerPath, configPath] = positional;
  if (!ledgerPath || !configPath || (!flags.defect && !flags.tests)) {
    console.error('usage: retest.mjs <ledger.json> <config.json> --root <repo> (--defect DEF-001 [--regression] | --tests TC-1,TC-2)');
    process.exit(1);
  }
  retest({
    ledgerPath: resolve(ledgerPath),
    configPath: resolve(configPath),
    root: resolve(flags.root ?? '.'),
    env: process.env,
    now: new Date().toISOString(),
    defect: flags.defect ?? null,
    regression: flags.regression === true,
    tests: flags.tests ? flags.tests.split(',') : null,
    options: { web: { bases: { web: flags.web, mobile: flags.mobile } }, e2e: { bases: { web: flags.web } }, api: { base: flags.base }, perf: { base: flags.base } },
  })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
