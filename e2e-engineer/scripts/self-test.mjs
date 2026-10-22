#!/usr/bin/env node
// The plugin's self-test (G32, G33, M10). It runs the plugin end to end on its own fixture, through the
// same intake, plan, runners, ledger and report a real run uses, and scores the result:
//
//   - recall: each of the 13 planted defects is found by the test cases the manifest names;
//   - precision: the clean control has no finding, and no failure on the planted build is unexplained;
//   - planted defect 11: a test case that shares data is classified flaky, not passed;
//   - the report reproduces from the ledger.
//
// With --isolate it also switches each planted flag on alone, and checks that the flag fails the test
// cases the manifest names and no others. It says which suites ran: browser suites need Playwright and
// Chromium, and are reported as not run without them. The approval in each scenario ledger is the
// self-test's own, for the fixture plan; it approves nothing in a user's repository.
//
// node scripts/self-test.mjs [--playwright <module path>] [--isolate] [--out <dir>]

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer, FLAGS } from '../fixtures/planted-app/server.mjs';
import { runIntake } from './intake.mjs';
import { readLedger, status, writeLedger } from './ledger.mjs';
import { approvePlan, freezePlan, loadPlan } from './plan.mjs';
import { testState } from './results.mjs';
import { seedDatabase } from './env.mjs';
import { runApi } from './run-api.mjs';
import { runWeb } from './run-web.mjs';
import { runE2e } from './run-e2e.mjs';
import { runMobile } from './run-mobile.mjs';
import { verifyArtifacts, writeArtifacts } from './artifacts.mjs';
import { loadPlaywright } from './browser.mjs';

const PLUGIN = resolve(fileURLToPath(new URL('..', import.meta.url)));
const FIXTURE = join(PLUGIN, 'fixtures/planted-app');
const MANIFEST = JSON.parse(readFileSync(join(FIXTURE, 'manifest.json'), 'utf8'));

// The fixture's accounts. They are fake and exist only in the fixture's seed data.
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

const git = (cwd, ...args) => execFileSync('git', args, { cwd, stdio: 'ignore' });

// Whether a browser can start here, and why not.
export async function browserReadiness(playwrightModule) {
  if (!playwrightModule || !existsSync(playwrightModule)) return { available: false, reason: 'no Playwright module; pass --playwright or set E2E_PLAYWRIGHT_MODULE' };
  try {
    const browser = await loadPlaywright({ found: true, path: playwrightModule }).chromium.launch();
    await browser.close();
    return { available: true, reason: null };
  } catch (error) {
    return { available: false, reason: `Chromium did not start: ${error.message.split('\n')[0]}` };
  }
}

