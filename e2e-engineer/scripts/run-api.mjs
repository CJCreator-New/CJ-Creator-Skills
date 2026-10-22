#!/usr/bin/env node
// Runs the api and db test cases of the approved plan against a running target, then records each
// run, and a defect for each confirmed failure, in the ledger. It refuses to run unless the run is
// allowed and the approval matches the current plan.
//
// node scripts/run-api.mjs <ledger.json> <config.json> --root <repo> [--base <url>]

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readLedger, recordDefect, recordRun, writeLedger } from './ledger.mjs';
import { planDigest } from './plan.mjs';
import { validateRun } from './safety.mjs';
import { queryDatabase, resetDatabase, validateTarget } from './env.mjs';
import { Blocked, Infrastructure, runSuite } from './checks.mjs';

// The context the checks run in. Sessions are signed in once per role, from the environment
// variables the plan names. Requests are retried once when the network fails, and a second failure is
// infrastructure: the test is blocked, not failed.
export function createContext({ ledger, config, root, base, env, fetchImpl = fetch }) {
  const probesAllowed = validateRun(config).securityProbes.allowed;
  const sessions = new Map();

  async function send(method, path, { headers, body }) {
    const res = await fetchImpl(new URL(path, base), { method, headers, body });
    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = null;
    }
    return { status: res.status, body: json };
  }

  async function request(method, path, options) {
    try {
      return await send(method, path, options);
    } catch {
      try {
        return await send(method, path, options);
      } catch (error) {
        throw new Infrastructure(`${method} ${path} failed twice: ${error.message}`);
      }
    }
  }

  async function sessionFor(roleId) {
    if (sessions.has(roleId)) return sessions.get(roleId);
    const role = (ledger.roles || []).find((r) => r.id === roleId);
    if (!role || !role.account) throw new Blocked(`role ${roleId} has no account in the plan`);
    const username = env[role.account.usernameEnv];
    const password = env[role.account.passwordEnv];
    if (!username || !password) {
      throw new Blocked(`set ${role.account.usernameEnv} and ${role.account.passwordEnv} to sign in as ${roleId}`);
    }
    const res = await request('POST', '/api/login', {
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (res.status !== 200 || !res.body?.token) throw new Blocked(`could not sign in as ${roleId}: status ${res.status}`);
    sessions.set(roleId, res.body.token);
    return res.body.token;
  }

  async function query(sql) {
    if (!config.db) throw new Blocked('no database is declared, so db checks cannot run');
    try {
      return queryDatabase({ config, root, sql });
    } catch (error) {
      throw new Blocked(`the query did not run: ${error.message}`);
    }
  }

  return { request, sessionFor, query, probesAllowed, env };
}

export async function runApi({ ledgerPath, configPath, root, base, env, now }) {
  const ledger = readLedger(ledgerPath);
  if (!ledger.intake || !ledger.intake.safety.allowed) throw new Error('the run is not allowed; run intake first');
  if (!ledger.approval) throw new Error('the test plan is not approved');
  if (ledger.approval.planHash !== planDigest(ledger)) throw new Error('the plan changed after approval; freeze and approve it again');

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.db) {
    const target = validateTarget({ config, root });
    if (!target.ok) throw new Error(`database refused: ${target.reasons.join('; ')}`);
  }
  const baseUrl = base ?? config.targets?.web?.baseUrl ?? config.targets?.['mobile-web']?.baseUrl;
  if (!baseUrl) throw new Error('no base URL: pass --base, or declare targets.web.baseUrl');

  const ctx = createContext({ ledger, config, root, base: baseUrl, env });
  const testCases = ledger.testCases.filter((tc) => ['api', 'db'].includes(tc.layer) && tc.automation === 'implemented');
  const reset =
    config.db && config.allowReset === true
      ? async () => {
          resetDatabase({ config, root, now: new Date().toISOString() });
        }
      : null;

  const results = await runSuite({ testCases, ledger, ctx, reset });
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
    console.error('usage: run-api.mjs <ledger.json> <config.json> --root <repo> [--base <url>]');
    process.exit(1);
  }
  runApi({
    ledgerPath: resolve(ledgerPath),
    configPath: resolve(configPath),
    root: resolve(flags.root ?? '.'),
    base: flags.base,
    env: process.env,
    now: new Date().toISOString(),
  })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
