// Remediation end to end, against the planted-app server: a defect is found, triaged, handed off and
// claimed; the fix arrives as a new build (a server without the planted defect, and a new tree hash);
// the retest and the regression run close it. Also: a regression first seen on the fixed build keeps
// the defect open, planted defect 11 is classified flaky, and the perf runner's limits and thresholds.
// The regression set includes browser test cases; they run in Chromium when it is available here.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { clone, fixtureLedger, NOW, seededDatabase } from './helpers.mjs';
import { createFixtureServer } from '../fixtures/planted-app/server.mjs';
import { approvePlan, freezePlan, loadPlan } from '../scripts/plan.mjs';
import { readLedger, status, writeLedger } from '../scripts/ledger.mjs';
import { claimFix, handOff, triageDefect } from '../scripts/remediation.mjs';
import { loadPlaywright } from '../scripts/browser.mjs';
import { runApi } from '../scripts/run-api.mjs';
import { runPerf } from '../scripts/run-perf.mjs';
import { retest } from '../scripts/retest.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const LEDGER_CLI = join(HERE, '../scripts/ledger.mjs');
const FLAKY_CASES = join(HERE, '../fixtures/planted-app/flaky-cases.json');

const ACCOUNTS = {
  E2E_ADMIN_USERNAME: 'admin',
  E2E_ADMIN_PASSWORD: 'admin-pass',
  E2E_MANAGER_USERNAME: 'manager',
  E2E_MANAGER_PASSWORD: 'manager-pass',
  E2E_STAFF_USERNAME: 'staff',
  E2E_STAFF_PASSWORD: 'staff-pass',
  E2E_OUTSIDER_USERNAME: 'outsider',
  E2E_OUTSIDER_PASSWORD: 'outsider-pass',
};

const PLAYWRIGHT = [process.env.E2E_PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/playwright'].filter(Boolean).find((p) => existsSync(p)) ?? null;
async function browserWorks() {
  if (!PLAYWRIGHT) return false;
  try {
    const browser = await loadPlaywright({ found: true, path: PLAYWRIGHT }).chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
}
const BROWSER = await browserWorks();

// A server on a fixed port, so the config stays the same when the "fixed build" replaces it.
async function environment(planted, { allowReset = true, mutatePlan = null, configExtra = {} } = {}) {
  const db = seededDatabase({ allowReset });
  let server = null;
  let port = 0;
  async function start(flags) {
    if (server) await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    ({ server } = createFixtureServer({ planted: new Set(flags), dbFile: db.file }));
    await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
    port = server.address().port;
  }
  await start(planted);
  const base = `http://127.0.0.1:${port}`;
  const dir = mkdtempSync(join(tmpdir(), 'e2e-remediate-'));
  const ledgerPath = join(dir, 'ledger.json');
  const configPath = join(dir, 'qa.config.json');
  const config = { ...clone(db.config), ...configExtra };
  config.allowlist.hosts = ['127.0.0.1'];
  config.targets = { web: { baseUrl: base }, 'mobile-web': { baseUrl: base } };
  config.viewports = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 }, narrow: { width: 320, height: 640 } };
  if (PLAYWRIGHT) config.browser = { playwrightModule: PLAYWRIGHT };
  writeFileSync(configPath, JSON.stringify(config));
  const ledger = fixtureLedger({ web: { status: 'ready' }, 'mobile-web': { status: 'ready' } });
  if (mutatePlan) mutatePlan(ledger);
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  writeLedger(ledgerPath, ledger);
  const args = { ledgerPath, configPath, root: db.root, env: ACCOUNTS, now: NOW };
  return {
    base,
    args,
    ledgerPath,
    // The fix arrives as a new build: the server restarts without the defect, and the tree changes.
    async deploy(flags, tree) {
      await start(flags);
      const current = readLedger(ledgerPath);
      current.intake.build.treeHash = tree;
      writeLedger(ledgerPath, current);
    },
    edit(change) {
      const current = readLedger(ledgerPath);
      change(current);
      writeLedger(ledgerPath, current);
      return current;
    },
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
        db.cleanup();
        rmSync(dir, { recursive: true, force: true });
      }),
  };
}

