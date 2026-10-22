import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KIND_TIER, parseArgs, raise, route } from '../scripts/route.mjs';

test('each kind has a default tier, and the defaults are valid tiers', () => {
  for (const [kind, tier] of Object.entries(KIND_TIER)) {
    assert.ok(['haiku', 'sonnet', 'opus'].includes(tier), `${kind} -> ${tier}`);
  }
});

test('low-risk mechanical work stays on haiku, and implementation runs on sonnet', () => {
  assert.equal(route({ kind: 'format' }).model, 'haiku');
  assert.equal(route({ kind: 'crud' }).model, 'sonnet');
});

test('judgment work runs on opus by default', () => {
  for (const kind of ['authorization', 'migration', 'concurrency', 'review']) {
    assert.equal(route({ kind }).model, 'opus', kind);
  }
});

test('medium risk raises haiku work, and high risk runs on opus', () => {
  assert.equal(route({ kind: 'docs', risk: 'medium' }).model, 'sonnet');
  assert.equal(route({ kind: 'crud', risk: 'high' }).model, 'opus');
  assert.match(route({ kind: 'crud', risk: 'high' }).reasons.join(' '), /high risk runs on opus/);
});

test('ambiguity and repeated failure raise one level, and never past opus', () => {
  assert.equal(route({ kind: 'crud', ambiguous: true }).model, 'opus');
  assert.equal(route({ kind: 'format', retries: 2 }).model, 'sonnet');
  assert.equal(route({ kind: 'authorization', ambiguous: true, retries: 5 }).model, 'opus');
  assert.equal(raise('opus'), 'opus');
});

test('one failed attempt does not raise the tier', () => {
  assert.equal(route({ kind: 'crud', retries: 1 }).model, 'sonnet');
});

test('routing never lowers a tier', () => {
  assert.equal(route({ kind: 'security', risk: 'low' }).model, 'opus');
});

test('unknown kinds, risks and retry counts are refused', () => {
  assert.throws(() => route({ kind: 'magic' }), /unknown kind/);
  assert.throws(() => route({ kind: 'crud', risk: 'extreme' }), /risk must be one of/);
  assert.throws(() => route({ kind: 'crud', retries: -1 }), /non-negative integer/);
});

test('parseArgs reads flags and refuses unknown ones', () => {
  assert.deepEqual(parseArgs(['crud', '--risk', 'high', '--ambiguous', '--retries', '2']), {
    kind: 'crud',
    risk: 'high',
    ambiguous: true,
    retries: 2,
  });
  assert.throws(() => parseArgs([]), /usage/);
  assert.throws(() => parseArgs(['crud', '--speed', 'fast']), /unknown option/);
});
