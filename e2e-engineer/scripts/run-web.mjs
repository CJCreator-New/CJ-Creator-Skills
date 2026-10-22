#!/usr/bin/env node
// Runs the web and mobile-web test cases of the approved plan in a real browser, then records each
// run, and a defect for each confirmed failure, in the ledger. Each test case gets a fresh browser
// context and, when the config allows reset, a fresh database. Evidence (a screenshot and a redacted
// log) is written under .claude/e2e-engineer/evidence. The plan must be approved and current.
//
// node scripts/run-web.mjs <ledger.json> <config.json> --root <repo> [--only TC-1,TC-2] [--web <url>] [--mobile <url>]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blocked, Infrastructure, classify, resolveValue, runCheck } from './checks.mjs';
import { createContext } from './run-api.mjs';
import { readLedger, recordResults, writeLedger } from './ledger.mjs';
import { selectTestCases } from './results.mjs';
import { createStopper, healthStop } from './stops.mjs';
import { pruneEvidence } from './evidence.mjs';
import { planDigest } from './plan.mjs';
import { resetDatabase, validateTarget } from './env.mjs';
import { findAxe, findPlaywright, loadPlaywright } from './browser.mjs';
import { validateSteps } from './web-steps.mjs';
import { redactBody, redactHeaders, redactString, redactValue } from './redact.mjs';

export const STEP_TIMEOUT_MS = 5000;

// The page-side checks are self-contained, because Playwright sends them to the page as text.

// Whether an element is cut off by a container that hides overflow, or by the viewport.
function clippedInPage(el) {
  const r = el.getBoundingClientRect();
  let node = el.parentElement;
  while (node && node !== document.body && node !== document.documentElement) {
    const s = getComputedStyle(node);
    if (s.overflowX === 'auto' || s.overflowX === 'scroll') return { clipped: false, by: 'a scroll container' };
    if (s.overflowX === 'hidden' || s.overflowX === 'clip') {
      const n = node.getBoundingClientRect();
      if (r.right > n.right + 1 || r.left < n.left - 1) return { clipped: true, by: 'a container that hides overflow' };
    }
    node = node.parentElement;
  }
  if (r.right > document.documentElement.clientWidth + 1) return { clipped: true, by: 'the viewport' };
  return { clipped: false, by: null };
}

// The built-in accessibility rules: a form field has an accessible name, and a button has a name.
// This is a limited scan. A fuller scan is a later addition, with its own dependency.
function a11yInPage(rules) {
  const violations = [];
  const text = (el) => (el ? (el.textContent || '').trim() : '');
  if (rules.includes('input-label')) {
    for (const el of document.querySelectorAll('input, textarea, select')) {
      if (['hidden', 'submit', 'button', 'reset', 'image'].includes(el.type)) continue;
      const labelled =
        Array.from(el.labels || []).some((label) => text(label).length > 0) ||
        (el.getAttribute('aria-label') || '').trim() !== '' ||
        (el.getAttribute('aria-labelledby') || '') !== '' ||
        (el.getAttribute('title') || '').trim() !== '';
      if (!labelled) violations.push(`a form field has no label: ${el.name || el.id || el.outerHTML.slice(0, 60)}`);
    }
  }
  if (rules.includes('button-name')) {
    for (const el of document.querySelectorAll('button, [role="button"]')) {
      const name = text(el) || (el.getAttribute('aria-label') || '').trim() || (el.getAttribute('title') || '').trim();
      if (!name) violations.push(`a button has no name: ${el.outerHTML.slice(0, 60)}`);
    }
  }
  return violations;
}

export class StepFailed extends Error {}

const firstLine = (text) => String(text).split('\n')[0];

function infrastructureError(error) {
  return /net::ERR_|Target (page, context or browser )?(has been )?closed|browser has been closed|Connection refused/i.test(error.message);
}