describe('a fixed defect is retested, and closes only after the regression run', () => {
  let env;
  let first;
  before(async () => {
    env = await environment(['object-level-access']);
    first = await runApi(env.args);
  });
  after(() => env.close());

  test('the cross-tenant read (planted defect 4) opens one defect, on the build it was found on', () => {
    assert.deepEqual(first.opened, ['DEF-001']);
    const defect = readLedger(env.ledgerPath).defects[0];
    assert.deepEqual(defect.testCases, ['TC-ORD-03']);
    assert.equal(defect.build, 'def456');
  });

  test('triage, the handoff packet and the claim go through the ledger command', () => {
    const cli = (...a) => JSON.parse(execFileSync(process.execPath, [LEDGER_CLI, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }));
    cli('triage', env.ledgerPath, 'DEF-001', '--severity', 'High', '--owner', 'backend-engineer', '--root-cause', 'GET /api/orders/:id does not check the tenant', '--by', 'triage');
    const handoff = cli('handoff', env.ledgerPath, 'DEF-001');
    assert.equal(handoff.handoff, 'HO-DEF-001-1');
    const packet = readFileSync(handoff.file, 'utf8');
    assert.match(packet, /REQ-ORD-003/);
    assert.doesNotMatch(packet, /outsider-pass|manager-pass/);
    cli('claim', env.ledgerPath, 'DEF-001', '--by', 'backend-engineer', '--note', 'tenant check added');
    assert.equal(readLedger(env.ledgerPath).defects[0].status, 'Fix Claimed');
  });

  test('the retest on the fixed build passes, and the defect waits for the regression run', async () => {
    await env.deploy([], 'fixed-tree');
    const result = await retest({ ...env.args, defect: 'DEF-001' });
    assert.deepEqual(result.ran, ['TC-ORD-03']);
    assert.equal(result.defect.status, 'Retest Passed');
    assert.equal(result.defect.regression.status, 'incomplete');
    assert.equal(status(readLedger(env.ledgerPath)).status, 'FAIL', 'the High defect is still open');
  });

  test('the regression run closes it when every regression test case passes', async () => {
    const result = await retest({ ...env.args, defect: 'DEF-001', regression: true });
    assert.ok(result.ran.includes('TC-UI-09') && result.ran.includes('TC-AUTH-01'));
    if (BROWSER) {
      assert.equal(result.defect.status, 'Closed', JSON.stringify(result.defect.regression));
      const ledger = readLedger(env.ledgerPath);
      assert.ok(!status(ledger).reasons.some((r) => r.includes('DEF-001')));
    } else {
      // Without a browser the web test cases are blocked, so the regression cannot complete.
      assert.equal(result.defect.status, 'Retest Passed');
      assert.equal(result.defect.regression.status, 'incomplete');
    }
  });

  test('a retest of a closed defect is refused', async () => {
    if (!BROWSER) return;
    await assert.rejects(retest({ ...env.args, defect: 'DEF-001' }), /DEF-001 is closed/);
  });
});

describe('a regression first seen on the fixed build', () => {
  let env;
  before(async () => {
    env = await environment(['object-level-access']);
    await runApi(env.args);
    env.edit((ledger) => {
      triageDefect(ledger, 'DEF-001', { severity: 'High', owner: 'backend-engineer', rootCause: 'no tenant check', by: 'triage', now: NOW });
      handOff(ledger, 'DEF-001', { now: NOW });
      claimFix(ledger, 'DEF-001', { by: 'backend-engineer', now: NOW });
    });
    // The fix removes defect 4 and introduces defect 7: the order total becomes a string.
    await env.deploy(['contract-total-string'], 'fixed-but-broken-tree');
  });
  after(() => env.close());

  test('keeps the defect open with the regression named, and opens a new defect for it', async () => {
    const skipBrowser = { web: async () => ({ skipped: 'not needed: the api regression decides this case' }) };
    const result = await retest({ ...env.args, defect: 'DEF-001', regression: true, runners: skipBrowser });
    assert.equal(result.defect.status, 'Retest Passed');
    assert.equal(result.defect.regression.status, 'failed');
    assert.deepEqual(result.defect.regression.failing, ['TC-ORD-02']);
    const ledger = readLedger(env.ledgerPath);
    const added = ledger.defects.find((d) => d.testCases.includes('TC-ORD-02'));
    assert.equal(added.build, 'fixed-but-broken-tree');
  });
});

describe('planted defect 11: a test that shares mutable data is flaky, not passed', () => {
  let env;
  before(async () => {
    // No reset, so data one test changes stays changed for the next run, as in a shared environment.
    env = await environment([], {
      allowReset: false,
      mutatePlan: (ledger) => loadPlan(ledger, JSON.parse(readFileSync(FLAKY_CASES, 'utf8'))),
    });
  });
  after(() => env.close());

  test('TC-FLAKY-02 passes, then fails after TC-FLAKY-01 changes o-1, on the same build', async () => {
    const one = await runApi({ ...env.args, only: ['TC-FLAKY-02'] });
    assert.deepEqual(one.results, { passed: 1 }, JSON.stringify(one));
    await runApi({ ...env.args, only: ['TC-FLAKY-01'] });
    const two = await runApi({ ...env.args, only: ['TC-FLAKY-02'] });
    assert.deepEqual(two.flaky, ['TC-FLAKY-02']);
    assert.deepEqual(two.opened, [], 'no defect in the app is opened for a flaky test');
    const result = status(readLedger(env.ledgerPath));
    assert.ok(result.reasons.includes('TC-FLAKY-02 flaky') || result.reasons.some((r) => r.includes('TC-FLAKY-02 flaky')));
  });
});

