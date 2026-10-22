import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describeBinary, isNativeBinary } from '../scripts/binary.mjs';

test('native binaries are recognised by extension, case-insensitively', () => {
  assert.equal(isNativeBinary('builds/orders.apk'), true);
  assert.equal(isNativeBinary('builds/orders.AAB'), true);
  assert.equal(isNativeBinary('builds/Orders.ipa'), true);
  assert.equal(isNativeBinary('builds/orders.zip'), false);
});

test('a binary is hashed by streaming its bytes', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-binary-'));
  try {
    const file = join(dir, 'orders.apk');
    writeFileSync(file, 'abc');
    const described = await describeBinary(file);
    assert.equal(described.bytes, 3);
    assert.equal(described.sha256, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a file that is not a native binary, or a directory, is refused', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-binary-'));
  try {
    const text = join(dir, 'notes.txt');
    writeFileSync(text, 'abc');
    await assert.rejects(describeBinary(text), /not a native binary/);
    const folder = join(dir, 'orders.apk');
    mkdirSync(folder);
    await assert.rejects(describeBinary(folder), /is not a file/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