// One scenario: a fresh repository, config, intake, plan, approval, seeded database and server, then
// the runners. Returns the ledger and the runner summaries. The workspace is removed unless kept.
export async function scenario({ planted, android = 'clean-android-config', extraCases = null, allowReset = true, runners, playwrightModule, keep = null, now }) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-self-test-'));
  git(dir, 'init', '-q');
  writeFileSync(join(dir, '.gitignore'), '.claude/\norders.sqlite\n');
  git(dir, 'add', '-A');
  git(dir, '-c', 'user.email=self-test@example.invalid', '-c', 'user.name=self-test', 'commit', '-qm', 'self-test');
  let server = null;
  try {
    const config = {
      name: 'planted-app (self-test)',
      targets: { web: { baseUrl: 'http://127.0.0.1:0' }, 'mobile-web': { baseUrl: 'http://127.0.0.1:0' } },
      mobileProjects: { android: join(PLUGIN, 'fixtures', android) },
      allowlist: { hosts: ['127.0.0.1'], dbNamePattern: '^(test|qa)_' },
      db: { engine: 'sqlite', name: 'test_orders', file: 'orders.sqlite', schema: join(FIXTURE, 'schema.sql'), seed: join(FIXTURE, 'seed.json') },
      allowReset,
      // The self-test authorizes probes against its own fixture server, which it started for this run.
      authorization: { scope: 'the planted-app fixture server started by this self-test', authorizedBy: 'e2e-engineer self-test', date: now.slice(0, 10) },
      viewports: { desktop: { width: 1280, height: 800 }, phone: { width: 390, height: 844 }, narrow: { width: 320, height: 640 } },
      ...(playwrightModule ? { browser: { playwrightModule } } : {}),
    };
    seedDatabase({ config, root: dir, now });
    ({ server } = createFixtureServer({ planted: new Set(planted), dbFile: join(dir, 'orders.sqlite') }));
    await new Promise((done) => server.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${server.address().port}`;
    config.targets = { web: { baseUrl: base }, 'mobile-web': { baseUrl: base } };
    config.healthUrl = `${base}/health`;
    const configPath = join(dir, 'qa.config.json');
    writeFileSync(configPath, JSON.stringify(config, null, 2));

    const { ledgerPath, intake } = runIntake({ root: dir, configPath, env: {}, now });
    if (!intake.safety.allowed) throw new Error(`self-test intake refused: ${intake.safety.problems.join('; ')}`);
    const ledger = readLedger(ledgerPath);
    loadPlan(ledger, JSON.parse(readFileSync(join(FIXTURE, 'plan.json'), 'utf8')));
    if (extraCases) loadPlan(ledger, JSON.parse(readFileSync(join(FIXTURE, extraCases), 'utf8')));
    freezePlan(ledger, { now });
    approvePlan(ledger, { approver: 'e2e-engineer self-test (fixture plan)', approvedAt: now.slice(0, 10) });
    writeLedger(ledgerPath, ledger);

    const args = { ledgerPath, configPath, root: dir, env: ACCOUNTS, now };
    const summaries = {};
    for (const step of runners) {
      const [name, only] = Array.isArray(step) ? step : [step, null];
      const run = { api: runApi, web: runWeb, e2e: runE2e, mobile: runMobile }[name];
      summaries[only ? `${name}:${only.join(',')}` : name] = await run({ ...args, ...(only ? { only } : {}) });
    }
    const result = { ledger: readLedger(ledgerPath), summaries, ledgerPath, dir };
    if (keep) keep(result);
    return result;
  } finally {
    if (server) {
      await new Promise((done) => {
        server.close(done);
        server.closeAllConnections();
      });
    }
    rmSync(dir, { recursive: true, force: true });
  }
}

const failing = (ledger) => ledger.testCases.filter((tc) => testState(ledger, tc.id).state === 'failed').map((tc) => tc.id).sort();
const blocked = (ledger) => ledger.testCases.filter((tc) => testState(ledger, tc.id).state === 'blocked').map((tc) => tc.id).sort();
const BROWSER_LAYERS = ['web', 'mobile-web', 'e2e'];

export async function runSelfTest({ playwrightModule = null, isolate = false, now = new Date().toISOString(), log = () => {} } = {}) {
  const browser = await browserReadiness(playwrightModule);
  const module = browser.available ? playwrightModule : null;
  const runners = ['api', 'web', 'e2e', 'mobile'];
  const plan = JSON.parse(readFileSync(join(FIXTURE, 'plan.json'), 'utf8'));
  const browserTests = new Set(plan.testCases.filter((tc) => BROWSER_LAYERS.includes(tc.layer)).map((tc) => tc.id));
  const ran = (id) => browser.available || !browserTests.has(id);

  log('clean control');
  const clean = await scenario({ planted: [], android: 'clean-android-config', runners, playwrightModule: module, now });

  log('planted build, with the report rendered and verified');
  let reproduces = null;
  const planted = await scenario({
    planted: FLAGS,
    android: 'planted-android-config',
    runners,
    playwrightModule: module,
    now,
    keep: ({ ledger, ledgerPath, dir }) => {
      const out = join(dir, 'report');
      mkdirSync(out, { recursive: true });
      writeArtifacts(ledger, out, { now, ledgerText: readFileSync(ledgerPath, 'utf8') });
      reproduces = verifyArtifacts(ledgerPath, out);
    },
  });

  log('planted defect 11: shared data, no reset');
  const flaky = await scenario({
    planted: [],
    extraCases: 'flaky-cases.json',
    allowReset: false,
    runners: [['api', ['TC-FLAKY-02']], ['api', ['TC-FLAKY-01']], ['api', ['TC-FLAKY-02']]],
    now,
  });
  const flakyState = testState(flaky.ledger, 'TC-FLAKY-02').state;

  const plantedFailing = failing(planted.ledger);
  const explained = new Set(MANIFEST.defects.flatMap((d) => d.detectedBy));
  const defects = MANIFEST.defects.map((d) => {
    const runnable = d.detectedBy.filter(ran);
    let found;
    let via;
    if (d.planted === 11) {
      found = flakyState === 'flaky';
      via = found ? ['TC-FLAKY-02 flaky'] : [];
    } else {
      via = d.detectedBy.filter((id) => plantedFailing.includes(id));
      found = via.length > 0 ? true : runnable.length === 0 ? 'not run' : false;
    }
    return { planted: d.planted, title: d.title, detectedBy: d.detectedBy, found, via };
  });

  let isolation = null;
  if (isolate) {
    isolation = [];
    for (const flag of FLAGS) {
      log(`isolation: ${flag}`);
      const entry = MANIFEST.defects.find((d) => d.flag === flag);
      const alone = await scenario({ planted: [flag], android: 'clean-android-config', runners: ['api', 'web', 'e2e'], playwrightModule: module, now });
      const fails = failing(alone.ledger);
      const expected = entry.detectedBy.filter(ran);
      isolation.push({
        planted: entry.planted,
        flag,
        failing: fails,
        found: expected.length === 0 ? 'not run' : fails.some((id) => entry.detectedBy.includes(id)),
        unexpected: fails.filter((id) => !entry.detectedBy.includes(id)),
      });
    }
    log('isolation: android manifest');
    const android = await scenario({ planted: [], android: 'planted-android-config', runners: ['mobile'], now });
    const fails = failing(android.ledger);
    isolation.push({ planted: 13, flag: null, failing: fails, found: fails.includes('TC-SEC-01'), unexpected: fails.filter((id) => id !== 'TC-SEC-01') });
  }

  const cleanFindings = [...failing(clean.ledger), ...clean.ledger.defects.map((d) => d.id)];
  const unexplained = plantedFailing.filter((id) => !explained.has(id));
  const found = defects.filter((d) => d.found === true).length;
  const notRun = defects.filter((d) => d.found === 'not run').map((d) => d.planted);
  const problems = [
    ...defects.filter((d) => d.found === false).map((d) => `planted defect ${d.planted} was not found`),
    ...cleanFindings.map((id) => `the clean control has a finding: ${id}`),
    ...unexplained.map((id) => `${id} failed on the planted build, and no planted defect explains it`),
    ...(reproduces && !reproduces.ok ? reproduces.problems.map((p) => `report: ${p}`) : []),
    ...(isolation || []).flatMap((i) => [
      ...(i.found === false ? [`isolation: planted defect ${i.planted} alone was not found`] : []),
      ...i.unexpected.map((id) => `isolation: planted defect ${i.planted} alone also failed ${id}`),
    ]),
  ];
  const verdict = problems.length > 0 ? 'fail' : notRun.length > 0 ? 'incomplete' : 'pass';
  return {
    verdict,
    problems,
    suites: {
      api: 'ran',
      static: 'ran',
      web: browser.available ? 'ran' : `not run: ${browser.reason}`,
      e2e: browser.available ? 'ran' : `not run: ${browser.reason}`,
      native: 'not run: out of scope for this release, and no device here',
    },
    recall: `${found} of ${MANIFEST.defects.length}`,
    notRun,
    defects,
    clean: {
      findings: cleanFindings,
      blocked: blocked(clean.ledger),
      gate: status(clean.ledger).status,
      results: Object.fromEntries(Object.entries(clean.summaries).map(([k, v]) => [k, v.results])),
    },
    planted: {
      failing: plantedFailing,
      unexplained,
      defectsOpened: planted.ledger.defects.length,
      gate: status(planted.ledger).status,
      results: Object.fromEntries(Object.entries(planted.summaries).map(([k, v]) => [k, v.results])),
    },
    flaky: { state: flakyState, defectsOpened: flaky.ledger.defects.length },
    report: reproduces,
    isolation,
  };
}

export function renderScorecard(card) {
  const lines = [
    '# e2e-engineer self-test',
    '',
    `Verdict: **${card.verdict}**. Recall: ${card.recall} planted defects.`,
    '',
    '## Suites',
    '',
    ...Object.entries(card.suites).map(([suite, state]) => `- ${suite}: ${state}`),
    '',
    '## Planted defects',
    '',
    '| # | Defect | Found | By |',
    '| --- | --- | --- | --- |',
    ...card.defects.map((d) => `| ${d.planted} | ${d.title} | ${d.found === true ? 'yes' : d.found === false ? '**no**' : d.found} | ${d.via.join(', ')} |`),
    '',
    '## Clean control',
    '',
    `Findings: ${card.clean.findings.length ? card.clean.findings.join(', ') : 'none'}. Gate: ${card.clean.gate}.`,
    '',
    '## Planted build',
    '',
    `${card.planted.defectsOpened} defects opened. Unexplained failures: ${card.planted.unexplained.length ? card.planted.unexplained.join(', ') : 'none'}. Gate: ${card.planted.gate}.`,
    '',
    `Report reproduces from the ledger: ${card.report?.ok ? 'yes' : `no (${(card.report?.problems || []).join('; ')})`}.`,
    '',
  ];
  if (card.isolation) {
    lines.push('## Each defect alone', '', '| # | Flag | Found | Failing test cases | Unexpected |', '| --- | --- | --- | --- | --- |');
    for (const i of card.isolation) lines.push(`| ${i.planted} | ${i.flag ?? 'android manifest'} | ${i.found === true ? 'yes' : i.found} | ${i.failing.join(', ')} | ${i.unexpected.join(', ') || 'none'} |`);
    lines.push('');
  }
  if (card.problems.length) lines.push('## Problems', '', ...card.problems.map((p) => `- ${p}`), '');
  return lines.join('\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const flag = (name) => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : null;
  };
  const out = flag('out');
  runSelfTest({
    playwrightModule: flag('playwright') ?? process.env.E2E_PLAYWRIGHT_MODULE ?? null,
    isolate: args.includes('--isolate'),
    log: (message) => console.error(`self-test: ${message}`),
  })
    .then((card) => {
      if (out) {
        mkdirSync(resolve(out), { recursive: true });
        writeFileSync(join(resolve(out), 'self-test.json'), `${JSON.stringify(card, null, 2)}\n`);
        writeFileSync(join(resolve(out), 'SELF_TEST.md'), renderScorecard(card));
      }
      console.log(renderScorecard(card));
      process.exitCode = card.verdict === 'fail' ? 1 : 0;
    })
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