describe('the perf runner', () => {
  const LIMITS = { maxVirtualUsers: 4, maxDurationSeconds: 2, maxRequestsPerSecond: 40 };
  // A perf test case on the P2 journey, with a threshold the team has not set yet (derived).
  const perfPlan = ({ p95Ms, confirmed }) => (ledger) => {
    ledger.requirements.push({
      id: 'REQ-PERF-001',
      text: `Listing the orders has a p95 under ${p95Ms} ms at 4 users and 20 requests per second.`,
      oracle: 'doc',
      source: 'PROPOSED threshold, from the team norms',
      derived: true,
      confirmed,
    });
    ledger.testCases.push({
      id: 'TC-PERF-01',
      title: 'The order list stays fast under a small load',
      layer: 'perf',
      mutates: false,
      oracle: 'doc',
      requirements: ['REQ-PERF-001'],
      journeys: ['J-06'],
      roles: ['manager'],
      operations: ['OP-LIST'],
      expected: [`p95 under ${p95Ms} ms, and no errors`],
      automation: 'implemented',
      checks: [
        { kind: 'load', as: 'manager', request: { method: 'GET', path: '/api/orders' }, virtualUsers: 4, durationSeconds: 0.5, requestsPerSecond: 20, thresholds: { p95Ms, maxErrorRate: 0 } },
      ],
    });
  };

  test('refuses to start without the limits in config, or without the flag for this run', async () => {
    const env = await environment([], { mutatePlan: perfPlan({ p95Ms: 1000, confirmed: true }) });
    try {
      await assert.rejects(runPerf({ ...env.args, env: { ...ACCOUNTS, E2E_ALLOW_LOAD: '1' } }), /config.loadLimits must set/);
    } finally {
      await env.close();
    }
    const flagged = await environment([], { mutatePlan: perfPlan({ p95Ms: 1000, confirmed: true }), configExtra: { loadLimits: LIMITS } });
    try {
      await assert.rejects(runPerf(flagged.args), /set E2E_ALLOW_LOAD=1/);
      assert.equal(readLedger(flagged.ledgerPath).runs.length, 0);
    } finally {
      await flagged.close();
    }
  });

  test('within the thresholds the perf test passes, and the measurements are recorded', async () => {
    const env = await environment([], { mutatePlan: perfPlan({ p95Ms: 1000, confirmed: true }), configExtra: { loadLimits: LIMITS } });
    try {
      const summary = await runPerf({ ...env.args, env: { ...ACCOUNTS, E2E_ALLOW_LOAD: '1' } });
      assert.deepEqual(summary.results, { passed: 1 });
      const measured = summary.measured[0].evidence[0];
      assert.ok(measured.requests > 0 && measured.requests <= 10, `sent ${measured.requests}`);
      assert.equal(measured.errors, 0);
    } finally {
      await env.close();
    }
  });

  test('a breach of a proposed threshold needs confirmation; a breach of a confirmed one is a defect', async () => {
    const proposed = await environment([], { mutatePlan: perfPlan({ p95Ms: 0.001, confirmed: false }), configExtra: { loadLimits: LIMITS } });
    try {
      const summary = await runPerf({ ...proposed.args, env: { ...ACCOUNTS, E2E_ALLOW_LOAD: '1' } });
      assert.deepEqual(summary.results, { 'needs-confirmation': 1 });
      assert.equal(summary.defects, 0);
    } finally {
      await proposed.close();
    }
    const confirmed = await environment([], { mutatePlan: perfPlan({ p95Ms: 0.001, confirmed: true }), configExtra: { loadLimits: LIMITS } });
    try {
      const summary = await runPerf({ ...confirmed.args, env: { ...ACCOUNTS, E2E_ALLOW_LOAD: '1' } });
      assert.deepEqual(summary.results, { failed: 1 });
      assert.match(summary.failed[0].failures[0].message, /p95 was .* ms, over the threshold of 0.001 ms/);
      assert.deepEqual(summary.opened, ['DEF-001']);
    } finally {
      await confirmed.close();
    }
  });
});
