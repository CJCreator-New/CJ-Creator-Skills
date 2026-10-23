#!/usr/bin/env node
// Shared repo map for the repo-intel agents. One cache file per repository, one entry per path. Each entry
// is stamped with the commit it was mapped at, and an entry is reused only while nothing has changed its
// path: no commit after the stamp touched it, no uncommitted change, and the file still exists. So a change
// to one file refreshes one entry, not the whole map.
//
// Each plugin that maps a repository keeps a copy of this file, because plugins cannot share code.
// tests/repo-map-identity.test.mjs fails when the copies drift. Git is required: without git nothing is
// cached, and every status reports "no-git".
//
//   node scripts/repo-map.mjs status <root> [path-or-folder ...]
//       prints the reusable entries, the stale paths to refresh, and the unmapped files (up to 200)
//   node scripts/repo-map.mjs write <root> <entries.json>
//       validates {"entries": [...]} and stores it; exits 1 and prints the reasons if anything is refused
//
// The map records facts about code, not values. Secret-looking files and anything under .claude/ are refused.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, posix } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 1;
export const MAP_PATH = '.claude/repo-map/map.json';
const MAX_BUFFER = 64 * 1024 * 1024;
const STATUSES = new Set(['verified', 'unverified']);
const SHA = /^[0-9a-f]{40}$/;
const PLUGIN_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SECRET = /^(\.env(\..+)?|.*\.(pem|key|p12|pfx)|id_(rsa|ecdsa|ed25519)|credentials(\.json)?)$/i;
const SECRET_EXEMPT = /\.(example|sample|template)$/i;

function git(cwd, args) {
  return execFileSync('git', args, { cwd, maxBuffer: MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] }).toString('utf8');
}

