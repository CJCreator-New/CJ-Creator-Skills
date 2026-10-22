#!/usr/bin/env node
// Runs the web and mobile-web test cases of the approved plan in a real browser, then records each
// run, and a defect for each confirmed failure, in the ledger. Each test case gets a fresh browser
// context and, when the config allows reset, a fresh database. Evidence (a screenshot and a redacted
// log) is written under .claude/e2e-engineer/evidence. The plan must be approved and current.
//
// node scripts/run-web.mjs <ledger.json> <config.json> --root <repo> [--web <url>] [--mobile <url>]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Blocked, Infrastructure, classify, resolveValue } from './checks.mjs';
import { readLedger, recordDefect, recordRun, writeLedger } from './ledger.mjs';
import { planDigest } from './plan.mjs';
import { resetDatabase, validateTarget } from './env.mjs';
import { findPlaywright, loadPlaywright } from './browser.mjs';
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
    default:
      return `${step.act} did not pass`;
  }
}

async function waitForHash(page, fragment) {
  await page.waitForFunction((s) => window.location.hash.includes(s), fragment, { timeout: STEP_TIMEOUT_MS });
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
    case 'scanA11y': {
      const violations = await page.evaluate(a11yInPage, step.rules);
      if (violations.length > 0) throw new StepFailed(violations.join('; '));
      return;
    }
    default:
      throw new Blocked(`unknown act ${step.act}`);
  }
}

// Runs one test case in its own browser context. Returns { result, failures, reasons, evidence }.
export async function runWebTestCase({ testCase, browser, base, viewports, ctx, evidenceDir, evidenceRel }) {
  const problems = validateSteps(testCase);
  if (problems.length > 0) return { result: 'blocked', failures: [], reasons: problems, evidence: [] };
  const viewportName = testCase.viewport ?? 'desktop';
  const viewport = viewports[viewportName];
  if (!viewport) return { result: 'blocked', failures: [], reasons: [`viewport ${viewportName} is not declared in the config`], evidence: [] };

  const log = { test: testCase.id, viewport: viewportName, requests: [], responses: [], console: [], steps: [] };
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
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
        await runStep(step, { page, base, ctx });
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
export async function runWeb({ ledgerPath, configPath, root, env, now, playwright = null, bases = {} }) {
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
  };
  const viewports = config.viewports ?? {};
  const roles = new Map((ledger.roles || []).map((r) => [r.id, r]));
  const secrets = (ledger.roles || []).map((r) => env[r.account?.passwordEnv]).filter(Boolean);
  const ctx = {
    env,
    secrets,
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
  const testCases = ledger.testCases.filter((tc) => ['web', 'mobile-web'].includes(tc.layer) && tc.automation === 'implemented');
  const results = [];
  for (const testCase of testCases) {
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
    });
    results.push(finish(outcome));
  }
  if (browser) await browser.close();

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
    evidence: evidenceRel,
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
    console.error('usage: run-web.mjs <ledger.json> <config.json> --root <repo> [--web <url>] [--mobile <url>]');
    process.exit(1);
  }
  runWeb({
    ledgerPath: resolve(ledgerPath),
    configPath: resolve(configPath),
    root: resolve(flags.root ?? '.'),
    env: process.env,
    now: new Date().toISOString(),
    bases: { web: flags.web, mobile: flags.mobile },
  })
    .then((summary) => console.log(JSON.stringify(summary, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
