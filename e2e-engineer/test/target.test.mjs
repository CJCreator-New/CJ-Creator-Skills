// The target lifecycle (start, health, stop), the app readiness intake records, and the consented
// .gitignore line.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seededDatabase } from './helpers.mjs';
import { addGitignore, checkHealth, gitignoreStatus, startTarget, stopTarget } from '../scripts/target.mjs';
import { appReadiness } from '../scripts/intake.mjs';
import { validateRun } from '../scripts/safety.mjs';

const SERVER = fileURLToPath(new URL('../fixtures/planted-app/server.mjs', import.meta.url));

function repo() {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-target-'));
  execFileSync('git', ['init', '-q'], { cwd: dir });
  return dir;
}

describe('the .gitignore line', () => {
  test('reports that run state is not ignored, adds the line once, and then reports it ignored', () => {
    const dir = repo();
    try {
      writeFileSync(join(dir, '.gitignore'), 'node_modules/');
      assert.equal(gitignoreStatus(dir).ignored, false);
      assert.equal(addGitignore(dir).changed, true);
      assert.equal(gitignoreStatus(dir).ignored, true);
      assert.equal(addGitignore(dir).changed, false, 'adding twice changes nothing');
      assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), 'node_modules/\n# e2e-engineer run state and evidence\n.claude/e2e-engineer/\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('outside git there is nothing to commit, so nothing is added', () => {
    const dir = mkdtempSync(join(tmpdir(), 'e2e-target-'));
    try {
      assert.deepEqual(addGitignore(dir), { changed: false, git: false, ignored: true, reason: 'not a git repository' });
      assert.equal(existsSync(join(dir, '.gitignore')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('app readiness', () => {
  test('a web target with neither a start command nor a health URL is blocked; either one is enough', () => {
    assert.equal(appReadiness({ targets: { web: {} } }).status, 'blocked');
    assert.match(appReadiness({ targets: { web: {} } }).reason, /no start command or healthUrl/);
    assert.equal(appReadiness({ targets: { web: {} }, healthUrl: 'http://127.0.0.1:1/health' }).status, 'ready');
    assert.equal(appReadiness({ targets: { web: {} }, start: 'npm start' }).status, 'ready');
    assert.equal(appReadiness({ targets: { android: {} } }), null, 'a native-only run has no web app to start');
  });

  test('a health URL off the allowlist is refused like any target', () => {
    const config = { name: 'x', targets: { web: { baseUrl: 'http://127.0.0.1:4173' } }, healthUrl: 'http://example.com/health', allowlist: { hosts: ['127.0.0.1'] } };
    assert.ok(validateRun(config).problems.includes('healthUrl: host "example.com" is not on the allowlist'));
  });
});

describe('health checks', () => {
  test('two failures in a row fail the check; a pass at either attempt is healthy', async () => {
    let calls = 0;
    const flaky = async () => {
      calls += 1;
      if (calls === 1) throw new Error('connection refused');
      return new Response('ok');
    };
    assert.deepEqual(await checkHealth({ healthUrl: 'http://127.0.0.1:1/health' }, { fetchImpl: flaky, pauseMs: 1 }), { healthy: true, attempts: 2 });
    const down = async () => {
      throw new Error('connection refused');
    };
    const result = await checkHealth({ healthUrl: 'http://127.0.0.1:1/health' }, { fetchImpl: down, pauseMs: 1 });
    assert.equal(result.healthy, false);
    assert.match(result.reason, /failed its health check twice: connection refused/);
    assert.equal((await checkHealth({})).healthy, null);
  });
});

describe('start and stop', () => {
  test('starts the declared command, waits until healthy, and stops it', async () => {
    const db = seededDatabase();
    const port = 4300 + Math.floor(Math.random() * 500);
    const config = {
      ...db.config,
      targets: { web: { baseUrl: `http://127.0.0.1:${port}` } },
      allowlist: { ...db.config.allowlist, hosts: ['127.0.0.1'] },
      start: `node "${SERVER}"`,
      startEnv: { PORT: String(port), DB_FILE: db.file, PLANTED: 'none' },
      healthUrl: `http://127.0.0.1:${port}/health`,
    };
    try {
      const started = await startTarget({ config, root: db.root, waitSeconds: 15 });
      assert.equal(started.started, true);
      assert.equal((await checkHealth(config)).healthy, true);
      await assert.rejects(startTarget({ config, root: db.root }), /already recorded as started/);
      assert.equal(stopTarget({ root: db.root }).stopped, true);
      await new Promise((done) => setTimeout(done, 300));
      assert.equal((await checkHealth(config, { pauseMs: 1, timeoutMs: 500 })).healthy, false);
    } finally {
      stopTarget({ root: db.root });
      db.cleanup();
    }
  });

  test('without a start command the skill does not guess one', async () => {
    const db = seededDatabase();
    try {
      await assert.rejects(startTarget({ config: { ...db.config, healthUrl: 'http://127.0.0.1:1/health' }, root: db.root }), /does not guess one/);
    } finally {
      db.cleanup();
    }
  });
});
