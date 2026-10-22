import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decide, isCommittedMigration, isSecretPath, isShellWrite, readOwnership } from '../hooks/guard.mjs';

const HOOK = resolve(dirname(fileURLToPath(import.meta.url)), '../hooks/guard.mjs');
const SUBAGENT = { agent_id: 'a1', agent_type: 'backend-engineer:backend-implementer' };
const READ_ONLY = { agent_id: 'a2', agent_type: 'backend-engineer:security-reviewer' };
const E2E = { agent_id: 'a3', agent_type: 'backend-engineer:e2e-verifier' };

function withProject(fn, { ownership, committed = [] } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'be-guard-'));
  try {
    if (ownership !== undefined) {
      mkdirSync(join(dir, '.claude', 'backend-engineer'), { recursive: true });
      writeFileSync(join(dir, '.claude', 'backend-engineer', 'ownership.json'), ownership);
    }
    if (committed.length) {
      const git = (...args) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
      git('init', '-q');
      for (const file of committed) {
        mkdirSync(join(dir, file, '..'), { recursive: true });
        writeFileSync(join(dir, file), '-- applied\n');
      }
      git('add', '.');
      git('-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'base');
    }
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const write = (filePath, cwd, extra = {}) => ({ tool_name: 'Write', tool_input: { file_path: filePath }, cwd, ...extra });
const bash = (command, cwd, extra = {}) => ({ tool_name: 'Bash', tool_input: { command }, cwd, ...extra });

test('inert when no run is active and the caller is the orchestrator', () => {
  withProject((dir) => {
    assert.deepEqual(decide(write('server/x.ts', dir), {}), { allow: true });
    assert.deepEqual(decide(bash('echo x > server/x.ts', dir), {}), { allow: true });
  });
});

test('secret-bearing files are denied for everyone; examples are allowed', () => {
  withProject((dir) => {
    for (const path of ['.env', '.env.production', 'config/server.pem', 'keys/private.key', 'credentials.json']) {
      assert.equal(decide(write(path, dir), {}).allow, false, path);
    }
    assert.equal(decide(write('.env.example', dir), {}).allow, true);
    assert.equal(decide(write('server/envelope.ts', dir), {}).allow, true);
    assert.equal(isSecretPath('config/.env.local'), true);
  });
});

test('a committed migration is denied; a new migration is allowed', () => {
  withProject((dir) => {
    assert.equal(decide(write('db/migrations/001_init.sql', dir), {}).allow, false);
    assert.match(decide(write('db/migrations/001_init.sql', dir), {}).reason, /committed/);
    assert.equal(decide(write('db/migrations/002_new.sql', dir), {}).allow, true);
  }, { committed: ['db/migrations/001_init.sql'] });
});

test('isCommittedMigration is false outside a git repository', () => {
  withProject((dir) => {
    assert.equal(isCommittedMigration(join(dir, 'db/migrations/001.sql'), dir), false);
  });
});

test('read-only agents cannot write, with a tool or the shell, with or without a run', () => {
  withProject((dir) => {
    assert.equal(decide({ ...write('server/x.ts', dir), ...READ_ONLY }, {}).allow, false);
    assert.equal(decide({ ...bash('echo x > report.md', dir), ...E2E }, {}).allow, false);
    assert.equal(decide({ ...bash('node scripts/ledger.mjs run e2e --scope e2e -- "npm run e2e"', dir), ...E2E }, {}).allow, true);
  });
});

test('subagents may not change the ledger, but may run, validate, status and release it', () => {
  withProject((dir) => {
    for (const command of ['node scripts/ledger.mjs gap G-01 Closed', 'node scripts/ledger.mjs review passed', 'node scripts/ledger.mjs finish', 'node scripts/ledger.mjs set journeys J-01 {}']) {
      assert.equal(decide({ ...bash(command, dir), ...SUBAGENT }, {}).allow, false, command);
    }
    for (const command of ['node scripts/ledger.mjs run test --scope focused -- "npm test"', 'node scripts/ledger.mjs validate', 'node scripts/ledger.mjs status', 'node scripts/ledger.mjs release']) {
      assert.equal(decide({ ...bash(command, dir), ...SUBAGENT }, {}).allow, true, command);
    }
  });
});

test('subagents may not write the run state; the orchestrator may', () => {
  withProject((dir) => {
    const state = '.claude/backend-engineer/ledger.json';
    assert.equal(decide({ ...write(state, dir), ...SUBAGENT }, {}).allow, false);
    assert.equal(decide(write(state, dir), {}).allow, true);
  });
});

test('while a run is active, subagent writes are limited to the owned files', () => {
  withProject((dir) => {
    assert.equal(decide({ ...write('server/expenses/service.ts', dir), ...SUBAGENT }, {}).allow, true);
    assert.equal(decide({ ...write('server/billing/invoice.ts', dir), ...SUBAGENT }, {}).allow, false);
  }, { ownership: JSON.stringify({ owned: ['server/expenses/'] }) });
});

test('while a run is active, the orchestrator is held to the owned files too', () => {
  withProject((dir) => {
    const ownership = JSON.stringify({ owned: ['server/expenses/'] });
    mkdirSync(join(dir, '.claude', 'backend-engineer'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'backend-engineer', 'ownership.json'), ownership);
    assert.equal(decide(write('server/expenses/a.ts', dir), {}).allow, true);
    assert.equal(decide(write('server/other.ts', dir), {}).allow, false);
    assert.equal(decide(write('.claude/backend-engineer/ledger.json', dir), {}).allow, true);
  });
});

test('while a run is active, subagents may not write through the shell', () => {
  withProject((dir) => {
    for (const command of ['echo x > server/a.ts', 'tee out.txt', 'sed -i s/a/b/ server/a.ts', 'git checkout -- server/a.ts']) {
      const verdict = decide({ ...bash(command, dir), ...SUBAGENT }, {});
      assert.equal(verdict.allow, false, command);
    }
    assert.equal(decide({ ...bash('npm test 2>&1', dir), ...SUBAGENT }, {}).allow, true);
  }, { ownership: JSON.stringify({ owned: ['server/'] }) });
});

test('readOwnership treats a malformed file as no run', () => {
  withProject((dir) => {
    mkdirSync(join(dir, '.claude', 'backend-engineer'), { recursive: true });
    writeFileSync(join(dir, '.claude', 'backend-engineer', 'ownership.json'), '{nope');
    assert.equal(readOwnership(dir), null);
  });
});

test('shell write detection', () => {
  for (const cmd of ['echo a > f', 'echo a>>f', 'cat <<EOF > f', 'tee f', 'sed -i "" f', 'perl -pi -e s/a/b/ f', 'git stash', 'rm f']) {
    assert.equal(isShellWrite(cmd), true, cmd);
  }
  for (const cmd of ['npm test 2>&1', 'npm test >/dev/null 2>&1', 'npm install', 'git status', 'echo "x=>y"', 'sed -n 1,5p f']) {
    assert.equal(isShellWrite(cmd), false, cmd);
  }
});

test('the hook process exits 2 with the reason on stderr, and 0 when allowed', () => {
  withProject((dir) => {
    const env = { ...process.env, CLAUDE_PROJECT_DIR: dir };
    const denied = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(write('.env', dir)), env, encoding: 'utf8' });
    assert.equal(denied.status, 2);
    assert.match(denied.stderr, /Secret-bearing/);
    const allowed = spawnSync(process.execPath, [HOOK], { input: JSON.stringify(write('server/a.ts', dir)), env, encoding: 'utf8' });
    assert.equal(allowed.status, 0);
  });
});

test('the hook fails open on malformed stdin', () => {
  assert.equal(spawnSync(process.execPath, [HOOK], { input: '{nope', encoding: 'utf8' }).status, 0);
});
