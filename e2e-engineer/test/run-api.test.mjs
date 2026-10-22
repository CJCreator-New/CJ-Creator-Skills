// The whole API path, against the planted-app server and a seeded database. The clean control must
// pass every implemented api and db test case. The planted defects must fail the test cases tied to
// them, and only those.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clone, fixtureLedger, NOW, seededDatabase } from './helpers.mjs';
import { createFixtureServer, FLAGS } from '../fixtures/planted-app/server.mjs';
import { freezePlan, approvePlan } from '../scripts/plan.mjs';
import { readLedger, status, writeLedger } from '../scripts/ledger.mjs';
import { runApi } from '../scripts/run-api.mjs';

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

// Starts the server with the given flags over a fresh seeded database, and returns what the test needs.
async function environment(planted, { allowReset = true } = {}) {
  const db = seededDatabase({ allowReset });
  const { server } = createFixtureServer({ planted: new Set(planted), dbFile: db.file });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'e2e-run-'));
  const ledgerPath = join(dir, 'ledger.json');
  const configPath = join(dir, 'qa.config.json');
  const config = clone(db.config);
  config.allowlist.hosts = ['127.0.0.1'];
  config.targets = { web: { baseUrl: base } };
  // The fixture's own authorization, so the plan's security probes run against this test server.
  config.authorization = { scope: 'planted-app test server', authorizedBy: 'e2e-engineer tests', date: '2026-10-22' };
  writeFileSync(configPath, JSON.stringify(config));
  const ledger = fixtureLedger();
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  writeLedger(ledgerPath, ledger);
  return {
    base,
    dir,
    ledgerPath,
    configPath,
    root: db.root,
    close: () =>
      new Promise((resolve) => {
        server.close(resolve);
        server.closeAllConnections();
        db.cleanup();
        rmSync(dir, { recursive: true, force: true });
      }),
  };
}

function runWith(env, extraEnv = {}) {
  return runApi({
    ledgerPath: env.ledgerPath,
    configPath: env.configPath,
    root: env.root,
    base: env.base,
    env: { ...ACCOUNTS, ...extraEnv },
    now: NOW,
  });
}

describe('the clean control', () => {
  let env;
  before(async () => {
    env = await environment(new Set());
  });
  after(() => env.close());

  test('every implemented api and db test case passes, and no defect is opened', async () => {
    const summary = await runWith(env);
    assert.equal(summary.ran, 12);
    assert.deepEqual(summary.results, { passed: 12 });
    assert.equal(summary.defects, 0);
  });

  test('the gate stays PARTIALLY TESTED, because the web and static tests are not run in this phase', () => {
    const ledger = readLedger(env.ledgerPath);
    assert.equal(status(ledger).status, 'PARTIALLY TESTED');
    assert.ok(status(ledger).reasons.some((r) => r.startsWith('P0 journey J-01 is not verified')));
  });
});

describe('the planted defects', () => {
  let env;
  let summary;
  before(async () => {
    env = await environment(new Set(FLAGS));
    summary = await runWith(env);
  });
  after(() => env.close());

  test('fail the test cases for defects 2, 3, 4, 5, 6 and 7, and only those', () => {
    const failed = summary.failed.map((f) => f.id).sort();
    assert.deepEqual(failed, ['TC-APR-02', 'TC-APR-03', 'TC-APR-04', 'TC-ORD-01', 'TC-ORD-02', 'TC-ORD-03']);
  });

  test('the cheap tests still pass against the planted build, because those behaviours are correct there', () => {
    const ledger = readLedger(env.ledgerPath);
    const passed = ledger.runs.filter((r) => r.result === 'passed').map((r) => r.testCase).sort();
    assert.deepEqual(passed, ['TC-APR-01', 'TC-AUTH-01', 'TC-AUTH-02', 'TC-DB-01', 'TC-SEC-02', 'TC-SEC-03']);
  });

  test('each failing test case opens one defect, with its first failure as the evidence', () => {
    const ledger = readLedger(env.ledgerPath);
    assert.equal(ledger.defects.length, 6);
    const atomicity = ledger.defects.find((d) => d.testCases.includes('TC-APR-03'));
    assert.equal(atomicity.status, 'Confirmed');
    assert.equal(atomicity.severity, 'unassigned');
    assert.match(atomicity.evidence[0].message, /statuses were 200, 200, expected 200, 409/);
  });

  test('the gate is FAIL, and names the failing test cases', () => {
    const result = status(readLedger(env.ledgerPath));
    assert.equal(result.status, 'FAIL');
    assert.ok(result.reasons.includes('TC-APR-04 failed'));
  });

  test('a second run on the same build does not open a second defect for the same test case', async () => {
    const again = await runWith(env);
    assert.equal(again.defects, 6);
  });
});

describe('the refusals', () => {
  test('a plan changed after approval is refused, and nothing runs', async () => {
    const env = await environment(new Set());
    try {
      const ledger = readLedger(env.ledgerPath);
      ledger.testCases[0].title = 'changed after approval';
      writeLedger(env.ledgerPath, ledger);
      await assert.rejects(runWith(env), /the plan changed after approval/);
      assert.equal(readLedger(env.ledgerPath).runs.length, 0);
    } finally {
      await env.close();
    }
  });

  test('a plan that was never approved is refused', async () => {
    const env = await environment(new Set());
    try {
      const ledger = readLedger(env.ledgerPath);
      ledger.approval = null;
      writeLedger(env.ledgerPath, ledger);
      await assert.rejects(runWith(env), /the test plan is not approved/);
    } finally {
      await env.close();
    }
  });

  test('a missing credential blocks the checks that need it, and says which variable is missing', async () => {
    const env = await environment(new Set());
    try {
      const summary = await runApi({
        ledgerPath: env.ledgerPath,
        configPath: env.configPath,
        root: env.root,
        base: env.base,
        env: { ...ACCOUNTS, E2E_MANAGER_PASSWORD: '' },
        now: NOW,
      });
      const auth = summary.blocked.find((b) => b.id === 'TC-AUTH-01');
      assert.ok(auth, 'TC-AUTH-01 is blocked');
      assert.match(auth.reasons.join(' '), /environment variable E2E_MANAGER_PASSWORD is not set/);
      assert.equal(summary.failed.length, 0, 'a missing credential is not a failure');
    } finally {
      await env.close();
    }
  });

  test('without allowReset, mutating test cases are blocked rather than run on a dirty database', async () => {
    const env = await environment(new Set(), { allowReset: false });
    try {
      const summary = await runWith(env);
      const mutating = summary.blocked.find((b) => b.id === 'TC-APR-01');
      assert.ok(mutating, 'TC-APR-01 mutates, so it is blocked');
      assert.match(mutating.reasons.join(' '), /reset is not allowed/);
    } finally {
      await env.close();
    }
  });
});