// What a step was meant to show, in words, for the failure message.
function describeStep(step) {
  switch (step.act) {
    case 'fill':
      return `no field labelled "${step.label}" accepted the value`;
    case 'click':
      return `no ${step.role} named "${step.name}" could be clicked`;
    case 'expectVisible':
      return `${step.role} "${step.name}" did not appear`;
    case 'expectText':
      return `the text "${step.text}" did not appear`;
    case 'expectUrl':
      return `the page did not reach ${step.contains}`;
    case 'expectTestId':
      return `${step.testId} did not show "${step.text}"`;
    case 'expectDownload':
      return `no download started from ${step.role} "${step.name}"`;
    case 'expectResponse':
      return `${step.role} "${step.name}" sent no ${step.method} ${step.path}`;
    default:
      return `${step.act} did not pass`;
  }
}

async function waitForHash(page, fragment) {
  await page.waitForFunction((s) => window.location.hash.includes(s), fragment, { timeout: STEP_TIMEOUT_MS });
}

// The full axe-core scan, with the WCAG A and AA tags unless the step names others. A violation of a
// rule the step lists in `allow` is not reported. axe-core comes from the repository or the config.
async function axeViolations(page, step, ctx) {
  const found = findAxe({ root: ctx.root, config: ctx.config });
  if (!found.found) throw new Blocked(found.reason);
  await page.addScriptTag({ content: readFileSync(found.path, 'utf8') });
  const tags = step.axeTags ?? ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
  const results = await page.evaluate((runOnly) => window.axe.run(document, { runOnly: { type: 'tag', values: runOnly } }), tags);
  return results.violations
    .filter((v) => !(step.allow || []).includes(v.id))
    .map((v) => `axe ${v.id} (${v.impact}): ${v.help}, ${v.nodes.length} element(s)`);
}

// Compares a screenshot of the page with a reference image, pixel by pixel, in a blank page so the
// browser decodes both. A pixel differs when any channel differs by more than 16. Images of different
// sizes do not match. The diff image goes to the evidence folder.
async function compareWithDesign(page, step, ctx) {
  const reference = resolve(ctx.root, step.image);
  if (!existsSync(reference)) throw new Blocked(`the design reference ${step.image} does not exist; export it, or read it through the Figma connector`);
  const shot = await page.screenshot({ fullPage: step.fullPage === true });
  const scratch = await page.context().newPage();
  try {
    const result = await scratch.evaluate(
      async ([a, b]) => {
        const load = (src) => new Promise((done, fail) => {
          const img = new Image();
          img.onload = () => done(img);
          img.onerror = () => fail(new Error('the image could not be decoded'));
          img.src = src;
        });
        const [x, y] = await Promise.all([load(a), load(b)]);
        if (x.width !== y.width || x.height !== y.height) {
          return { ratio: 1, detail: `the page is ${x.width} by ${x.height} pixels and the reference is ${y.width} by ${y.height}`, diff: null };
        }
        const pixels = (img) => {
          const c = document.createElement('canvas');
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext('2d');
          g.drawImage(img, 0, 0);
          return g.getImageData(0, 0, c.width, c.height);
        };
        const p = pixels(x);
        const q = pixels(y);
        const out = new ImageData(p.width, p.height);
        let differing = 0;
        for (let i = 0; i < p.data.length; i += 4) {
          const differs = [0, 1, 2, 3].some((k) => Math.abs(p.data[i + k] - q.data[i + k]) > 16);
          if (differs) differing += 1;
          out.data.set(differs ? [255, 0, 0, 255] : [p.data[i], p.data[i + 1], p.data[i + 2], 60], i);
        }
        const c = document.createElement('canvas');
        c.width = p.width;
        c.height = p.height;
        c.getContext('2d').putImageData(out, 0, 0);
        return { ratio: differing / (p.width * p.height), detail: `${differing} differing pixels`, diff: c.toDataURL('image/png') };
      },
      [`data:image/png;base64,${shot.toString('base64')}`, `data:image/png;base64,${readFileSync(reference).toString('base64')}`],
    );
    if (result.diff && ctx.evidence) {
      mkdirSync(ctx.evidence.dir, { recursive: true });
      const name = `${ctx.evidence.stem}-design-diff.png`;
      writeFileSync(join(ctx.evidence.dir, name), Buffer.from(result.diff.split(',')[1], 'base64'));
      ctx.evidence.files.push(join(ctx.evidence.rel, name));
    }
    return result;
  } finally {
    await scratch.close();
  }
}

