#!/usr/bin/env node
// Runs the static test cases (on the mobile project's files, no device needed) and the native test
// cases (android, ios: a Maestro flow on a device or simulator), then records each run, and a defect
// for each confirmed failure, in the ledger. The plan must be approved and current. A native test case
// is blocked, with its reason, when its target is not in scope, its binary is missing or does not match
// the build handover, or its device or tools are not there.
//
// node scripts/run-mobile.mjs <ledger.json> <config.json> --root <repo>

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blocked, classify } from './checks.mjs';
import { readLedger, recordDefect, recordRun, writeLedger } from './ledger.mjs';
import { planDigest } from './plan.mjs';
import { resetDatabase, validateTarget } from './env.mjs';
import { currentProbes, defaultExec, runNativeTestCase } from './native.mjs';
import { validateRun } from './safety.mjs';

const LAYERS = ['static', 'android', 'ios'];

export async function runMobile({ ledgerPath, configPath, root, env, now, exec = defaultExec, probes = null }) {
  const ledger = readLedger(ledgerPath);
  if (!ledger.intake || !ledger.intake.safety.allowed) throw new Error('the run is not allowed; run intake first');
  if (!ledger.approval) throw new Error('the test plan is not approved');
  if (ledger.approval.planHash !== planDigest(ledger)) throw new Error('the plan changed after approval; freeze and approve it again');

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const decision = validateRun(config);
  if (config.db) {
    const target = validateTarget({ config, root });
    if (!target.ok) throw new Error(`database refused: ${target.reasons.join('; ')}`);
  }
  const secrets = (ledger.roles || []).map((r) => env[r.account?.passwordEnv]).filter(Boolean);
  const requirementsById = new Map((ledger.requirements || []).map((r) => [r.id, r]));
  const currentProbesNow = probes ?? currentProbes(env);
  const projectDir = config.mobileProjects?.android ? resolve(root, config.mobileProjects.android) : null;
  const reset =
    config.db && config.allowReset === true
      ? () => {
          resetDatabase({ config, root, now: new Date().toISOString() });
        }
      : null;

  const testCases = ledger.testCases.filter((tc) => LAYERS.includes(tc.layer) && tc.automation === 'implemented');
  const results = [];
  for (const testCase of testCases) {
    const finish = (outcome) => ({
      id: testCase.id,
      layer: testCase.layer,
      mutates: testCase.mutates,
      journeys: testCase.journeys || [],
      requirements: testCase.requirements || [],
      result: classify(outcome.result, testCase, requirementsById),
      failures: outcome.failures || [],
      reasons: outcome.reasons || [],
      evidence: outcome.evidence || [],
    });
    if (testCase.layer === 'static' && !projectDir) {
      results.push(finish({ result: 'blocked', reasons: ['no Android project is declared in mobileProjects'] }));
      continue;
    }
    if (testCase.mutates && config.db && !reset) {
      results.push(finish({ result: 'blocked', reasons: ['a fresh database is needed before a mutating test, and reset is not allowed'] }));
      continue;
    }
    if (reset && testCase.mutates) reset();
    const ctx = {
      root,
      env,
      secrets,
      probes: currentProbesNow,
      binaries: ledger.binaries || [],
      exec,
      projectDir,
      targetConfig: config.targets?.[testCase.layer] ?? null,
      target: testCase.layer,
    };
    let outcome;
    try {
      outcome = await runNativeTestCase({ testCase, ctx });
    } catch (error) {
      if (!(error instanceof Blocked)) throw error;
      outcome = { result: 'blocked', failures: [], reasons: [error.message], evidence: [] };
    }
    results.push(finish(outcome));
  }

  for (const result of results) {
    recordRun(ledger, { testCase: result.id, result: result.result, reasons: result.reasons, failures: result.failures, evidence: result.evidence, now });
    if (result.result === 'failed') recordDefect(ledger, { testCase: result.id, failures: result.failures, now });
  }
  writeLedger(ledgerPath, ledger);

  const tally = {};
  for (const result of results) tally[result.result] = (tally[result.result] || 0) + 1;
  return {
    ran: results.length,
    results: tally,
    failed: results.filter((r) => r.result === 'failed').map((r) => ({ id: r.id, failures: r.failures })),
    blocked: results.filter((r) => r.result === 'blocked').map((r) => ({ id: r.id, reasons: r.reasons })),
    defects: ledger.defects.length,
    safety: decision.allowed,
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
    console.error('usage: run-mobile.mjs <ledger.json> <config.json> --root <repo>');
    process.exit(1);
  }
  runMobile({
    ledgerPath: resolve(ledgerPath),
    configPath: resolve(configPath),
    root: resolve(flags.root ?? '.'),
    env: process.env,
    now: new Date().toISOString(),
  })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
