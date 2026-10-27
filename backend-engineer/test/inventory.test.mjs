import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { main, scanDir, scanText, walk } from '../scripts/inventory.mjs';
import { loadLedger, main as ledgerMain } from '../scripts/ledger.mjs';
import { withRepo } from './helpers.mjs';

const FORM = `export function ExpenseForm({ onSubmit }) {
  return (
    <form onSubmit={onSubmit}>
      <button onClick={() => save()}>Save</button>
      <Link href="/expenses">Back</Link>
    </form>
  );
}
// the words onClick and href in a comment are not a site
const note = "text about a button";
`;

test('scanText finds handlers, forms, buttons, links and navigation, and ignores plain text', () => {
  const kinds = scanText(FORM).map((s) => s.kind);
  assert.deepEqual(kinds, ['handler', 'form', 'handler', 'button', 'link']);
  assert.equal(scanText('const note = "plain";').length, 0);
  assert.deepEqual(scanText('router.push("/x")').map((s) => s.kind), ['navigate']);
  assert.deepEqual(scanText('<button @click="save">').map((s) => s.kind), ['button', 'vue-event']);
});

test('walk skips dependency and build folders and non-source files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be-inv-'));
  try {
    mkdirSync(join(dir, 'src'), { recursive: true });
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true });
    mkdirSync(join(dir, 'dist'), { recursive: true });
    writeFileSync(join(dir, 'src', 'A.tsx'), FORM);
    writeFileSync(join(dir, 'src', 'readme.md'), '# no');
    writeFileSync(join(dir, 'node_modules', 'x', 'B.tsx'), FORM);
    writeFileSync(join(dir, 'dist', 'C.js'), FORM);
    assert.deepEqual(walk(dir).map((f) => f.slice(dir.length + 1)), ['src/A.tsx']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('scanDir keys the sites by path relative to the project, so they match interaction sources', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be-inv-'));
  try {
    mkdirSync(join(dir, 'src', 'features'), { recursive: true });
    writeFileSync(join(dir, 'src', 'features', 'ExpenseForm.tsx'), FORM);
    const files = scanDir(join(dir, 'src'), dir);
    assert.deepEqual(Object.keys(files), ['src/features/ExpenseForm.tsx']);
    assert.equal(files['src/features/ExpenseForm.tsx'].length, 5);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('record writes the per-file counts into the ledger, and scan prints the sites', () =>
  withRepo((dir) => {
    mkdirSync(join(dir, 'src', 'features'), { recursive: true });
    writeFileSync(join(dir, 'src', 'features', 'ExpenseForm.tsx'), FORM);
    const env = { CLAUDE_PROJECT_DIR: dir };
    ledgerMain(['init'], env);
    const scanned = JSON.parse(main(['scan', join(dir, 'src')], env).out);
    assert.equal(scanned.total, 5);

    assert.match(main(['record', join(dir, 'src')], env).out, /recorded 1 UI file\(s\) with 5 interaction site\(s\)/);
    const inventory = loadLedger(dir).inventory;
    assert.deepEqual(inventory.files, { 'src/features/ExpenseForm.tsx': 5 });
    assert.ok(inventory.recordedAt);
  }));

test('an unknown inventory command is refused', () => {
  assert.throws(() => main(['delete', 'src'], {}), /usage: inventory.mjs scan\|record/);
});
