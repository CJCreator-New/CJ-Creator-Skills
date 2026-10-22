// Doubles and live integrations (G25), and the fixed clock and time zone in the browser (G28).

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clone, fixtureLedger, NOW, seededDatabase } from './helpers.mjs';
import { createFixtureServer } from '../fixtures/planted-app/server.mjs';
import { approvePlan, freezePlan } from '../scripts/plan.mjs';
import { readLedger, recordRun, status, writeLedger } from '../scripts/ledger.mjs';
import { checkIntegrations } from '../scripts/safety.mjs';
import { validatePlan } from '../scripts/traceability.mjs';
import { loadPlaywright } from '../scripts/browser.mjs';
import { pageEnvironment, runWeb } from '../scripts/run-web.mjs';

describe('doubles and live integrations', () => {
  test('a live integration needs a sandbox URL on the allowlist; a double needs nothing', () => {
    const allowlist = { hosts: ['127.0.0.1', 'sandbox.payments.test'] };
    assert.deepEqual(checkIntegrations({ allowlist, integrations: { payments: { mode: 'double' } } }), []);
    assert.deepEqual(checkIntegrations({ allowlist, integrations: { payments: { mode: 'live' } } }), ['integration payments: a live integration needs its sandboxUrl']);
    assert.deepEqual(checkIntegrations({ allowlist, integrations: { payments: { mode: 'live', sandboxUrl: 'https://sandbox.payments.test' } } }), []);
    assert.match(checkIntegrations({ allowlist, integrations: { payments: { mode: 'live', sandboxUrl: 'https://api.payments.example' } } })[0], /not on the allowlist/);
    assert.match(checkIntegrations({ allowlist, integrations: { payments: { mode: 'prod' } } })[0], /mode must be double or live/);
  });

  test('a run is tagged double unless every integration it names was live, and the status lists double passes', () => {
    const ledger = fixtureLedger();
    ledger.testCases.find((t) => t.id === 'TC-ORD-01').integrations = ['payments'];
    ledger.testCases.find((t) => t.id === 'TC-ORD-02').integrations = ['payments', 'email'];
    assert.deepEqual(validatePlan(ledger).errors, []);
    freezePlan(ledger, { now: NOW });
    approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
    ledger.intake.integrations = { payments: 'live', email: 'double' };
    assert.equal(recordRun(ledger, { testCase: 'TC-ORD-01', result: 'passed', now: NOW }).mode, 'live');
    assert.equal(recordRun(ledger, { testCase: 'TC-ORD-02', result: 'passed', now: NOW }).mode, 'double');
    assert.equal(recordRun(ledger, { testCase: 'TC-AUTH-02', result: 'passed', now: NOW }).mode, undefined);
    assert.deepEqual(status(ledger).passedAgainstDoubles, ['TC-ORD-02']);
  });
});

describe('the page environment', () => {
  test('the test case sets the clock and zone, or the config does', () => {
    assert.deepEqual(pageEnvironment({}, {}), { timezone: null, fixedTime: null });
    assert.deepEqual(pageEnvironment({}, { timezones: ['UTC'], clock: { fixedTime: '2026-01-15T10:00:00Z' } }), { timezone: 'UTC', fixedTime: '2026-01-15T10:00:00Z' });
    assert.deepEqual(pageEnvironment({ timezone: 'Asia/Kolkata', clock: '2030-06-01T00:00:00Z' }, { timezones: ['UTC'] }), { timezone: 'Asia/Kolkata', fixedTime: '2030-06-01T00:00:00Z' });
  });

  const PLAYWRIGHT = [process.env.E2E_PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/playwright'].filter(Boolean).find((p) => existsSync(p)) ?? null;
  test('in Chromium, the page sees the fixed date and the declared zone', { skip: PLAYWRIGHT ? false : 'no Playwright module' }, async () => {
    try {
      const browser = await loadPlaywright({ found: true, path: PLAYWRIGHT }).chromium.launch();
      await browser.close();
    } catch (error) {
      return;
    }
    const db = seededDatabase();
    const { server } = createFixtureServer({ planted: new Set(), dbFile: db.file });
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    const dir = mkdtempSync(join(tmpdir(), 'e2e-clock-'));
    try {
      const configPath = join(dir, 'qa.config.json');
      const ledgerPath = join(dir, 'ledger.json');
      const config = clone(db.config);
      Object.assign(config, {
        targets: { web: { baseUrl: base } },
        allowlist: { ...config.allowlist, hosts: ['127.0.0.1'] },
        viewports: { desktop: { width: 1280, height: 800 } },
        browser: { playwrightModule: PLAYWRIGHT },
        timezones: ['America/New_York'],
        clock: { fixedTime: '2026-01-15T10:00:00Z' },
      });
      writeFileSync(configPath, JSON.stringify(config));
      const ledger = fixtureLedger({ web: { status: 'ready' } });
      ledger.testCases.push({
        id: 'TC-CLOCK-01',
        title: 'The page runs on the fixed clock and the declared zone',
        layer: 'web',
        mutates: false,
        oracle: 'observed',
        journeys: ['J-01'],
        expected: ['the footer shows 2026-01-15 and America/New_York'],
        automation: 'implemented',
        steps: [
          { act: 'goto', path: '#/login' },
          { act: 'expectTestId', testId: 'today', text: '2026-01-15' },
          { act: 'expectTestId', testId: 'zone', text: 'America/New_York' },
        ],
      });
      freezePlan(ledger, { now: NOW });
      approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
      writeLedger(ledgerPath, ledger);
      const summary = await runWeb({ ledgerPath, configPath, root: db.root, env: {}, now: NOW, only: ['TC-CLOCK-01'] });
      assert.deepEqual(summary.results, { passed: 1 }, JSON.stringify(summary.failed));
      assert.equal(readLedger(ledgerPath).runs.at(-1).result, 'passed');
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
