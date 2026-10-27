import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runIntake } from '../scripts/intake.mjs';
import { defaultLedgerPath } from '../scripts/ledger.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const EXAMPLE = join(HERE, '../templates/qa.config.example.json');
// An empty PATH hides every tool, so readiness does not depend on the machine running the test.
const NO_TOOLS = { PATH: '' };

function repo({ git = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-intake-'));
  if (git) {
    execFileSync('git', ['init', '-q'], { cwd: root });
    writeFileSync(join(root, 'app.txt'), 'hello');
    execFileSync('git', ['add', '.'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.test', 'commit', '-q', '-m', 'init'], { cwd: root });
  }
  return root;
}

test('a refused config is recorded, with no readiness and no current build', () => {
  const root = repo();
  try {
    const config = JSON.parse(readFileSync(EXAMPLE, 'utf8'));
    config.db.name = 'orders';
    const configPath = join(root, 'qa.config.json');
    writeFileSync(configPath, JSON.stringify(config));
    const { ledgerPath, intake } = runIntake({ root, configPath, env: NO_TOOLS, platform: 'linux' });
    assert.equal(intake.safety.allowed, false);
    assert.deepEqual(intake.readiness, {});
    assert.equal(intake.build.current, false);
    assert.match(intake.build.note, /no git repository/);
    assert.equal(existsSync(ledgerPath), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an allowed config records each target and reports the tools that are missing', () => {
  const root = repo();
  try {
    const configPath = join(root, 'qa.config.json');
    copyFileSync(EXAMPLE, configPath);
    const { intake } = runIntake({ root, configPath, env: NO_TOOLS, platform: 'linux' });
    assert.equal(intake.safety.allowed, true, intake.safety.problems.join('; '));
    assert.deepEqual(Object.keys(intake.targets).sort(), ['android', 'ios', 'mobile-web', 'web']);
    assert.equal(intake.readiness.android.status, 'blocked');
    assert.equal(intake.readiness.android.reason, 'adb is not installed');
    assert.equal(intake.readiness.ios.reason, 'iOS simulators need macOS');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('under version control, the build is identified by its commit and its tree hash', () => {
  const root = repo({ git: true });
  try {
    const configPath = join(root, 'qa.config.json');
    copyFileSync(EXAMPLE, configPath);
    const { intake } = runIntake({ root, configPath, env: NO_TOOLS, platform: 'linux' });
    assert.match(intake.build.commit, /^[0-9a-f]{40}$/);
    assert.match(intake.build.treeHash, /^[0-9a-f]{64}$/);
    assert.equal(intake.build.current, true);
    assert.equal(intake.build.note, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a missing config file is reported as an error, not a crash', () => {
  const root = repo();
  try {
    assert.throws(() => runIntake({ root, configPath: join(root, 'nope.json'), env: NO_TOOLS }), /config not found/);
    assert.equal(existsSync(defaultLedgerPath(root)), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
