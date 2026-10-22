// The keyboard-reach step, the axe-core scan and the design comparison, in real Chromium on small
// pages. Skipped where Chromium is not available. The axe test needs axe-core, which the plugin never
// installs: it runs only when E2E_AXE_MODULE names a copy.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Blocked } from '../scripts/checks.mjs';
import { loadPlaywright } from '../scripts/browser.mjs';
import { runStep } from '../scripts/run-web.mjs';

const PLAYWRIGHT = [process.env.E2E_PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/playwright'].filter(Boolean).find((p) => existsSync(p)) ?? null;
const AXE = process.env.E2E_AXE_MODULE && existsSync(process.env.E2E_AXE_MODULE) ? process.env.E2E_AXE_MODULE : null;

let browser = null;
try {
  if (PLAYWRIGHT) browser = await loadPlaywright({ found: true, path: PLAYWRIGHT }).chromium.launch();
} catch {
  browser = null;
}

const PAGE = `<!doctype html><html lang="en"><head><title>t</title></head><body>
  <main><h1>Form</h1><button>Save</button><div role="button" aria-label="Archive">A</div>
  <label>Name <input name="name"></label><div id="box" style="width:200px;height:100px;background:#1f6feb"></div></main></body></html>`;

describe('accessibility and design steps', { skip: browser ? false : 'Chromium is not available' }, () => {
  let page;
  let dir;
  before(async () => {
    page = await (await browser.newContext({ viewport: { width: 400, height: 300 } })).newPage();
    dir = mkdtempSync(join(tmpdir(), 'e2e-steps-'));
  });
  after(async () => {
    await browser?.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const ctx = (extra = {}) => ({ env: {}, root: dir, config: {}, ...extra });

  test('expectKeyboardReach passes for a focusable control and fails for one Tab cannot reach', async () => {
    await page.setContent(PAGE);
    await runStep({ act: 'expectKeyboardReach', role: 'button', name: 'Save' }, { page, base: 'http://x', ctx: ctx() });
    await assert.rejects(
      runStep({ act: 'expectKeyboardReach', role: 'button', name: 'Archive', maxTabs: 5 }, { page, base: 'http://x', ctx: ctx() }),
      /button "Archive" was not reached with 5 presses of Tab/,
    );
  });

  test('the axe scan is blocked, with the reason, when the repository has no axe-core', async () => {
    await page.setContent(PAGE);
    await assert.rejects(runStep({ act: 'scanA11y', rules: ['axe'] }, { page, base: 'http://x', ctx: ctx() }), (e) => e instanceof Blocked && /axe-core is not in the repository/.test(e.message));
  });

  test('the axe scan reports violations by rule, and honours allow', { skip: AXE ? false : 'set E2E_AXE_MODULE to an axe-core folder' }, async () => {
    await page.setContent(PAGE.replace('<label>Name <input name="name"></label>', '<input name="name">'));
    const config = { browser: { axeModule: AXE } };
    await assert.rejects(runStep({ act: 'scanA11y', rules: ['axe'] }, { page, base: 'http://x', ctx: ctx({ config }) }), /axe label \(critical\)/);
    await runStep({ act: 'scanA11y', rules: ['axe'], allow: ['label'] }, { page, base: 'http://x', ctx: ctx({ config }) });
  });

  test('expectMatchesDesign passes on the same rendering, fails on a changed one, and stores a diff image', async () => {
    await page.setContent(PAGE);
    writeFileSync(join(dir, 'reference.png'), await page.screenshot());
    const evidence = { dir: join(dir, 'evidence'), rel: 'evidence', stem: 'TC-D', files: [] };
    await runStep({ act: 'expectMatchesDesign', image: 'reference.png' }, { page, base: 'http://x', ctx: ctx({ evidence }) });
    await page.evaluate(() => {
      document.getElementById('box').style.background = '#b42318';
    });
    await assert.rejects(runStep({ act: 'expectMatchesDesign', image: 'reference.png', maxDiffRatio: 0.01 }, { page, base: 'http://x', ctx: ctx({ evidence }) }), /% of pixels differ from reference\.png, over 1\.00%/);
    assert.ok(readdirSync(join(dir, 'evidence')).includes('TC-D-design-diff.png'));
    await assert.rejects(runStep({ act: 'expectMatchesDesign', image: 'missing.png' }, { page, base: 'http://x', ctx: ctx() }), (e) => e instanceof Blocked);
  });
});
