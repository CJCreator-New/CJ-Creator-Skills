import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide, isMutatingCommand, READ_ONLY_AGENTS } from '../hooks/guard-readonly.mjs';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = join(PLUGIN, 'hooks/guard-readonly.mjs');

function projectWithPhase(phase) {
  const dir = mkdtempSync(join(tmpdir(), 'security-audit-'));
  if (phase !== undefined) {
    mkdirSync(join(dir, '.claude', 'security-audit'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'security-audit', 'phase'), `${phase}\n`);
  }
  return dir;
}

const bash = (command, cwd, agent_type) => ({ tool_name: 'Bash', tool_input: { command }, cwd, agent_type });
const write = (file_path, cwd, agent_type) => ({ tool_name: 'Write', tool_input: { file_path }, cwd, agent_type });

test('the hook agent list matches the agent files on disk', () => {
  const onDisk = readdirSync(join(PLUGIN, 'agents'))
    .filter((n) => n.endsWith('.md'))
    .map((n) => n.replace(/\.md$/, ''))
    .sort();
  assert.deepEqual([...READ_ONLY_AGENTS].sort(), onDisk);
});

test('read-only commands are not flagged as mutating', () => {
  for (const cmd of [
    'git diff main...HEAD',
    'git log -S "api_key" --oneline',
    'git ls-files',
    'git show --stat HEAD',
    'git status --short',
    'npm audit --json',
    'pip-audit -f json',
    'cargo audit',
    'grep -rn "eval(" src 2>/dev/null',
    'ls -la 2>&1',
    'command -v govulncheck',
    'cat package.json >&2',
  ]) {
    assert.equal(isMutatingCommand(cmd), false, cmd);
  }
});

test('commands that change files, git state or packages are flagged', () => {
  for (const cmd of [
    'git commit -m x',
    'git push origin main',
    'git checkout -- src/app.ts',
    'git stash',
    'git branch -D old',
    'rm -rf dist',
    'sed -i s/a/b/ config.ts',
    'echo token > out.txt',
    'cat x &> out.txt',
    'npm install lodash',
    'npm ci',
    'npm audit fix',
    'pip install requests',
    'docker build .',
    'curl -X POST https://example.com',
    'eslint . --fix',
  ]) {
    assert.equal(isMutatingCommand(cmd), true, cmd);
  }
});

test('while an audit runs, the main session can write its own report only', () => {
  const dir = projectWithPhase('audit');
  try {
    assert.equal(decide(write(join(dir, '.claude/security-audit/report.md'), dir)).allow, true);
    assert.equal(decide(write(join(dir, '.claude/security-audit/surface.md'), dir)).allow, true);
    assert.equal(decide(write(join(dir, 'src/app.ts'), dir)).allow, false);
    assert.equal(decide(write('../outside.md', dir)).allow, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('while an audit runs, state-changing commands are denied', () => {
  const dir = projectWithPhase('audit');
  try {
    assert.equal(decide(bash('git commit -am "fix"', dir)).allow, false);
    assert.equal(decide(bash('git diff HEAD~1', dir)).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the guard is inert when no audit is running or the audit is done', () => {
  for (const phase of [undefined, 'done']) {
    const dir = projectWithPhase(phase);
    try {
      assert.equal(decide(write(join(dir, 'src/app.ts'), dir)).allow, true, `phase ${phase}`);
      assert.equal(decide(bash('npm install', dir)).allow, true, `phase ${phase}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('audit agents are denied writes and state changes whether or not an audit runs', () => {
  const dir = projectWithPhase(undefined);
  try {
    const agent = 'security-audit:config-reviewer';
    assert.equal(decide(write(join(dir, 'src/app.ts'), dir, agent)).allow, false);
    assert.equal(decide(bash('rm -rf build', dir, agent)).allow, false);
    assert.equal(decide(bash('git ls-files', dir, agent)).allow, true);
    assert.equal(decide(write(join(dir, 'src/app.ts'), dir, 'some-other-agent')).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('malformed input and unknown tools are allowed', () => {
  assert.equal(decide(undefined).allow, true);
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: 'x' } }).allow, true);
});

test('the hook exits 2 with a reason on stderr when it denies, and 0 on malformed input', () => {
  const dir = projectWithPhase('audit');
  try {
    const denied = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify(bash('git push', dir)),
      encoding: 'utf8',
    });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /read-only/);

    const malformed = spawnSync(process.execPath, [HOOK], { input: 'not json', encoding: 'utf8' });
    assert.equal(malformed.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
