// The browser run, against the planted-app server and a seeded database, in real Chromium. These tests
// are skipped, with the reason stated, on a machine where Chromium or Playwright is not available.
// They need neither a network nor an install: Playwright is loaded from E2E_PLAYWRIGHT_MODULE, or from
// the path in the sandbox.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { clone, fixtureLedger, NOW, seededDatabase } from './helpers.mjs';
import { createFixtureServer, FLAGS } from '../fixtures/planted-app/server.mjs';
import { approvePlan, freezePlan } from '../scripts/plan.mjs';
import { readLedger, writeLedger } from '../scripts/ledger.mjs';
import { loadPlaywright } from '../scripts/browser.mjs';
import { runWeb } from '../scripts/run-web.mjs';

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

const PLAYWRIGHT_CANDIDATES = [process.env.E2E_PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/playwright'].filter(Boolean);
const PLAYWRIGHT = PLAYWRIGHT_CANDIDATES.find((p) => existsSync(p)) ?? null;

// The reason the browser tests cannot run here, or null when they can.
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

// A seeded database, a server with the given flags, and an approved ledger for a run with web targets.
async function environment(planted, { playwrightModule = PLAYWRIGHT, configOverride = {} } = {}) {
  const db = seededDatabase();
  const { server } = createFixtureServer({ planted: new Set(planted), dbFile: db.file });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const dir = mkdtempSync(join(tmpdir(), 'e2e-web-'));
  const ledgerPath = join(dir, 'ledger.json');
  const configPath = join(dir, 'qa.config.json');
  const config = clone(db.config);
  config.allowlist.hosts = ['127.0.0.1'];
  config.targets = { web: { baseUrl: base }, 'mobile-web': { baseUrl: base } };
  config.viewports = { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 }, narrow: { width: 320, height: 640 } };
  if (playwrightModule) config.browser = { playwrightModule };
  Object.assign(config, configOverride);
  writeFileSync(configPath, JSON.stringify(config));
  const ledger = fixtureLedger({ web: { status: 'ready' }, 'mobile-web': { status: 'ready' } });
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  writeLedger(ledgerPath, ledger);
  return {
    base,
    db,
    root: db.root,
    ledgerPath,
    configPath,
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
  return runWeb({
    ledgerPath: env.ledgerPath,
    configPath: env.configPath,
    root: env.root,
    env: { ...ACCOUNTS, ...extraEnv },
    now: NOW,
    bases: { web: env.base, mobile: env.base },
  });
}

// Every file under an evidence folder, with its text when it is text.
function evidenceFiles(root, evidence) {
  const dir = join(root, evidence);
  return readdirSync(dir).map((name) => ({ name, path: join(dir, name) }));
}

test('without Playwright in the repository, every web test is blocked with the reason, and no browser starts', async () => {
  const env = await environment(new Set(), { playwrightModule: null });
  try {
    const summary = await runWith(env);
    assert.deepEqual(summary.results, { blocked: 8 });
    assert.ok(summary.blocked.every((b) => b.reasons.some((r) => /Playwright is not in the repository dependencies/.test(r))));
  } finally {
    await env.close();
  }
});

describe('browser runs in Chromium', { skip: SKIP ?? false }, () => {
  describe('the clean control', () => {
    let env;
    let summary;
    before(async () => {
      env = await environment(new Set());
      summary = await runWith(env);
    });
    after(() => env.close());

    test('every implemented web and mobile-web test passes, and no defect is opened', () => {
      assert.deepEqual(summary.results, { passed: 8 });
      assert.equal(summary.defects, 0);
    });

    test('each test case stores a screenshot and a log under the run folder', () => {
      const files = evidenceFiles(env.root, summary.evidence).map((f) => f.name);
      assert.ok(files.includes('TC-UI-09-desktop.png'));
      assert.ok(files.includes('TC-UI-09-desktop.json'));
      assert.equal(files.filter((f) => f.endsWith('.png')).length, 8);
    });

    test('no password, bearer token, cookie or token value is stored anywhere in the evidence', () => {
      const secrets = ['manager-pass', 'staff-pass', 'admin-pass', 'outsider-pass', 'definitely-wrong'];
      for (const file of evidenceFiles(env.root, summary.evidence)) {
        if (!file.name.endsWith('.json')) continue;
        const text = readFileSync(file.path, 'utf8');
        for (const secret of secrets) assert.ok(!text.includes(secret), `${secret} leaked into ${file.name}`);
        assert.doesNotMatch(text, /Bearer [A-Za-z0-9]/, `a bearer token leaked into ${file.name}`);
        assert.doesNotMatch(text, /set-cookie|eyJ[A-Za-z0-9_-]{4,}\./i, `a cookie or token leaked into ${file.name}`);
      }
    });

    test('the login request is recorded, with its password redacted and its username kept', () => {
      const log = JSON.parse(readFileSync(join(env.root, summary.evidence, 'TC-UI-06-desktop.json'), 'utf8'));
      const login = log.requests.find((r) => r.url.endsWith('/api/login'));
      assert.ok(login, 'the login request is in the log');
      assert.equal(login.body.password, '[redacted]');
      assert.equal(login.body.username, 'manager');
    });
  });

  describe('the planted defects', () => {
    let env;
    let summary;
    let ledger;
    before(async () => {
      env = await environment(new Set(FLAGS));
      summary = await runWith(env);
      ledger = readLedger(env.ledgerPath);
    });
    after(() => env.close());

    test('defect 1: the Export button starts no download, so TC-UI-01 fails', () => {
      const failure = summary.failed.find((f) => f.id === 'TC-UI-01');
      assert.ok(failure, 'TC-UI-01 failed');
      assert.match(failure.failures[0].message, /no download started from button "Export"/);
    });

    test('defect 8: a failed approval is shown as a success, so TC-UI-02 fails', () => {
      const failure = summary.failed.find((f) => f.id === 'TC-UI-02');
      assert.ok(failure, 'TC-UI-02 failed');
      assert.match(failure.failures[0].message, /the text "Could not approve" did not appear/);
    });

    test('defect 10: the Total field has no label, so TC-UI-03 fails', () => {
      const failure = summary.failed.find((f) => f.id === 'TC-UI-03');
      assert.ok(failure, 'TC-UI-03 failed');
      assert.match(failure.failures[0].message, /a form field has no label: total/);
    });

    test('defect 9: the order table is clipped at 320 pixels, so TC-UI-05 fails', () => {
      const failure = summary.failed.find((f) => f.id === 'TC-UI-05');
      assert.ok(failure, 'TC-UI-05 failed');
      assert.match(failure.failures[0].message, /clipped by a container that hides overflow/);
    });

    test('defect 12, the small approve button, fails the confirmed 24-pixel minimum and opens a defect', () => {
      const run = ledger.runs.find((r) => r.testCase === 'TC-UI-04');
      assert.equal(run.result, 'failed');
      assert.match(run.failures[0].message, /24/);
      assert.ok(ledger.defects.some((d) => d.testCases.includes('TC-UI-04')));
    });

    test('the defects the passing tests show are not opened, and the cheap paths still pass', () => {
      const passed = ledger.runs.filter((r) => r.result === 'passed').map((r) => r.testCase).sort();
      assert.deepEqual(passed, ['TC-UI-06', 'TC-UI-09']);
    });

    test('the failing web tests open one defect each, and TC-UI-08 is reported with its own step', () => {
      const ids = ledger.defects.flatMap((d) => d.testCases).sort();
      assert.deepEqual(ids, ['TC-UI-01', 'TC-UI-02', 'TC-UI-03', 'TC-UI-04', 'TC-UI-05', 'TC-UI-08']);
      const create = summary.failed.find((f) => f.id === 'TC-UI-08');
      assert.match(create.failures[0].check, /step 3 \(fill\)/);
    });
  });

  describe('a run without a credential', () => {
    let env;
    before(async () => {
      env = await environment(new Set());
    });
    after(() => env.close());

    test('blocks the test that needs it, with the variable that is missing, and fails nothing', async () => {
      const summary = await runWith(env, { E2E_MANAGER_PASSWORD: '' });
      const blocked = summary.blocked.find((b) => b.id === 'TC-UI-09');
      assert.ok(blocked, 'TC-UI-09 is blocked');
      assert.match(blocked.reasons.join(' '), /set E2E_MANAGER_USERNAME and E2E_MANAGER_PASSWORD to sign in as manager/);
      assert.equal(summary.failed.length, 0);
    });
  });
});
