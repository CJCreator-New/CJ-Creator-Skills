#!/usr/bin/env node
// Intake for one run: load the config, decide whether the run is allowed, record the build identity,
// probe the tools, and write the ledger. A refused run is recorded, and nothing else starts.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { treeHash } from './fingerprint.mjs';
import { validateRun } from './safety.mjs';
import { probeAll, targetReadiness } from './probe.mjs';
import { findPlaywright } from './browser.mjs';
import { defaultLedgerPath, readLedger, recordIntake, writeLedger } from './ledger.mjs';
import { gitignoreStatus } from './target.mjs';

// A web target needs a way to reach a running app: a start command the skill runs, or a health URL that
// shows the user started it. Without either, the skill would have to guess, so the target is blocked.
export function appReadiness(config) {
  const targets = config.targets || {};
  if (!targets.web && !targets['mobile-web']) return null;
  if (config.start || config.healthUrl) return { status: 'ready', start: Boolean(config.start), healthUrl: config.healthUrl ?? null };
  return { status: 'blocked', reason: 'no start command or healthUrl is declared, so the skill cannot start or check the target' };
}

function gitHead(root) {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;
  }
}

export function loadConfig(configPath) {
  if (!existsSync(configPath)) throw new Error(`config not found: ${configPath}`);
  try {
    return JSON.parse(readFileSync(configPath, 'utf8'));
  } catch (error) {
    throw new Error(`config is not valid JSON: ${error.message}`);
  }
}

// Runs intake and writes the ledger. Returns the intake record and the gate status it leads to.
export function runIntake({ root, configPath, env, platform, now = new Date().toISOString() }) {
  const config = loadConfig(configPath);
  const safety = validateRun(config);
  const commit = gitHead(root);
  const tree = commit ? treeHash(root) : null;
  const build = {
    commit,
    treeHash: tree,
    current: Boolean(commit && tree),
    note: commit ? null : 'no git repository: every run is stale until the tree is under version control',
  };
  const probes = probeAll({ env, platform });
  probes.playwright = findPlaywright({ root, config });
  const readiness = safety.allowed ? targetReadiness(probes, config.targets) : {};
  const app = safety.allowed ? appReadiness(config) : null;
  if (app) readiness.app = app;

  const ledgerPath = defaultLedgerPath(root);
  const ledger = readLedger(ledgerPath);
  recordIntake(ledger, {
    configName: config.name ?? null,
    safety,
    build,
    probes,
    readiness,
    targets: safety.allowed ? config.targets : {},
    integrations: Object.fromEntries(Object.entries(config.integrations || {}).map(([name, i]) => [name, i?.mode])),
    now,
  });
  writeLedger(ledgerPath, ledger);
  // The active marker tells the guard that a run is in progress. It exists only for an allowed run.
  const marker = join(dirname(ledgerPath), 'active');
  if (safety.allowed) writeFileSync(marker, now);
  else rmSync(marker, { force: true });
  return { ledgerPath, intake: ledger.intake, gitignore: gitignoreStatus(root) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let root = '.';
  let configArg = 'qa.config.json';
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--root') {
      root = args[i + 1];
      i += 1;
    } else {
      configArg = args[i];
    }
  }
  root = resolve(root);
  const configPath = resolve(configArg);
  try {
    const { ledgerPath, intake, gitignore } = runIntake({ root, configPath });
    console.log(JSON.stringify({ ledger: ledgerPath, allowed: intake.safety.allowed, problems: intake.safety.problems, readiness: intake.readiness, build: intake.build, gitignore }, null, 2));
    process.exitCode = intake.safety.allowed ? 0 : 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
