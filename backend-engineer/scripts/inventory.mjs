#!/usr/bin/env node
// Finds the UI sites in a frontend source tree that an interaction could come from: event handlers,
// forms, buttons, links and programmatic navigation. The ledger records which UI files had such
// sites, and the release check then asks whether every such file has an interaction record.
//
// This is a heuristic scan. It shows where interaction sites are, not which of them matter. The
// requirements analyst decides that, and it is the reason the scan is compared with the ledger rather
// than trusted on its own.
//
// Usage:
//   inventory.mjs scan <dir>      prints the sites found, grouped by file
//   inventory.mjs record <dir>    records the per-file counts in the ledger

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

import { commit, loadLedger, setInventory, withLock } from './ledger.mjs';

export const INVENTORY_COMMANDS = ['scan', 'record'];
const EXTENSIONS = new Set(['.tsx', '.jsx', '.ts', '.js', '.vue', '.svelte', '.html']);
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.next', 'coverage', 'out', 'vendor', '.claude']);
export const SITE_PATTERNS = [
  ['handler', /\bon[A-Z][A-Za-z]*=\{/],
  ['form', /<form\b/],
  ['button', /<button\b/],
  ['link', /<(?:Link|a)\b[^>]*\bhref=/],
  ['navigate', /\b(?:navigate|router\.push|router\.replace)\(/],
  ['vue-event', /@(?:click|submit|change)=/],
  ['svelte-event', /\bon:(?:click|submit|change)=/],
];

export function scanText(text) {
  const sites = [];
  text.split('\n').forEach((line, index) => {
    for (const [kind, pattern] of SITE_PATTERNS) {
      if (pattern.test(line)) sites.push({ line: index + 1, kind, text: line.trim().slice(0, 160) });
    }
  });
  return sites;
}

export function walk(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIP.has(entry.name)) return [];
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    const dot = entry.name.lastIndexOf('.');
    return dot >= 0 && EXTENSIONS.has(entry.name.slice(dot)) ? [path] : [];
  });
}

// Sites per file, keyed by the path relative to the project, so they match interaction records.
export function scanDir(root, projectDir) {
  const files = {};
  for (const file of walk(root)) {
    const sites = scanText(readFileSync(file, 'utf8'));
    if (sites.length) files[relative(projectDir, file)] = sites;
  }
  return files;
}

// Returns { code, out }. Usage: scan <dir> | record <dir>
export function main(argv, env = process.env) {
  const [command, dir] = argv;
  if (!INVENTORY_COMMANDS.includes(command) || !dir) throw new Error('usage: inventory.mjs scan|record <dir>');
  const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
  const sites = scanDir(dir, projectDir);

  if (command === 'scan') {
    const total = Object.values(sites).reduce((n, list) => n + list.length, 0);
    return { code: 0, out: `${JSON.stringify({ files: sites, total }, null, 2)}\n` };
  }

  const counts = Object.fromEntries(Object.entries(sites).map(([file, list]) => [file, list.length]));
  withLock(projectDir, () => {
    const ledger = loadLedger(projectDir);
    setInventory(ledger, counts);
    commit(projectDir, ledger);
  });
  const total = Object.values(counts).reduce((n, c) => n + c, 0);
  return { code: 0, out: `recorded ${Object.keys(counts).length} UI file(s) with ${total} interaction site(s)\n` };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const { code, out } = main(process.argv.slice(2));
    process.stdout.write(out);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
