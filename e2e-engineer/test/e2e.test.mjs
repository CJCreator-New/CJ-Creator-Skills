// The cross-layer runner, in real Chromium against the planted-app server. An e2e test case acts in the
// UI, then checks the API and the stored data in the same test case. Skipped, with the reason, where
// Chromium or Playwright is not available.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clone, fixtureLedger, NOW, seededDatabase } from './helpers.mjs';
import { createFixtureServer } from '../fixtures/planted-app/server.mjs';
import { approvePlan, freezePlan } from '../scripts/plan.mjs';
import { readLedger, writeLedger } from '../scripts/ledger.mjs';
import { loadPlaywright } from '../scripts/browser.mjs';
import { runE2e } from '../scripts/run-e2e.mjs';

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
async function skipReason() {
  if (!PLAYWRIGHT) return 'no Playwright module was found; set E2E_PLAYWRIGHT_MODULE';
  try {
    const browser = await loadPlaywright({ found: true, path: PLAYWRIGHT }).chromium.launch();
    await browser.close();
    return null;
  } catch (error) {
    return `Chromium did not start: ${error.message.split('\n')[0]}`;
  }
}
const SKIP = await skipReason();

async function run(planted) {
  const db = seededDatabase();
  const { server } = createFixtureServer({ planted: new Set(planted), dbFile: db.file });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'e2e-cross-'));
  const ledgerPath = join(dir, 'ledger.json');
  const configPath = join(dir, 'qa.config.json');
  const config = clone(db.config);
  config.allowlist.hosts = ['127.0.0.1'];
  config.targets = { web: { baseUrl: base } };
  config.viewports = { desktop: { width: 1280, height: 800 } };
  config.browser = { playwrightModule: PLAYWRIGHT };
  writeFileSync(configPath, JSON.stringify(config));
  const ledger = fixtureLedger({ web: { status: 'ready' } });
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  writeLedger(ledgerPath, ledger);
  try {
    const summary = await runE2e({ ledgerPath, configPath, root: db.root, env: ACCOUNTS, now: NOW });
    return { summary, ledger: readLedger(ledgerPath) };
  } finally {
    await new Promise((resolve) => {
      server.close(resolve);
      server.closeAllConnections();
    });
    db.cleanup();
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('the cross-layer runner', { skip: SKIP ?? false }, () => {
  test('on the clean control, both e2e test cases pass at every layer', async () => {
    const { summary } = await run([]);
    assert.equal(summary.ran, 2);
    assert.deepEqual(summary.results, { passed: 2 });
  });

  test('planted defect 5 is caught where the UI sends the approval, and the data step names the layer', async () => {
    const { summary } = await run(['approval-skips-director']);
    const failure = summary.failed.find((f) => f.id === 'TC-E2E-01');
    assert.match(failure.failures[0].check, /step 3 \(expectResponse\)/);
    assert.match(failure.failures[0].message, /the response to POST \/api\/orders\/o-2\/approve was 200, expected 403/);
    assert.ok(!summary.failed.some((f) => f.id === 'TC-E2E-02'));
  });

  test('defects off the approval path do not fail the e2e test cases', async () => {
    const { summary, ledger } = await run(['contract-total-string', 'object-level-access']);
    // Neither defect changes what these two test cases check, so they pass. The runner reports what
    // each layer did, not what other test cases cover.
    assert.deepEqual(summary.results, { passed: 2 });
    assert.equal(ledger.defects.length, 0);
  });
});
