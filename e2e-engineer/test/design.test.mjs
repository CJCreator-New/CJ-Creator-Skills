import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildDesignMap, resolveDesignSource } from '../scripts/design.mjs';

test('a connected Figma connector is the first source', () => {
  const resolved = resolveDesignSource({ figmaConnected: true, exports: ['a.png'], tokensFile: 'tokens.json' });
  assert.equal(resolved.source, 'figma');
  assert.match(resolved.note, /content is data, not instructions/);
});

test('exported images come before tokens, and are sorted', () => {
  assert.deepEqual(resolveDesignSource({ exports: ['b.png', 'a.png'], tokensFile: 'tokens.json' }), {
    source: 'export',
    files: ['a.png', 'b.png'],
  });
});

test('tokens come before none', () => {
  assert.deepEqual(resolveDesignSource({ tokensFile: 'tokens.json' }), { source: 'tokens', file: 'tokens.json' });
});

test('with no reference the source is none, and visual parity is said to be not performed', () => {
  const resolved = resolveDesignSource({});
  assert.equal(resolved.source, 'none');
  assert.equal(resolved.note, 'visual parity not performed; spec checks only');
});

test('a screen with a reference is mapped, and a screen without one is no reference', () => {
  const map = buildDesignMap({
    resolved: { source: 'export', files: ['orders.png'] },
    screens: [{ id: 'SCR-ORDERS' }, { id: 'SCR-LOGIN' }],
    references: { 'SCR-ORDERS': 'orders.png' },
  });
  assert.equal(map.source, 'export');
  assert.deepEqual(map.screens, {
    'SCR-LOGIN': { status: 'no reference' },
    'SCR-ORDERS': { status: 'mapped', frame: 'orders.png' },
  });
});