export function headSha(root) {
  try {
    const sha = git(root, ['rev-parse', 'HEAD']).trim();
    return SHA.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

export function isSecretPath(path) {
  if (path === '.claude' || path.startsWith('.claude/')) return true;
  const base = posix.basename(path);
  return SECRET.test(base) && !SECRET_EXEMPT.test(base);
}

// The list of files that exist now and are not ignored, as repo-relative paths, excluding .claude/.
export function listFiles(root) {
  return git(root, ['ls-files', '-z', '--cached', '--others', '--exclude-standard'])
    .split('\0')
    .filter((file) => file !== '' && !file.startsWith('.claude/'));
}

// Paths with an uncommitted change (modified, added, deleted, or untracked).
function dirtyPaths(root) {
  const dirty = new Set();
  for (const record of git(root, ['status', '--porcelain', '-z', '--no-renames', '--untracked-files=all']).split('\0')) {
    if (record.length > 3) dirty.add(record.slice(3));
  }
  return dirty;
}

// Paths changed by commits after `sha` up to HEAD, or null when git cannot say (unknown or rewritten sha).
function changedSince(root, sha, head) {
  try {
    return new Set(git(root, ['diff', '--name-only', '-z', sha, head]).split('\0').filter(Boolean));
  } catch {
    return null;
  }
}

export function validateEntry(entry) {
  if (!entry || typeof entry !== 'object') return ['entry is not an object'];
  const errors = [];
  const { path } = entry;
  if (typeof path !== 'string' || path === '') {
    errors.push('path is required');
  } else if (posix.isAbsolute(path) || path.includes('\\') || path.startsWith('./') || posix.normalize(path).split('/').includes('..')) {
    errors.push(`path must be relative and inside the repository: ${path}`);
  } else if (isSecretPath(path)) {
    errors.push(`secret-looking paths are never mapped: ${path}`);
  }
  if (typeof entry.area !== 'string' || entry.area.length < 1 || entry.area.length > 40) errors.push('area must be 1 to 40 characters');
  if (typeof entry.summary !== 'string' || entry.summary.length < 1 || entry.summary.length > 300) errors.push('summary must be 1 to 300 characters');
  if (entry.exports !== undefined && (!Array.isArray(entry.exports) || entry.exports.length > 50 || entry.exports.some((x) => typeof x !== 'string' || x.length > 120))) {
    errors.push('exports must be up to 50 strings of up to 120 characters');
  }
  if (!STATUSES.has(entry.status)) errors.push('status must be verified or unverified');
  if (entry.mappedBy !== undefined && !(typeof entry.mappedBy === 'string' && PLUGIN_NAME.test(entry.mappedBy))) errors.push('mappedBy must be a plugin name');
  if (entry.sha !== undefined && !(typeof entry.sha === 'string' && SHA.test(entry.sha))) errors.push('sha must be a full commit sha');
  return errors;
}

// The stored entries. A file that is missing, malformed, or from another schema reads as an empty map.
export function readMap(root) {
  const file = join(root, MAP_PATH);
  if (!existsSync(file)) return { schema: SCHEMA, entries: [] };
  try {
    const data = JSON.parse(readFileSync(file, 'utf8'));
    if (data?.schema !== SCHEMA || !Array.isArray(data.entries)) return { schema: SCHEMA, entries: [] };
    return { schema: SCHEMA, entries: data.entries.filter((e) => validateEntry(e).length === 0 && e.sha) };
  } catch {
    return { schema: SCHEMA, entries: [] };
  }
}

// Splits stored entries into those still true at HEAD and those that need mapping again. Entries for files
// that no longer exist are dropped.
export function freshness(root, entries) {
  const head = headSha(root);
  if (!head) return null;
  const present = new Set(listFiles(root));
  const dirty = dirtyPaths(root);
  const diffs = new Map();
  const reuse = [];
  const stale = [];
  const removed = [];
  for (const entry of entries) {
    if (!present.has(entry.path)) {
      removed.push(entry.path);
      continue;
    }
    if (!diffs.has(entry.sha)) diffs.set(entry.sha, changedSince(root, entry.sha, head));
    const changed = diffs.get(entry.sha);
    const current = changed !== null && !changed.has(entry.path) && !dirty.has(entry.path);
    (current ? reuse : stale).push(current ? entry : entry.path);
  }
  return { sha: head, reuse, stale, removed };
}

function matches(path, want) {
  if (want === '' || want === '.') return true;
  const folder = want.endsWith('/') ? want : `${want}/`;
  return path === want || path.startsWith(folder);
}

export function status(root, wants = ['.']) {
  const fresh = freshness(root, readMap(root).entries);
  if (!fresh) return { status: 'no-git', sha: null, reuse: [], stale: [], unmapped: 0, unmappedPaths: [] };
  const want = (path) => wants.some((w) => matches(path, w));
  const mapped = new Set(readMap(root).entries.map((e) => e.path));
  const reuse = fresh.reuse.filter((e) => want(e.path));
  const stale = fresh.stale.filter(want);
  const unmappedPaths = listFiles(root).filter((p) => want(p) && !mapped.has(p));
  return { status: 'ok', sha: fresh.sha, reuse, stale, unmapped: unmappedPaths.length, unmappedPaths: unmappedPaths.slice(0, 200) };
}

// Stores the incoming entries, merged by path, after checking every one. Nothing is written if any is refused.
export function writeEntries(root, incoming) {
  const head = headSha(root);
  if (!head) return { ok: false, errors: ['no git repository: nothing is cached without git'] };
  if (!Array.isArray(incoming)) return { ok: false, errors: ['entries must be an array'] };
  const errors = incoming.flatMap((entry, i) => validateEntry(entry).map((message) => `entry ${i}: ${message}`));
  const present = new Set(listFiles(root));
  for (const entry of incoming) {
    if (entry && typeof entry.path === 'string' && !present.has(entry.path)) errors.push(`not a file in the repository: ${entry.path}`);
  }
  if (errors.length > 0) return { ok: false, errors };

  const byPath = new Map(readMap(root).entries.map((e) => [e.path, e]));
  for (const entry of incoming) {
    byPath.set(entry.path, {
      path: entry.path,
      area: entry.area,
      summary: entry.summary,
      exports: entry.exports ?? [],
      status: entry.status,
      mappedBy: entry.mappedBy ?? null,
      sha: entry.sha ?? head,
    });
  }
  const entries = [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
  const file = join(root, MAP_PATH);
  mkdirSync(join(root, '.claude', 'repo-map'), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  writeFileSync(temp, `${JSON.stringify({ schema: SCHEMA, entries }, null, 2)}\n`);
  renameSync(temp, file);
  return { ok: true, written: incoming.length, total: entries.length };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const [command, root, ...rest] = process.argv.slice(2);
  if (!command || !root || !['status', 'write'].includes(command)) {
    process.stderr.write('usage: repo-map.mjs status <root> [path ...]  |  repo-map.mjs write <root> <entries.json>\n');
    process.exit(2);
  }
  if (command === 'status') {
    process.stdout.write(`${JSON.stringify(status(root, rest))}\n`);
  } else {
    if (!rest[0]) {
      process.stderr.write('write needs the entries file\n');
      process.exit(2);
    }
    let incoming;
    try {
      incoming = JSON.parse(readFileSync(rest[0], 'utf8')).entries;
    } catch (err) {
      process.stdout.write(`${JSON.stringify({ ok: false, errors: [`cannot read entries: ${err.message}`] })}\n`);
      process.exit(1);
    }
    const result = writeEntries(root, incoming);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (!result.ok) process.exit(1);
  }
}