// Runs one step in the page. Each act is a user action or a check, found by its role, name or label.
export async function runStep(step, { page, base, ctx }) {
  const value = (v) => resolveValue(v, ctx.env);
  switch (step.act) {
    case 'signIn': {
      const account = ctx.account(step.as);
      await page.goto(new URL('#/login', base.endsWith('/') ? base : `${base}/`).href);
      await page.getByLabel('Username', { exact: true }).fill(account.username);
      await page.getByLabel('Password', { exact: true }).fill(account.password);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await waitForHash(page, '#/orders');
      return;
    }
    case 'goto':
      await page.goto(new URL(step.path, base.endsWith('/') ? base : `${base}/`).href);
      return;
    case 'fill':
      await page.getByLabel(step.label, { exact: true }).fill(value(step.value));
      return;
    case 'click':
      await page.getByRole(step.role, { name: step.name, exact: true }).click();
      return;
    case 'expectVisible':
      await page.getByRole(step.role, { name: step.name, exact: true }).first().waitFor({ state: 'visible' });
      return;
    case 'expectText':
      await page.getByText(step.text).first().waitFor({ state: 'visible' });
      return;
    case 'expectUrl':
      await waitForHash(page, step.contains);
      return;
    case 'expectTestId':
      await page.waitForFunction(
        ([id, text]) => {
          const el = document.querySelector(`[data-testid="${id}"]`);
          return Boolean(el && el.textContent.includes(text));
        },
        [step.testId, step.text],
        { timeout: STEP_TIMEOUT_MS },
      );
      return;
    case 'expectDownload': {
      const [download] = await Promise.all([
        page.waitForEvent('download', { timeout: STEP_TIMEOUT_MS }),
        page.getByRole(step.role, { name: step.name, exact: true }).click(),
      ]);
      if (download.suggestedFilename() !== step.filename) {
        throw new StepFailed(`the download was "${download.suggestedFilename()}", expected "${step.filename}"`);
      }
      return;
    }
    case 'interceptNext': {
      let fired = false;
      await page.route(`**${step.path}`, async (route, request) => {
        if (fired || request.method() !== step.method) return route.continue();
        fired = true;
        await route.fulfill({
          status: step.status,
          contentType: 'application/json',
          body: JSON.stringify(step.body ?? { error: { code: 'injected', message: 'injected failure' } }),
        });
      });
      return;
    }
    case 'expectNotClipped': {
      const result = await page.getByRole(step.role).first().evaluate(clippedInPage);
      if (result.clipped) throw new StepFailed(`the ${step.role} is clipped by ${result.by}`);
      return;
    }
    case 'expectMinTarget': {
      const box = await page.getByRole(step.role, { name: step.name, exact: true }).first().boundingBox();
      if (!box || box.width < step.min || box.height < step.min) {
        const size = box ? `${Math.round(box.width)} by ${Math.round(box.height)}` : 'not visible';
        throw new StepFailed(`"${step.name}" is ${size} CSS pixels, and the minimum is ${step.min}`);
      }
      return;
    }
    case 'expectResponse': {
      const [response] = await Promise.all([
        page.waitForResponse((r) => r.request().method() === step.method && new URL(r.url()).pathname === step.path, { timeout: STEP_TIMEOUT_MS }),
        page.getByRole(step.role, { name: step.name, exact: true }).click(),
      ]);
      if (response.status() !== step.status) {
        throw new StepFailed(`the response to ${step.method} ${step.path} was ${response.status()}, expected ${step.status}`);
      }
      return;
    }
    case 'check': {
      if (!ctx.api) throw new Blocked('a backend check step runs only in an e2e test case');
      const outcome = await runCheck(step.check, ctx.api);
      if (!outcome.ok) throw new StepFailed(`${step.check.kind}: ${outcome.message}`);
      return;
    }
    case 'scanA11y': {
      const violations = await page.evaluate(a11yInPage, step.rules.filter((rule) => rule !== 'axe'));
      if (step.rules.includes('axe')) violations.push(...(await axeViolations(page, step, ctx)));
      if (violations.length > 0) throw new StepFailed(violations.join('; '));
      return;
    }
    case 'expectKeyboardReach': {
      const target = page.getByRole(step.role, { name: step.name, exact: true }).first();
      await target.waitFor({ state: 'visible' });
      await page.evaluate(() => document.activeElement?.blur?.());
      const max = step.maxTabs ?? 30;
      for (let i = 1; i <= max; i += 1) {
        await page.keyboard.press('Tab');
        if (await target.evaluate((el) => el === document.activeElement)) return;
      }
      throw new StepFailed(`${step.role} "${step.name}" was not reached with ${max} presses of Tab`);
    }
    case 'expectMatchesDesign': {
      const result = await compareWithDesign(page, step, ctx);
      if (result.ratio > (step.maxDiffRatio ?? 0.02)) {
        throw new StepFailed(`${result.detail}; ${(result.ratio * 100).toFixed(2)}% of pixels differ from ${step.image}, over ${((step.maxDiffRatio ?? 0.02) * 100).toFixed(2)}%`);
      }
      return;
    }
    default:
      throw new Blocked(`unknown act ${step.act}`);
  }
}

