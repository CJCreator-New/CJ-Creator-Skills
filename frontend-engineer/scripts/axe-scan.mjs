#!/usr/bin/env node
// Runtime accessibility scan of one URL at one or more viewports, using Playwright and axe-core
// from the project. It reports what it could run and never guesses: when Playwright, axe-core or a
// browser is missing, or the page does not load, it prints status "not performed" with the reason.
//
//   node scripts/axe-scan.mjs --url http://127.0.0.1:5173/dashboard \
//        --viewport desktop=1440x900 --viewport mobile=390x844 --tab 20 --out .claude/frontend-engineer/accessibility/evidence
//
// For each viewport it runs axe-core against WCAG 2.0 A/AA, 2.1 A/AA and 2.2 AA, and records the first
// --tab focus stops (role, name, box, outline) so the reviewer can judge the focus order. It also measures
// horizontal overflow at 320 CSS px (WCAG 1.4.10). Only Tab is pressed. No click, Enter or form input is sent.
// Full results go to --out as JSON when given. The summary goes to stdout as one JSON object.

import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];
export const DEFAULT_VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile', width: 390, height: 844 },
];
const REFLOW_WIDTH = 320;
const MAX_TARGETS = 20;

// Reduce an axe result to what the reviewer needs. Targets are capped so the summary stays short.
export function summarizeAxe(results) {
  const violations = (results?.violations ?? []).map((v) => ({
    id: v.id,
    impact: v.impact ?? 'unknown',
    help: v.help,
    helpUrl: v.helpUrl,
    count: v.nodes.length,
    targets: v.nodes.slice(0, MAX_TARGETS).map((n) => n.target.join(' ')),
  }));
  return {
    violations,
    incomplete: (results?.incomplete ?? []).map((i) => i.id),
    passes: (results?.passes ?? []).length,
  };
}

export function parseViewport(spec) {
  const match = String(spec).match(/^([a-z0-9-]+)=(\d+)x(\d+)$/i);
  if (!match) throw new Error(`viewport must look like name=WIDTHxHEIGHT, got ${spec}`);
  return { name: match[1], width: Number(match[2]), height: Number(match[3]) };
}

export function parseArgs(argv) {
  const opts = { url: null, viewports: [], tab: 15, out: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = () => {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      return value;
    };
    if (arg === '--url') opts.url = next();
    else if (arg === '--viewport') opts.viewports.push(parseViewport(next()));
    else if (arg === '--tab') opts.tab = Number(next());
    else if (arg === '--out') opts.out = next();
    else throw new Error(`unknown argument ${arg}`);
  }
  if (!opts.url || !/^https?:\/\//.test(opts.url)) throw new Error('--url must be an http or https URL');
  if (!Number.isInteger(opts.tab) || opts.tab < 0 || opts.tab > 200) throw new Error('--tab must be 0 to 200');
  if (opts.viewports.length === 0) opts.viewports = DEFAULT_VIEWPORTS;
  return opts;
}

// Resolve a package from the project, not from this plugin, so the project's own versions are used.
function resolveFromProject(projectDir, name) {
  try {
    return createRequire(join(projectDir, 'package.json')).resolve(name);
  } catch {
    return null;
  }
}

function notPerformed(url, reason) {
  return { status: 'not performed', url, reason };
}

// Press Tab through Playwright, then read the focused element in the page after each press.
async function walkFocus(page, count) {
  const stops = [];
  for (let i = 0; i < count; i++) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || el === document.body) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const labelledBy = el.getAttribute('aria-labelledby');
      const byIds = labelledBy
        ? labelledBy
            .split(/\s+/)
            .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
            .join(' ')
            .trim()
        : '';
      const name =
        el.getAttribute('aria-label') ||
        byIds ||
        el.getAttribute('alt') ||
        el.getAttribute('placeholder') ||
        el.getAttribute('title') ||
        (el.innerText || el.textContent || '').trim().slice(0, 80);
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role') || '',
        name,
        box: { width: Math.round(rect.width), height: Math.round(rect.height) },
        outlineStyle: style.outlineStyle,
        outlineWidth: style.outlineWidth,
        boxShadow: style.boxShadow,
      };
    });
    if (stop === null) break;
    stops.push(stop);
  }
  return stops;
}

async function scanViewport(browser, axeSource, url, viewport, tabStops) {
  const context = await browser.newContext({ viewport: { width: viewport.width, height: viewport.height } });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    await page.addScriptTag({ content: axeSource });
    const results = await page.evaluate(async (tags) => window.axe.run(document, { runOnly: { type: 'tag', values: tags } }), TAGS);
    const focus = await walkFocus(page, tabStops);
    return { name: viewport.name, width: viewport.width, height: viewport.height, ...summarizeAxe(results), focusStops: focus, raw: results };
  } finally {
    await context.close();
  }
}

async function reflowAt320(browser, url) {
  const context = await browser.newContext({ viewport: { width: REFLOW_WIDTH, height: 800 } });
  try {
    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'networkidle', timeout: 30000 });
    const overflowPx = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth));
    return { width: REFLOW_WIDTH, horizontalOverflowPx: overflowPx };
  } finally {
    await context.close();
  }
}

export async function scan(opts, projectDir = process.cwd()) {
  const { url } = opts;
  const playwrightPath = resolveFromProject(projectDir, 'playwright');
  if (!playwrightPath) return notPerformed(url, 'playwright was not found from the project (npm i -D playwright)');
  const axePath = resolveFromProject(projectDir, 'axe-core');
  if (!axePath) return notPerformed(url, 'axe-core was not found from the project (npm i -D axe-core)');

  // CommonJS packages expose their exports on "default" when imported from ESM, so both shapes are read.
  const playwright = await import(pathToFileURL(playwrightPath).href);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  const axeModule = await import(pathToFileURL(axePath).href);
  const axeSource = (axeModule.default ?? axeModule).source;
  if (!chromium || typeof axeSource !== 'string') {
    return notPerformed(url, 'playwright or axe-core did not expose the expected API for this version');
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    return notPerformed(url, `no browser could be launched: ${String(err.message).split('\n')[0]}`);
  }
  try {
    const viewports = [];
    for (const viewport of opts.viewports) {
      try {
        viewports.push(await scanViewport(browser, axeSource, url, viewport, opts.tab));
      } catch (err) {
        return notPerformed(url, `${viewport.name}: ${String(err.message).split('\n')[0]}`);
      }
    }
    let reflow;
    try {
      reflow = await reflowAt320(browser, url);
    } catch (err) {
      reflow = { width: REFLOW_WIDTH, error: String(err.message).split('\n')[0] };
    }
    return { status: 'performed', url, viewports, reflow };
  } finally {
    await browser.close();
  }
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`${err.message}\nusage: axe-scan.mjs --url <http-url> [--viewport name=WxH]... [--tab N] [--out dir]\n`);
    process.exit(2);
  }
  const result = await scan(opts);
  if (opts.out && result.status === 'performed') {
    const dir = resolve(opts.out);
    mkdirSync(dir, { recursive: true });
    for (const viewport of result.viewports) {
      writeFileSync(join(dir, `axe-${viewport.name}.json`), `${JSON.stringify(viewport.raw, null, 2)}\n`);
    }
  }
  // The raw axe result is written to --out only, so the stdout summary stays short.
  const summary = {
    ...result,
    viewports: result.viewports?.map(({ raw, ...rest }) => rest),
  };
  process.stdout.write(`${JSON.stringify(summary)}\n`);
}
