#!/usr/bin/env node
// Writes the operational dashboard and the final report for the run, from the ledger and the
// telemetry. Both are written under .claude/backend-engineer/ unless --out is given.
//
// Usage:
//   report.mjs dashboard [--out path]
//   report.mjs report [--out path]

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { loadLedger, makeContext } from './ledger.mjs';
import { parseEntries, telemetryPath } from './telemetry.mjs';
import { buildView, renderDashboard, renderReport } from './view.mjs';

const USAGE = 'usage: report.mjs dashboard|report [--out path]';

export function parseArgs(args) {
  const [kind, ...flags] = args;
  if (kind !== 'dashboard' && kind !== 'report') throw new Error(USAGE);
  const options = { kind, out: null };
  for (let i = 0; i < flags.length; i += 2) {
    if (flags[i] !== '--out' || flags[i + 1] === undefined) throw new Error(`unknown option: ${flags[i]}\n${USAGE}`);
    options.out = flags[i + 1];
  }
  return options;
}

// Returns { path, content }. The caller writes the file.
export function build(options, projectDir) {
  const ledger = loadLedger(projectDir);
  const file = telemetryPath(projectDir);
  const telemetry = existsSync(file) ? parseEntries(readFileSync(file, 'utf8')) : [];
  const view = buildView(ledger, telemetry, makeContext(projectDir));
  const name = options.kind === 'dashboard' ? 'dashboard.html' : 'report.md';
  const content = options.kind === 'dashboard' ? renderDashboard(view) : renderReport(view);
  const path = options.out ?? join(projectDir, '.claude', 'backend-engineer', name);
  return { path, content };
}

export function main(argv, env = process.env) {
  const options = parseArgs(argv);
  const projectDir = env.CLAUDE_PROJECT_DIR || process.cwd();
  const { path, content } = build(options, projectDir);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return `${options.kind} written: ${path}\n`;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
