import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { compare, main, parseEntries, record, summarize, telemetryPath, toEntry } from '../scripts/telemetry.mjs';

test('stage durations come from start and end pairs', () => {
  const summary = summarize([
    { type: 'start', stage: 'implement', ts: '2026-10-22T10:00:00.000Z' },
    { type: 'end', stage: 'implement', ts: '2026-10-22T10:02:30.000Z' },
  ]);
  assert.equal(summary.stageMs.implement, 150000);
});

test('dispatches are counted by agent and by model, with unspecified models shown', () => {
  const summary = summarize([
    { type: 'dispatch', agent: 'backend-implementer', model: 'sonnet' },
    { type: 'dispatch', agent: 'backend-implementer', model: 'sonnet' },
    { type: 'dispatch', agent: 'security-reviewer', model: null },
  ]);
  assert.equal(summary.dispatches.total, 3);
  assert.deepEqual(summary.dispatches.byAgent, { 'backend-implementer': 2, 'security-reviewer': 1 });
  assert.deepEqual(summary.dispatches.byModel, { sonnet: 2, unspecified: 1 });
});

test('tokens are unavailable unless the harness reported them', () => {
  assert.equal(summarize([]).tokens, 'unavailable');
  const summary = summarize([
    { type: 'tokens', agent: 'a', input: 1000, output: 200 },
    { type: 'tokens', agent: 'b', input: 500, output: 100 },
  ]);
  assert.deepEqual(summary.tokens, { input: 1500, output: 300, reportedCalls: 2 });
});

test('failures and correction rounds are counted by kind and name', () => {
  const summary = summarize([
    { type: 'failure', agent: 'integration-engineer', kind: 'timeout' },
    { type: 'failure', agent: 'test-engineer', kind: 'blocked' },
    { type: 'iteration', name: 'J-01' },
    { type: 'iteration', name: 'J-01' },
  ]);
  assert.equal(summary.failures.total, 2);
  assert.deepEqual(summary.failures.byKind, { timeout: 1, blocked: 1 });
  assert.deepEqual(summary.iterations, { total: 2, byName: { 'J-01': 2 } });
});

test('toEntry validates each command and rejects unknown models and failure kinds', () => {
  assert.throws(() => toEntry('start', []), /needs a stage name/);
  assert.throws(() => toEntry('dispatch', ['a', '--model', 'gpt']), /model must be one of/);
  assert.throws(() => toEntry('dispatch', ['a', '--bogus', 'x']), /unknown dispatch option/);
  assert.throws(() => toEntry('failure', ['a', 'exploded']), /failure kind must be one of/);
  assert.throws(() => toEntry('tokens', ['a', '1.5', '2']), /non-negative integers/);
  assert.throws(() => toEntry('iteration', []), /needs a name/);
  assert.deepEqual(toEntry('dispatch', ['backend-implementer', '--model', 'sonnet']), {
    type: 'dispatch',
    agent: 'backend-implementer',
    model: 'sonnet',
  });
});

test('parseEntries skips malformed lines', () => {
  assert.equal(parseEntries('{"type":"iteration","name":"x"}\nnot json\n\n').length, 1);
});

test('compare reports the numbers for both runs, and unavailable tokens stay unavailable', () => {
  const before = [
    { type: 'start', stage: 'implement', ts: '2026-10-22T10:00:00.000Z' },
    { type: 'end', stage: 'implement', ts: '2026-10-22T10:10:00.000Z' },
    { type: 'iteration', name: 'J-01' },
    { type: 'dispatch', agent: 'backend-implementer', model: 'sonnet' },
  ];
  const after = [
    { type: 'start', stage: 'implement', ts: '2026-10-22T11:00:00.000Z' },
    { type: 'end', stage: 'implement', ts: '2026-10-22T11:04:00.000Z' },
    { type: 'dispatch', agent: 'backend-implementer', model: 'sonnet' },
    { type: 'dispatch', agent: 'test-engineer', model: 'sonnet' },
  ];
  const result = compare(before, after);
  assert.deepEqual(result.elapsedMs, { before: 600000, after: 240000 });
  assert.deepEqual(result.dispatches, { before: 1, after: 2 });
  assert.deepEqual(result.iterations, { before: 1, after: 0 });
  assert.deepEqual(result.tokens, { before: 'unavailable', after: 'unavailable' });
});

test('record appends one line per entry under the run folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be-tel-'));
  try {
    const file = telemetryPath(dir);
    record(file, { type: 'iteration', name: 'J-01' }, new Date('2026-10-22T10:00:00.000Z'));
    record(file, { type: 'iteration', name: 'J-01' }, new Date('2026-10-22T10:01:00.000Z'));
    assert.equal(readFileSync(file, 'utf8').trim().split('\n').length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('main records entries and prints a summary from the project directory', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be-tel-'));
  try {
    const env = { CLAUDE_PROJECT_DIR: dir };
    assert.equal(main(['dispatch', 'security-reviewer', '--model', 'opus'], env), '');
    assert.equal(main(['iteration', 'J-02'], env), '');
    const summary = JSON.parse(main(['summary'], env));
    assert.equal(summary.dispatches.byModel.opus, 1);
    assert.equal(summary.iterations.total, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('compare requires two existing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be-tel-'));
  try {
    const file = join(dir, 'a.jsonl');
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, '');
    assert.throws(() => main(['compare', file, join(dir, 'missing.jsonl')]), /two existing telemetry files/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