// Runs one test case in its own browser context. Returns { result, failures, reasons, evidence }.
// The clock and time zone a test case runs under (G28): the test case's own, or the config's. A
// fixed time freezes Date in the page; the time zone sets the browser's zone. Without either, the
// page uses the machine's clock and zone, and the run records that as a limitation.
export function pageEnvironment(testCase, config = {}) {
  const timezone = testCase.timezone ?? config.timezones?.[0] ?? null;
  const fixedTime = testCase.clock ?? config.clock?.fixedTime ?? null;
  return { timezone, fixedTime };
}

export async function runWebTestCase({ testCase, browser, base, viewports, ctx, evidenceDir, evidenceRel, environment = {} }) {
  const problems = validateSteps(testCase);
  if (problems.length > 0) return { result: 'blocked', failures: [], reasons: problems, evidence: [] };
  const viewportName = testCase.viewport ?? 'desktop';
  const viewport = viewports[viewportName];
  if (!viewport) return { result: 'blocked', failures: [], reasons: [`viewport ${viewportName} is not declared in the config`], evidence: [] };

  const log = { test: testCase.id, viewport: viewportName, requests: [], responses: [], console: [], steps: [] };
  const context = await browser.newContext({
    viewport: { width: viewport.width, height: viewport.height },
    ...(environment.timezone ? { timezoneId: environment.timezone } : {}),
  });
  if (environment.fixedTime) await context.clock.setFixedTime(new Date(environment.fixedTime));
  const page = await context.newPage();
  page.setDefaultTimeout(STEP_TIMEOUT_MS);
  page.on('request', (request) => {
    if (!request.url().startsWith(base)) return;
    log.requests.push({
      method: request.method(),
      url: redactString(request.url(), ctx.secrets),
      headers: redactHeaders(request.headers(), ctx.secrets),
      body: redactBody(request.postData() || '', ctx.secrets),
    });
  });
  page.on('response', (response) => {
    if (response.url().startsWith(base)) log.responses.push({ url: redactString(response.url(), ctx.secrets), status: response.status() });
  });
  page.on('console', (message) => {
    if (message.type() === 'error') log.console.push(redactString(message.text(), ctx.secrets));
  });
  page.on('pageerror', (error) => log.console.push(redactString(error.message, ctx.secrets)));

  const outcome = { result: 'passed', failures: [], reasons: [], evidence: [] };
  try {
    for (const [i, step] of testCase.steps.entries()) {
      const label = `step ${i + 1} (${step.act})`;
      try {
        const evidence = { dir: evidenceDir, rel: evidenceRel, stem: `${testCase.id}-${viewportName}`, files: outcome.evidence };
        await runStep(step, { page, base, ctx: { ...ctx, evidence } });
        log.steps.push({ label, ok: true });
      } catch (error) {
        const message = error instanceof StepFailed ? error.message : /Timeout \d+ms exceeded/.test(error.message) ? describeStep(step) : firstLine(error.message);
        log.steps.push({ label, ok: false, message: redactString(message, ctx.secrets) });
        if (error instanceof Blocked) {
          outcome.result = 'blocked';
          outcome.reasons.push(`${label}: ${error.message}`);
        } else if (infrastructureError(error)) {
          outcome.result = 'blocked';
          outcome.reasons.push(`${label}: infrastructure: ${firstLine(error.message)}`);
        } else {
          outcome.result = 'failed';
          outcome.failures.push({ check: label, message: redactString(message, ctx.secrets) });
        }
        break;
      }
    }
  } finally {
    const stem = `${testCase.id}-${viewportName}`;
    try {
      mkdirSync(evidenceDir, { recursive: true });
      await page.screenshot({ path: join(evidenceDir, `${stem}.png`) });
      outcome.evidence.push(join(evidenceRel, `${stem}.png`));
    } catch {
      // The page may already be gone after an infrastructure failure. The log is still written.
    }
    const logText = JSON.stringify(redactValue(log, ctx.secrets), null, 2);
    writeFileSync(join(evidenceDir, `${stem}.json`), `${redactString(logText, ctx.secrets)}\n`);
    outcome.evidence.push(join(evidenceRel, `${stem}.json`));
    await context.close();
  }
  return outcome;
}

