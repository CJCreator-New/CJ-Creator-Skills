import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide, isOwned, readOwnership } from '../hooks/guard-file-ownership.mjs';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../hooks/guard-file-ownership.mjs');

function projectWithOwnership(content) {
  const dir = mkdtempSync(join(tmpdir(), 'fe-guard-'));
  if (content !== undefined) {
    mkdirSync(join(dir, '.claude', 'frontend-engineer'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'frontend-engineer', 'ownership.json'), content);
  }
  return dir;
}

function write(filePath, cwd, tool = 'Write') {
  return { tool_name: tool, tool_input: { file_path: filePath }, cwd };
}

test('inert when no ownership file exists', () => {
  const dir = projectWithOwnership();
  try {
    assert.deepEqual(decide(write('src/anything.ts', dir), {}), { allow: true });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('inert when the ownership file is malformed', () => {
  const dir = projectWithOwnership('{ not json');
  try {
    assert.deepEqual(decide(write('src/anything.ts', dir), {}), { allow: true });
    assert.equal(readOwnership(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('allows files inside owned folders and exact owned files', () => {
  const dir = projectWithOwnership(JSON.stringify({ owned: ['src/components/Card/', 'src/pages/home.tsx'] }));
  try {
    assert.equal(decide(write('src/components/Card/index.tsx', dir), {}).allow, true);
    assert.equal(decide(write('src/pages/home.tsx', dir), {}).allow, true);
    assert.equal(decide(write(join(dir, 'src/pages/home.tsx'), dir), {}).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('denies files outside the list, with a reason', () => {
  const dir = projectWithOwnership(JSON.stringify({ owned: ['src/components/Card/'] }));
  try {
    const verdict = decide(write('src/routes.ts', dir), {});
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /not in this frontend-engineer run's file list/);
    assert.equal(decide(write('src/components/CardExtra.tsx', dir), {}).allow, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('denies paths that escape the project', () => {
  const dir = projectWithOwnership(JSON.stringify({ owned: ['src/'] }));
  try {
    assert.equal(decide(write('../outside.ts', dir), {}).allow, false);
    assert.equal(decide(write('/etc/hosts', dir), {}).allow, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an empty owned list denies every write while the run is active', () => {
  const dir = projectWithOwnership(JSON.stringify({ owned: [] }));
  try {
    assert.equal(decide(write('src/a.ts', dir), {}).allow, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('ignores other tools and writes without a file path', () => {
  const dir = projectWithOwnership(JSON.stringify({ owned: [] }));
  try {
    assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, cwd: dir }, {}).allow, true);
    assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'ls' }, cwd: dir }, {}).allow, true);
    assert.equal(decide({ tool_name: 'Write', tool_input: {}, cwd: dir }, {}).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('isOwned normalises ./ prefixes and Windows separators in entries', () => {
  assert.equal(isOwned('src/a/b.ts', '/proj', ['./src/a/']), true);
  assert.equal(isOwned('src/a/b.ts', '/proj', ['src\\a\\']), true);
  assert.equal(isOwned('src/ab.ts', '/proj', ['src/a']), false);
});

test('hook process exits 2 with the reason on stderr, and 0 when allowed', () => {
  const dir = projectWithOwnership(JSON.stringify({ owned: ['src/ok.ts'] }));
  try {
    const denied = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(write('src/nope.ts', dir)),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /src\/nope\.ts/);

    const allowed = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(write('src/ok.ts', dir)),
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(allowed.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hook fails open on malformed stdin', () => {
  const result = spawnSync(process.execPath, [HOOK], { input: '{nope', encoding: 'utf8' });
  assert.equal(result.status, 0);
});
