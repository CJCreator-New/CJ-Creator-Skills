// The shared repo map, tested against real git repositories in temporary folders.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { status, writeEntries, validateEntry, readMap, MAP_PATH } from '../backend-engineer/scripts/repo-map.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function run(cwd, args) {
  return execFileSync('git', args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] }).toString('utf8').trim();
}

// A repository with a few committed files, and a helper to commit a change to one of them.
function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), 'repo-map-'));
  run(dir, ['init', '-q']);
  run(dir, ['config', 'user.email', 'test@example.test']);
  run(dir, ['config', 'user.name', 'test']);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(dir, dirname(path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  run(dir, ['add', '-A']);
  run(dir, ['commit', '-q', '-m', 'initial']);
  return dir;
}

const commit = (dir, path, text, message = 'change') => {
  writeFileSync(join(dir, path), text);
  run(dir, ['commit', '-qam', message]);
};

const head = (dir) => run(dir, ['rev-parse', 'HEAD']);

function entry(path, extra = {}) {
  return { path, area: 'src', summary: `what ${path} does`, status: 'verified', mappedBy: 'backend-engineer', ...extra };
}

test('without git nothing is cached, and every status says so', () => {
  const dir = mkdtempSync(join(tmpdir(), 'repo-map-nogit-'));
  try {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1;\n');
    assert.equal(status(dir).status, 'no-git');
    const result = writeEntries(dir, [entry('a.ts')]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /no git repository/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('mapped entries are reused, and unmapped files are counted for mapping', () => {
  const dir = repo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n', 'src/c.ts': 'c\n' });
  try {
    assert.equal(writeEntries(dir, [entry('src/a.ts'), entry('src/b.ts')]).ok, true);
    const result = status(dir, ['src']);
    assert.equal(result.status, 'ok');
    assert.equal(result.sha, head(dir));
    assert.deepEqual(result.reuse.map((e) => e.path).sort(), ['src/a.ts', 'src/b.ts']);
    assert.deepEqual(result.stale, []);
    assert.equal(result.unmapped, 1, 'src/c.ts has no entry yet');
    assert.deepEqual(result.unmappedPaths, ['src/c.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a commit to one mapped file refreshes that entry only', () => {
  const dir = repo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  try {
    writeEntries(dir, [entry('src/a.ts'), entry('src/b.ts')]);
    commit(dir, 'src/a.ts', 'a changed\n');
    const result = status(dir, ['src']);
    assert.deepEqual(result.reuse.map((e) => e.path), ['src/b.ts']);
    assert.deepEqual(result.stale, ['src/a.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an uncommitted change to a mapped file makes its entry stale', () => {
  const dir = repo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  try {
    writeEntries(dir, [entry('src/a.ts'), entry('src/b.ts')]);
    writeFileSync(join(dir, 'src/b.ts'), 'edited but not committed\n');
    const result = status(dir, ['src']);
    assert.deepEqual(result.reuse.map((e) => e.path), ['src/a.ts']);
    assert.deepEqual(result.stale, ['src/b.ts']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an entry whose file was deleted is dropped from the reuse list', () => {
  const dir = repo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  try {
    writeEntries(dir, [entry('src/a.ts'), entry('src/b.ts')]);
    run(dir, ['rm', '-q', 'src/b.ts']);
    run(dir, ['commit', '-qm', 'remove b']);
    const result = status(dir, ['src']);
    assert.deepEqual(result.reuse.map((e) => e.path), ['src/a.ts']);
    assert.deepEqual(result.stale, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('writing a path again replaces its entry, and other entries are kept', () => {
  const dir = repo({ 'src/a.ts': 'a\n', 'src/b.ts': 'b\n' });
  try {
    writeEntries(dir, [entry('src/a.ts', { summary: 'first' }), entry('src/b.ts')]);
    writeEntries(dir, [entry('src/a.ts', { summary: 'second' })]);
    const stored = readMap(dir).entries;
    assert.equal(stored.length, 2);
    assert.equal(stored.find((e) => e.path === 'src/a.ts').summary, 'second');
    assert.ok(stored.find((e) => e.path === 'src/b.ts'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a rejected batch writes nothing', () => {
  const dir = repo({ 'src/a.ts': 'a\n' });
  try {
    const result = writeEntries(dir, [entry('src/a.ts'), entry('src/a.ts', { status: 'maybe' })]);
    assert.equal(result.ok, false);
    assert.equal(existsSync(join(dir, MAP_PATH)), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('secret-looking files and anything under .claude are never mapped', () => {
  for (const path of ['.env', 'config/.env.production', 'keys/server.pem', 'id_rsa', 'credentials.json', '.claude/forge/state.json']) {
    assert.match(validateEntry(entry(path))[0] ?? '', /secret-looking|inside the repository/, path);
  }
  assert.deepEqual(validateEntry(entry('.env.example')), [], 'examples are allowed');
});

test('paths must be relative and inside the repository', () => {
  for (const path of ['/etc/passwd', '../outside.ts', 'src/../../x.ts', 'src\\win.ts', './src/a.ts']) {
    assert.ok(validateEntry(entry(path)).length > 0, path);
  }
});

test('field limits and types are enforced', () => {
  assert.ok(validateEntry(entry('src/a.ts', { summary: 'x'.repeat(301) })).length > 0);
  assert.ok(validateEntry(entry('src/a.ts', { exports: Array.from({ length: 51 }, (_, i) => `e${i}`) })).length > 0);
  assert.ok(validateEntry(entry('src/a.ts', { sha: 'not-a-sha' })).length > 0);
  assert.ok(validateEntry(entry('src/a.ts', { mappedBy: 'Not A Plugin' })).length > 0);
  assert.deepEqual(validateEntry(entry('src/a.ts')), []);
});

test('a path that is not a file in the repository is refused', () => {
  const dir = repo({ 'src/a.ts': 'a\n' });
  try {
    const result = writeEntries(dir, [entry('src/missing.ts')]);
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /not a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI writes an entries file and reports the status', () => {
  const dir = repo({ 'src/a.ts': 'a\n' });
  try {
    const file = join(dir, 'entries.json');
    writeFileSync(file, JSON.stringify({ entries: [entry('src/a.ts')] }));
    const script = join(ROOT, 'backend-engineer/scripts/repo-map.mjs');
    const wrote = JSON.parse(execFileSync(process.execPath, [script, 'write', dir, file]).toString());
    assert.equal(wrote.ok, true);
    const reported = JSON.parse(execFileSync(process.execPath, [script, 'status', dir, 'src']).toString());
    assert.equal(reported.reuse.length, 1);
    unlinkSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
