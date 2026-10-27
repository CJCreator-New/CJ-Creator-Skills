import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide, isShellWrite, readOwnership } from '../hooks/guard-file-ownership.mjs';
import { covers } from '../scripts/ownership.mjs';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../hooks/guard-file-ownership.mjs');
const SUBAGENT = { agent_id: 'a1', agent_type: 'frontend-engineer:implementer' };
const READ_ONLY = { agent_id: 'a2', agent_type: 'frontend-engineer:visual-qa' };

function projectWithOwnership(content) {
  const dir = mkdtempSync(join(tmpdir(), 'fe-guard-'));
  if (content !== undefined) {
    mkdirSync(join(dir, '.claude', 'frontend-engineer'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'frontend-engineer', 'ownership.json'), content);
  }
  return dir;
}

function withProject(content, fn) {
  const dir = projectWithOwnership(content);
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const write = (filePath, cwd, extra = {}) => ({ tool_name: 'Write', tool_input: { file_path: filePath }, cwd, ...extra });
const bash = (command, cwd, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd, ...extra });

test('inert when no ownership file exists', () => {
  withProject(undefined, (dir) => {
    assert.deepEqual(decide(write('src/anything.ts', dir), {}), { allow: true });
    assert.deepEqual(decide(bash('echo x > src/a.ts', dir), {}), { allow: true });
  });
});

test('inert when the ownership file is malformed', () => {
  withProject('{ not json', (dir) => {
    assert.deepEqual(decide(write('src/anything.ts', dir), {}), { allow: true });
    assert.equal(readOwnership(dir), null);
  });
});

test('allows files inside owned folders and exact owned files, relative or absolute', () => {
  withProject(JSON.stringify({ owned: ['src/components/Card/', 'src/pages/home.tsx'] }), (dir) => {
    assert.equal(decide(write('src/components/Card/index.tsx', dir), {}).allow, true);
    assert.equal(decide(write('src/pages/home.tsx', dir), {}).allow, true);
    assert.equal(decide(write(join(dir, 'src/pages/home.tsx'), dir), {}).allow, true);
  });
});

test('denies files outside the list, with a reason', () => {
  withProject(JSON.stringify({ owned: ['src/components/Card/'] }), (dir) => {
    const verdict = decide(write('src/routes.ts', dir), {});
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /not in this frontend-engineer run's file list/);
    assert.equal(decide(write('src/components/CardExtra.tsx', dir), {}).allow, false);
  });
});

test('denies paths that escape the project', () => {
  withProject(JSON.stringify({ owned: ['src/'] }), (dir) => {
    assert.equal(decide(write('../outside.ts', dir), {}).allow, false);
    assert.equal(decide(write('/etc/hosts', dir), {}).allow, false);
  });
});

test('an empty owned list denies every write while the run is active', () => {
  withProject(JSON.stringify({ owned: [] }), (dir) => {
    assert.equal(decide(write('src/a.ts', dir), {}).allow, false);
  });
});

test('ignores other tools and writes without a file path', () => {
  withProject(JSON.stringify({ owned: [] }), (dir) => {
    assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: 'src/a.ts' }, cwd: dir }, {}).allow, true);
    assert.equal(decide(bash('ls -la', dir), {}).allow, true);
    assert.equal(decide({ tool_name: 'Write', tool_input: {}, cwd: dir }, {}).allow, true);
  });
});

test('ownership paths normalise ./ prefixes and Windows separators', () => {
  assert.equal(covers(['./src/a/'], 'src/a/b.ts', '/proj'), true);
  assert.equal(covers(['src\\a\\'], 'src/a/b.ts', '/proj'), true);
  assert.equal(covers(['src/a'], 'src/ab.ts', '/proj'), false);
});

test('subagent writes are checked against the list', () => {
  withProject(JSON.stringify({ owned: ['src/ok.ts'] }), (dir) => {
    assert.equal(decide({ ...write('src/ok.ts', dir), ...SUBAGENT }, {}).allow, true);
    assert.equal(decide({ ...write('src/other.ts', dir), ...SUBAGENT }, {}).allow, false);
  });
});

