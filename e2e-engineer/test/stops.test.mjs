// Stop conditions and evidence retention.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clone, fixtureLedger, NOW, seededDatabase } from './helpers.mjs';
import { createFixtureServer } from '../fixtures/planted-app/server.mjs';
import { approvePlan, freezePlan } from '../scripts/plan.mjs';
import { readLedger, recordRun, status, writeLedger } from '../scripts/ledger.mjs';
import { createStopper } from '../scripts/stops.mjs';
import { pruneEvidence, protectedFolders } from '../scripts/evidence.mjs';
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

const result = (id, r, extra = {}) => ({ id, result: r, failures: [], reasons: [], evidence: [], ...extra });
const infra = (id) => result(id, 'blocked', { reasons: ['check 1 (http): infrastructure: GET /api/orders failed twice'] });
const readOnly = { id: 'TC-R', mutates: false };
const mutating = { id: 'TC-M', mutates: true };

describe('the stopper', () => {
  test('waits for a sample of three, then stops only when over 30% failed on infrastructure', () => {
    const early = createStopper({ ledger: fixtureLedger(), runner: 'api' });
    early.note(infra('A'));
    assert.equal(early.check(readOnly), null, 'one of one is not a sample yet');
    const stopper = createStopper({ ledger: fixtureLedger(), runner: 'api' });
    for (const r of [result('B', 'passed'), result('C', 'passed'), result('D', 'passed'), infra('A')]) stopper.note(r);
    assert.equal(stopper.check(readOnly), null, 'one of four is 25%, under the limit');
    const strict = createStopper({ ledger: fixtureLedger(), runner: 'api' });
    for (const r of [infra('A'), result('B', 'passed'), result('C', 'passed')]) strict.note(r);
    assert.match(strict.check(readOnly), /1 of 3 test cases/, 'one of three is 33%, over the limit');
  });

  test('two of three on infrastructure stops every remaining test case, and the stop names them', () => {
    const stopper = createStopper({ ledger: fixtureLedger(), runner: 'web' });
    stopper.note(infra('A'));
    stopper.note(infra('B'));
    stopper.note(result('C', 'passed'));
    const why = stopper.check(readOnly);
    assert.match(why, /2 of 3 test cases in the web lane failed on infrastructure, over the limit of 30%/);
    assert.deepEqual(stopper.stoppedResult(readOnly, why).reasons, [`stopped: ${why}`]);
    assert.deepEqual(stopper.stops(), [{ runner: 'web', reason: why, tests: ['TC-R'] }]);
  });

  test('a failed security probe stops the mutating test cases only', () => {
    const stopper = createStopper({ ledger: fixtureLedger(), runner: 'api' });
    stopper.note(result('TC-SEC-02', 'failed', { failures: [{ check: 'check 1 (probe:session-tamper)', message: 'status was 200' }] }));
    assert.match(stopper.check(mutating), /security probe TC-SEC-02 failed/);
    assert.equal(stopper.check(readOnly), null);
  });

  test('a device lost during a mutating journey stops everything after it', () => {
    const stopper = createStopper({ ledger: fixtureLedger(), runner: 'mobile' });
    stopper.note(result('TC-AND-01', 'blocked'), { testCase: { id: 'TC-AND-01', mutates: true }, deviceLost: true });
    assert.match(stopper.check(readOnly), /the device disconnected during the mutating journey TC-AND-01/);
  });

  test('the run budget: minutes since intake, recorded runs, and reported tokens', () => {
    const ledger = fixtureLedger();
    const late = createStopper({ config: { budget: { maxMinutes: 30 } }, ledger, runner: 'api', clock: () => Date.parse(NOW) + 31 * 60000 });
    assert.match(late.check(readOnly), /run budget of 30 minutes is spent/);
    recordRun(ledger, { testCase: 'TC-AUTH-02', result: 'passed', now: NOW });
    assert.match(createStopper({ config: { budget: { maxRuns: 1 } }, ledger, runner: 'api' }).check(readOnly), /1 recorded runs is spent/);
    const root = mkdtempSync(join(tmpdir(), 'e2e-budget-'));
    try {
      mkdirSync(join(root, '.claude/e2e-engineer'), { recursive: true });
      writeFileSync(join(root, '.claude/e2e-engineer/telemetry.jsonl'), `${JSON.stringify({ ts: NOW, type: 'tokens', agent: 'web-runner', input: 900, output: 200 })}\n`);
      assert.match(createStopper({ config: { budget: { maxTokens: 1000 } }, ledger, root, runner: 'api' }).check(readOnly), /token budget of 1000 is spent \(1100 reported\)/);
      assert.equal(createStopper({ config: { budget: { maxTokens: 5000 } }, ledger, root, runner: 'api' }).check(readOnly), null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('a failed health check before a run', () => {
  test('blocks every test case, holds the gate at BLOCKED, and clears when they run again', async () => {
    const db = seededDatabase();
    const { server } = createFixtureServer({ planted: new Set(), dbFile: db.file });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = mkdtempSync(join(tmpdir(), 'e2e-health-'));
    try {
      const ledgerPath = join(dir, 'ledger.json');
      const configPath = join(dir, 'qa.config.json');
      const config = clone(db.config);
      config.allowlist.hosts = ['127.0.0.1'];
      config.targets = { web: { baseUrl: base } };
      config.healthUrl = `${base}/health`;
      writeFileSync(configPath, JSON.stringify(config));
      const ledger = fixtureLedger({ web: { status: 'ready' } });
      freezePlan(ledger, { now: NOW });
      approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
      writeLedger(ledgerPath, ledger);
      const args = { ledgerPath, configPath, root: db.root, base, env: ACCOUNTS, now: NOW };
      const down = async () => ({ healthy: false, reason: `${base}/health failed its health check twice: connection refused` });
      const summary = await runApi({ ...args, health: down });
      assert.deepEqual(summary.results, { blocked: 12 });
      assert.match(summary.blocked[0].reasons[0], /^stopped: the environment failed its health check twice/);
      const gate = status(readLedger(ledgerPath));
      assert.equal(gate.status, 'BLOCKED');
      assert.match(gate.reasons[0], /^stopped \(api\): the environment failed its health check twice/);
      await runApi(args);
      assert.ok(!status(readLedger(ledgerPath)).reasons.some((r) => r.startsWith('stopped')), 'a rerun clears the stop');
    } finally {
      await new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      });
      db.cleanup();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('evidence retention', () => {
  test('removes the oldest folders over the cap, keeps current and open-defect evidence, and records each removal', () => {
    const root = mkdtempSync(join(tmpdir(), 'e2e-evidence-'));
    try {
      const evidence = join(root, '.claude/e2e-engineer/evidence');
      const names = ['2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05'];
      for (const name of names) {
        mkdirSync(join(evidence, name), { recursive: true });
        writeFileSync(join(evidence, name, 'shot.png'), 'x'.repeat(10));
      }
      const ledger = fixtureLedger();
      // The oldest folder holds the current evidence of a test case, so it stays.
      recordRun(ledger, { testCase: 'TC-UI-01', result: 'passed', evidence: ['.claude/e2e-engineer/evidence/2026-10-01/shot.png'], now: NOW });
      assert.deepEqual([...protectedFolders(ledger)], ['2026-10-01']);
      const removed = pruneEvidence({ root, ledger, config: { evidence: { keepRuns: 2 } }, now: NOW });
      assert.deepEqual(removed.map((r) => r.folder), ['2026-10-02', '2026-10-03', '2026-10-04']);
      assert.deepEqual(readdirSync(evidence).sort(), ['2026-10-01', '2026-10-05']);
      assert.equal(ledger.evidencePruned.length, 3);
      assert.match(ledger.evidencePruned[0].reason, /over 2 run folders/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
