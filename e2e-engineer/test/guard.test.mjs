import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { agentName, decide, relativeTo } from '../hooks/guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOK = resolve(HERE, '../hooks/guard.mjs');

// A project folder, with the active marker when the run is active.
function project({ active }) {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-guard-'));
  if (active) {
    mkdirSync(join(dir, '.claude', 'e2e-engineer'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'e2e-engineer', 'active'), '2026-10-22T00:00:00.000Z');
  }
  return dir;
}

const write = (dir, filePath, agent_type) => ({
  tool_name: 'Write',
  tool_input: { file_path: filePath },
  cwd: dir,
  ...(agent_type ? { agent_type, agent_id: 'a1' } : {}),
});

test('relativeTo keeps paths inside the project and refuses paths outside it', () => {
  assert.equal(relativeTo('/p', 'src/app.js'), 'src/app.js');
  assert.equal(relativeTo('/p', '/p/.claude/e2e-engineer/x.json'), '.claude/e2e-engineer/x.json');
  assert.equal(relativeTo('/p', '../elsewhere.txt'), null);
  assert.equal(relativeTo('/p', '/etc/passwd'), null);
});

test('agentName drops the plugin prefix', () => {
  assert.equal(agentName({ agent_type: 'e2e-engineer:flow-analyst' }), 'flow-analyst');
  assert.equal(agentName({ agent_type: 'api-runner' }), 'api-runner');
  assert.equal(agentName({}), null);
});

test('the guard does nothing when no run is active', () => {
  const dir = project({ active: false });
  try {
    assert.equal(decide(write(dir, 'src/app.js')).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('while a run is active, a write outside the state folder is denied, with the reason', () => {
  const dir = project({ active: true });
  try {
    const verdict = decide(write(dir, 'src/app.js'));
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /writes only under \.claude\/e2e-engineer\/, not src\/app\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('while a run is active, a write under the state folder is allowed', () => {
  const dir = project({ active: true });
  try {
    assert.equal(decide(write(dir, '.claude/e2e-engineer/drafts/flow.json')).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the ledger is never written by a tool, even while the run is active', () => {
  const dir = project({ active: true });
  try {
    assert.match(decide(write(dir, '.claude/e2e-engineer/ledger.json')).reason, /written only by its own commands/);
    assert.match(decide(write(dir, '.claude/e2e-engineer/ledger.json.tmp')).reason, /written only by its own commands/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a secret-looking file is never written, but its example is allowed under the state folder', () => {
  const dir = project({ active: true });
  try {
    assert.match(decide(write(dir, '.claude/e2e-engineer/.env')).reason, /secret file/);
    assert.match(decide(write(dir, '.claude/e2e-engineer/server.key')).reason, /secret file/);
    assert.equal(decide(write(dir, '.claude/e2e-engineer/.env.example')).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an analyst is read-only, whether or not a run is active', () => {
  const dir = project({ active: false });
  try {
    const verdict = decide(write(dir, '.claude/e2e-engineer/drafts/x.json', 'e2e-engineer:flow-analyst'));
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /flow-analyst is read-only/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a runner that is not read-only may write under the state folder', () => {
  const dir = project({ active: true });
  try {
    assert.equal(decide(write(dir, '.claude/e2e-engineer/drafts/x.json', 'e2e-engineer:api-runner')).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a read is not checked, and a shell command is checked only while a run is active', () => {
  assert.equal(decide({ tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } }).allow, true);
  const dir = project({ active: false });
  try {
    assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'rm -rf src' }, cwd: dir }).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('while a run is active, a shell command that writes outside the state folder is denied, with the reason', () => {
  const dir = project({ active: true });
  const bash = (command, agent_type) => decide({ tool_name: 'Bash', tool_input: { command }, cwd: dir, ...(agent_type ? { agent_type } : {}) });
  try {
    for (const [command, reason] of [
      ['echo x > src/app.js', /redirects output to src\/app\.js/],
      ['cat a | tee -a README.md', /tee writes README\.md/],
      ["sed -i 's/a/b/' server.mjs", /sed edits server\.mjs in place/],
      ['rm -rf src', /rm changes src/],
      ['node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" status x && mv a.js b.js', /mv changes a\.js/],
      ['cp .claude/e2e-engineer/x.json public/x.json', /cp changes public\/x\.json/],
      ['git commit -am wip', /changes the git repository/],
      ['npm install axe-core', /installs packages/],
      ['dd if=/dev/zero of=data.db bs=1 count=1', /dd changes data\.db/],
    ]) {
      const verdict = bash(command);
      assert.equal(verdict.allow, false, command);
      assert.match(verdict.reason, reason);
    }
    for (const command of [
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/run-api.mjs" .claude/e2e-engineer/ledger.json qa.config.json --root .',
      'node "${CLAUDE_PLUGIN_ROOT}/scripts/artifacts.mjs" .claude/e2e-engineer/ledger.json .claude/e2e-engineer/report > .claude/e2e-engineer/report.log 2>&1',
      'mkdir -p .claude/e2e-engineer/drafts',
      'cp src/app.js /tmp/copy.js',
      'git status && git diff',
      'grep -rn approve src > /dev/null',
      'ls -la src',
    ]) {
      assert.equal(bash(command).allow, true, command);
    }
    assert.equal(bash('echo x > .claude/e2e-engineer/ledger.json').allow, false, 'the ledger is not written by a redirection either');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an analyst may not write with the shell, even when no run is active', () => {
  const dir = project({ active: false });
  try {
    const verdict = decide({ tool_name: 'Bash', tool_input: { command: 'ls > files.txt' }, cwd: dir, agent_type: 'e2e-engineer:ux-analyst' });
    assert.equal(verdict.allow, false);
    assert.match(verdict.reason, /ux-analyst is read-only, and this command writes/);
    assert.equal(decide({ tool_name: 'Bash', tool_input: { command: 'ls design' }, cwd: dir, agent_type: 'e2e-engineer:ux-analyst' }).allow, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('run as a hook, a denied write exits with status 2 and the reason on stderr', () => {
  const dir = project({ active: true });
  try {
    const input = JSON.stringify(write(dir, 'src/app.js'));
    const result = spawnSync(process.execPath, [HOOK], { input, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /writes only under/);
    const allowed = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(write(dir, '.claude/e2e-engineer/x.json')), encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: dir } });
    assert.equal(allowed.status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