// Runs every implemented web and mobile-web test case. Returns the results, sorted by ID.
export function runWeb(options) {
  return runBrowserSuite({ ...options, layers: ['web', 'mobile-web'] });
}

// The browser suite for the given layers. The e2e layer also gets an API context, so its backend
// check steps can sign in by role, send requests and read the database.
export async function runBrowserSuite({ ledgerPath, configPath, root, env, now, playwright = null, bases = {}, only = null, layers, health = undefined }) {
  const ledger = readLedger(ledgerPath);
  if (!ledger.intake || !ledger.intake.safety.allowed) throw new Error('the run is not allowed; run intake first');
  if (!ledger.approval) throw new Error('the test plan is not approved');
  if (ledger.approval.planHash !== planDigest(ledger)) throw new Error('the plan changed after approval; freeze and approve it again');

  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  if (config.db) {
    const target = validateTarget({ config, root });
    if (!target.ok) throw new Error(`database refused: ${target.reasons.join('; ')}`);
  }
  const baseFor = {
    web: bases.web ?? config.targets?.web?.baseUrl ?? null,
    'mobile-web': bases.mobile ?? config.targets?.['mobile-web']?.baseUrl ?? config.targets?.web?.baseUrl ?? null,
    e2e: bases.web ?? config.targets?.web?.baseUrl ?? null,
  };
  const viewports = config.viewports ?? {};
  const roles = new Map((ledger.roles || []).map((r) => [r.id, r]));
  const secrets = (ledger.roles || []).map((r) => env[r.account?.passwordEnv]).filter(Boolean);
  const ctx = {
    env,
    secrets,
    root,
    config,
    account(roleId) {
      const role = roles.get(roleId);
      if (!role || !role.account) throw new Blocked(`role ${roleId} has no account in the plan`);
      const username = env[role.account.usernameEnv];
      const password = env[role.account.passwordEnv];
      if (!username || !password) {
        throw new Blocked(`set ${role.account.usernameEnv} and ${role.account.passwordEnv} to sign in as ${roleId}`);
      }
      return { username, password };
    },
    api: layers.includes('e2e') && baseFor.e2e ? createContext({ ledger, config, root, base: baseFor.e2e, env }) : null,
  };

  const runDir = now.replace(/[:.]/g, '-');
  const evidenceRel = join('.claude', 'e2e-engineer', 'evidence', runDir);
  const evidenceDir = join(root, evidenceRel);

  let browser = null;
  let launchReason = null;
  try {
    const pw = playwright ?? loadPlaywright(findPlaywright({ root, config }));
    browser = await pw.chromium.launch();
  } catch (error) {
    launchReason = `the browser did not start: ${firstLine(error.message)}`;
  }

  const requirementsById = new Map((ledger.requirements || []).map((r) => [r.id, r]));
  const testCases = selectTestCases(ledger, layers, only);
  const results = [];
  const runner = layers.includes('e2e') ? 'e2e' : 'web';
  const held = await healthStop({ config, testCases, runner, ...(health ? { check: health } : {}) });
  const stopper = createStopper({ config, ledger, root, runner });
  for (const testCase of held ? [] : testCases) {
    const finish = (outcome) => ({
      id: testCase.id,
      layer: testCase.layer,
      mutates: testCase.mutates,
      journeys: testCase.journeys || [],
      requirements: testCase.requirements || [],
      result: classify(outcome.result, testCase, requirementsById),
      failures: outcome.failures || [],
      reasons: outcome.reasons || [],
      evidence: outcome.evidence || [],
    });
    if (!baseFor[testCase.layer]) {
      results.push(finish({ result: 'blocked', reasons: [`no ${testCase.layer} base URL is declared`] }));
      continue;
    }
    if (!browser) {
      results.push(finish({ result: 'blocked', reasons: [launchReason] }));
      continue;
    }
    const why = stopper.check(testCase);
    if (why) {
      results.push(finish(stopper.stoppedResult(testCase, why)));
      continue;
    }
    if (config.db && config.allowReset === true) {
      resetDatabase({ config, root, now: new Date().toISOString() });
    } else if (testCase.mutates && config.db) {
      results.push(finish({ result: 'blocked', reasons: ['a fresh database is needed before a mutating test, and reset is not allowed'] }));
      continue;
    }
    const outcome = await runWebTestCase({
      testCase,
      browser,
      base: baseFor[testCase.layer],
      viewports,
      ctx,
      evidenceDir,
      evidenceRel,
      environment: pageEnvironment(testCase, config),
    });
    const result = finish(outcome);
    stopper.note(result, { testCase });
    results.push(result);
  }
  if (browser) await browser.close();
  if (held) results.push(...held.results);

  const recorded = recordResults(ledger, results, { now, stops: held ? held.stops : stopper.stops() });
  const pruned = pruneEvidence({ root, ledger, config, now });
  writeLedger(ledgerPath, ledger);

  const tally = {};
  for (const result of results) tally[result.result] = (tally[result.result] || 0) + 1;
  return {
    ran: results.length,
    results: tally,
    failed: results.filter((r) => r.result === 'failed').map((r) => ({ id: r.id, failures: r.failures })),
    blocked: results.filter((r) => r.result === 'blocked').map((r) => ({ id: r.id, reasons: r.reasons })),
    evidence: evidenceRel,
    evidencePruned: pruned.map((p) => p.folder),
    stops: recorded.stops,
    defects: ledger.defects.length,
    opened: recorded.opened,
    flaky: recorded.flaky,
    transitions: recorded.transitions,
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
    console.error('usage: run-web.mjs <ledger.json> <config.json> --root <repo> [--only TC-1,TC-2] [--web <url>] [--mobile <url>]');
    process.exit(1);
  }
  runWeb({
    ledgerPath: resolve(ledgerPath),
    configPath: resolve(configPath),
    root: resolve(flags.root ?? '.'),
    env: process.env,
    now: new Date().toISOString(),
    only: flags.only ? flags.only.split(',') : null,
    bases: { web: flags.web, mobile: flags.mobile },
  })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
