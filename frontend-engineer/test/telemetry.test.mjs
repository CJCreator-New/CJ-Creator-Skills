import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { main, parseEntries, record, summarize, telemetryPath, toEntry } from '../scripts/telemetry.mjs';

const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts/telemetry.mjs');

test('stage durations come from start and end pairs', () => {
  const summary = summarize([
    { type: 'start', stage: 'implement', ts: '2026-10-22T10:00:00.000Z' },
    { type: 'end', stage: 'implement', ts: '2026-10-22T10:02:30.000Z' },
  ]);
  assert.equal(summary.stageMs.implement, 150000);
});

test('an end without a start is ignored', () => {
  const summary = summarize([{ type: 'end', stage: 'verify', ts: '2026-10-22T10:00:00.000Z' }]);
  assert.deepEqual(summary.stageMs, {});
});

test('tokens are unavailable unless the harness reported them', () => {
  assert.equal(summarize([]).tokens, 'unavailable');
  const summary = summarize([
    { type: 'tokens', agent: 'implementer', input: 1000, output: 200 },
    { type: 'tokens', agent: 'test-author', input: 500, output: 100 },
  ]);
  assert.deepEqual(summary.tokens, { input: 1500, output: 300, reportedCalls: 2 });
});

test('defects are counted by severity and fixed separately', () => {
  const summary = summarize([
    { type: 'defect', severity: 'high', fixed: false },
    { type: 'defect', severity: 'high', fixed: true },
    { type: 'defect', severity: 'low', fixed: true },
    { type: 'defect', severity: 'unknown', fixed: true },
  ]);
  assert.deepEqual(summary.defects.high, { found: 2, fixed: 1 });
  assert.deepEqual(summary.defects.low, { found: 1, fixed: 1 });
  assert.deepEqual(summary.defects.critical, { found: 0, fixed: 0 });
});

test('iterations are counted', () => {
  assert.equal(summarize([{ type: 'iteration' }, { type: 'iteration' }]).iterations, 2);
});

test('toEntry validates its input and rejects estimates', () => {
  assert.throws(() => toEntry('start', []), /needs a stage name/);
  assert.throws(() => toEntry('tokens', ['agent', '12.5', '3']), /non-negative integers/);
  assert.throws(() => toEntry('defect', ['severe']), /severity must be one of/);
  assert.throws(() => toEntry('bogus', []), /usage:/);
  assert.deepEqual(toEntry('defect', ['high', '--fixed']), { type: 'defect', severity: 'high', fixed: true });
});

test('parseEntries skips lines that are not JSON', () => {
  const entries = parseEntries('{"type":"iteration"}\nnot json\n\n{"type":"iteration"}\n');
  assert.equal(entries.length, 2);
});

test('record appends one line per entry under the plugin folder of the project', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe-telemetry-'));
  try {
    const file = telemetryPath(dir);
    record(file, { type: 'iteration' }, new Date('2026-10-22T10:00:00.000Z'));
    record(file, { type: 'iteration' }, new Date('2026-10-22T10:01:00.000Z'));
    const lines = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.equal(lines.length, 2);
    assert.equal(lines[0].ts, '2026-10-22T10:00:00.000Z');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main writes entries and prints a summary from the project directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe-telemetry-'));
  try {
    const env = { CLAUDE_PROJECT_DIR: dir };
    assert.equal(main(['iteration'], env), '');
    assert.equal(main(['defect', 'critical', '--fixed'], env), '');
    const summary = JSON.parse(main(['summary'], env));
    assert.equal(summary.iterations, 1);
    assert.deepEqual(summary.defects.critical, { found: 1, fixed: 1 });
    assert.equal(summary.tokens, 'unavailable');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('CLI exits 1 with the message on bad input', () => {
  const dir = mkdtempSync(join(tmpdir(), 'fe-telemetry-'));
  try {
    const result = spawnSync(process.execPath, [CLI, 'defect', 'severe'], {
      env: { ...process.env, CLAUDE_PROJECT_DIR: dir },
      encoding: 'utf8',
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /severity must be one of/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
