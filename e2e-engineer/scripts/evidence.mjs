// Evidence retention (G16). Screenshots, logs and device captures are kept per run folder under
// .claude/e2e-engineer/evidence/. After each run, the oldest folders are removed until at most
// `evidence.keepRuns` folders (default 10) and `evidence.maxMegabytes` (default 500) remain. A folder
// that holds the latest evidence of a test case on an open defect, or of any test case's current run,
// is never removed. Each removal is recorded in the ledger, so the report says what is gone.

import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { testState } from './results.mjs';

export const EVIDENCE_DIR = join('.claude', 'e2e-engineer', 'evidence');
export const EVIDENCE_DEFAULTS = { keepRuns: 10, maxMegabytes: 500 };

function size(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((total, name) => total + size(join(path, name)), 0);
}

// The run folders that must stay: those named in the latest run of a test case that is current, or
// that an open defect is about.
export function protectedFolders(ledger) {
  const keep = new Set();
  const openTests = new Set((ledger.defects || []).filter((d) => d.status !== 'Closed').flatMap((d) => d.testCases || []));
  for (const tc of ledger.testCases || []) {
    const runs = ledger.runs.filter((r) => r.testCase === tc.id);
    const latest = runs[runs.length - 1];
    if (!latest) continue;
    const state = testState(ledger, tc.id).state;
    if (state === 'stale' && !openTests.has(tc.id)) continue;
    for (const path of latest.evidence || []) {
      const match = String(path).replaceAll('\\', '/').match(/evidence\/([^/]+)\//);
      if (match) keep.add(match[1]);
    }
  }
  return keep;
}

export function pruneEvidence({ root, ledger, config = {}, now }) {
  const limits = { ...EVIDENCE_DEFAULTS, ...(config.evidence || {}) };
  const dir = join(root, EVIDENCE_DIR);
  if (!existsSync(dir)) return [];
  const keep = protectedFolders(ledger);
  const folders = readdirSync(dir)
    .filter((name) => statSync(join(dir, name)).isDirectory())
    .sort()
    .map((name) => ({ name, bytes: size(join(dir, name)) }));
  let count = folders.length;
  let bytes = folders.reduce((total, f) => total + f.bytes, 0);
  const cap = limits.maxMegabytes * 1024 * 1024;
  const removed = [];
  for (const folder of folders) {
    if (count <= limits.keepRuns && bytes <= cap) break;
    if (keep.has(folder.name)) continue;
    rmSync(join(dir, folder.name), { recursive: true, force: true });
    count -= 1;
    bytes -= folder.bytes;
    const reason = count + 1 > limits.keepRuns ? `over ${limits.keepRuns} run folders` : `over ${limits.maxMegabytes} MB`;
    removed.push({ folder: folder.name, bytes: folder.bytes, at: now, reason });
  }
  ledger.evidencePruned = [...(ledger.evidencePruned || []), ...removed];
  return removed;
}