test('subagents cannot write the run state; the orchestrator can', () => {
  withProject(JSON.stringify({ owned: ['src/ok.ts'] }), (dir) => {
    const state = '.claude/frontend-engineer/state.json';
    assert.equal(decide({ ...write(state, dir), ...SUBAGENT }, {}).allow, false);
    assert.equal(decide(write(state, dir), {}).allow, true);
  });
});

test('the orchestrator is held to the list for product files', () => {
  withProject(JSON.stringify({ owned: ['src/ok.ts'] }), (dir) => {
    assert.equal(decide(write('src/other.ts', dir), {}).allow, false);
    assert.equal(decide(write('src/ok.ts', dir), {}).allow, true);
  });
});

test('read-only agents cannot write, with a tool, with no run active', () => {
  withProject(undefined, (dir) => {
    const verdict = decide({ ...write('src/a.ts', dir), ...READ_ONLY }, {});
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /read-only/);
  });
});

test('read-only agents cannot write through the shell', () => {
  withProject(undefined, (dir) => {
    assert.equal(decide({ ...bash('echo x > evidence.txt', dir), ...READ_ONLY }, {}).allow, false);
    assert.equal(decide({ ...bash('npm test', dir), ...READ_ONLY }, {}).allow, true);
  });
});

test('subagents cannot write through the shell while a run is active', () => {
  withProject(JSON.stringify({ owned: ['src/ok.ts'] }), (dir) => {
    for (const command of ['echo x > src/a.ts', 'echo x >> src/a.ts', 'tee out.txt', 'sed -i s/a/b/ src/a.ts', 'git checkout -- src/a.ts', 'cp a b', 'mv a b', 'rm -rf src/x']) {
      const verdict = decide({ ...bash(command, dir), ...SUBAGENT }, {});
      assert.equal(verdict.allow, false, command);
      assert.match(verdict.reason, /Shell writes are blocked/);
    }
  });
});

test('subagent shell commands that only read or report are allowed during a run', () => {
  withProject(JSON.stringify({ owned: ['src/ok.ts'] }), (dir) => {
    for (const command of ['npm test 2>&1', 'npx vitest run > /dev/null 2>&1', 'npx tsc --noEmit 2>/dev/null', 'npm install', 'git diff --stat', 'cat src/a.ts | grep foo']) {
      assert.equal(decide({ ...bash(command, dir), ...SUBAGENT }, {}).allow, true, command);
    }
  });
});

test('subagent shell writes are allowed when no run is active', () => {
  withProject(undefined, (dir) => {
    assert.equal(decide({ ...bash('echo x > src/a.ts', dir), ...SUBAGENT }, {}).allow, true);
  });
});

test('the orchestrator (no agent id) may use shell redirection during a run', () => {
  withProject(JSON.stringify({ owned: ['src/ok.ts'] }), (dir) => {
    assert.equal(decide(bash('node gates.mjs run lint -- "npm run lint" > log.txt', dir), {}).allow, true);
  });
});

test('shell write detection', () => {
  for (const cmd of ['echo a > f', 'echo a>>f', 'cat <<EOF > f', 'tee f', 'sed -i "" f', 'sed -E -i s/a/b/ f', 'perl -pi -e s/a/b/ f', 'git stash', 'rm f', 'cp a b']) {
    assert.equal(isShellWrite(cmd), true, cmd);
  }
  for (const cmd of ['npm test 2>&1', 'npm test >/dev/null 2>&1', 'npm run build', 'npm install', 'git status', 'git diff', 'grep "a" file', 'echo "x=>y"', 'echo "x->y"', 'sed -n 1,5p f']) {
    assert.equal(isShellWrite(cmd), false, cmd);
  }
});

test('hook process exits 2 with the reason on stderr, and 0 when allowed', () => {
  withProject(JSON.stringify({ owned: ['src/ok.ts'] }), (dir) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    const denied = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(write('src/nope.ts', dir)), env, encoding: 'utf8' });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /src\/nope\.ts/);

    const allowed = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(write('src/ok.ts', dir)), env, encoding: 'utf8' });
    assert.equal(allowed.status, 0);
  });
});

test('hook fails open on malformed stdin', () => {
  const result = spawnSync(process.execPath, [HOOK], { input: '{nope', encoding: 'utf8' });
  assert.equal(result.status, 0);
});
