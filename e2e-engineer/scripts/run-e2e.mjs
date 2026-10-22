#!/usr/bin/env node
// Runs the e2e (cross-layer) test cases of the approved plan: each one acts through the UI in Chromium,
// then checks the API and the stored data in the same test case, so the three layers are checked to
// agree. Each test case starts from a fresh database and runs alone. Records each run, and a defect for
// each confirmed failure, in the ledger. The plan must be approved and current.
//
// node scripts/run-e2e.mjs <ledger.json> <config.json> --root <repo> [--only TC-1,TC-2] [--web <url>]

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrowserSuite } from './run-web.mjs';

export function runE2e(options) {
  return runBrowserSuite({ ...options, layers: ['e2e'] });
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
    console.error('usage: run-e2e.mjs <ledger.json> <config.json> --root <repo> [--only TC-1,TC-2] [--web <url>]');
    process.exit(1);
  }
  runE2e({
    ledgerPath: resolve(ledgerPath),
    configPath: resolve(configPath),
    root: resolve(flags.root ?? '.'),
    env: process.env,
    now: new Date().toISOString(),
    only: flags.only ? flags.only.split(',') : null,
    bases: { web: flags.web },
  })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
