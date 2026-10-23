import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseColor, composite, relativeLuminance, contrastRatio, check } from '../scripts/contrast.mjs';
import { parseArgs, parseViewport, summarizeAxe } from '../scripts/axe-scan.mjs';
import { decide as guard } from '../hooks/guard-file-ownership.mjs';

const SCRIPTS = resolve(dirname(fileURLToPath(import.meta.url)), '../scripts');

test('contrast ratio matches the WCAG reference values', () => {
  const black = parseColor('#000');
  const white = parseColor('#ffffff');
  assert.equal(Math.round(contrastRatio(black, white) * 100) / 100, 21);
  assert.equal(contrastRatio(white, white), 1);
  // Mid grey on white is the usual AA borderline: #767676 passes 4.5:1, #777777 does not.
  assert.equal(check('#767676', '#ffffff').pass, true);
  assert.equal(check('#777777', '#ffffff').pass, false);
  assert.ok(Math.abs(relativeLuminance(parseColor('#808080')) - 0.2159) < 0.001);
});

test('large text needs 3:1 and non-text needs 3:1', () => {
  const result = check('#777777', '#ffffff', { large: true });
  assert.equal(result.required, 3);
  assert.equal(result.pass, true);
  assert.equal(check('#c0c0c0', '#ffffff', { nonText: true }).pass, false);
  assert.equal(check('#949494', '#ffffff', { nonText: true }).pass, true);
});

test('translucent foregrounds are composited over the background first', () => {
  const blended = composite(parseColor('rgba(0, 0, 0, 0.5)'), parseColor('#ffffff'));
  assert.deepEqual([blended.r, blended.g, blended.b], [128, 128, 128]);
  assert.ok(check('rgba(0, 0, 0, 0.5)', '#ffffff').ratio < 4);
});

test('short hex and rgb() notation parse to the same colour', () => {
  assert.deepEqual(parseColor('#abc'), parseColor('#aabbcc'));
  assert.deepEqual(parseColor('rgb(170, 187, 204)'), parseColor('#aabbcc'));
});

test('unsupported and out-of-range colours throw', () => {
  assert.throws(() => parseColor('tomato'), /unsupported colour/);
  assert.throws(() => parseColor('rgb(300, 0, 0)'), /out of range/);
});

test('contrast CLI prints one JSON line and exits 2 on bad usage', () => {
  const ok = spawnSync(process.execPath, [join(SCRIPTS, 'contrast.mjs'), '#777777', '#ffffff'], { encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(JSON.parse(ok.stdout).pass, false);

  const missing = spawnSync(process.execPath, [join(SCRIPTS, 'contrast.mjs'), '#777777'], { encoding: 'utf8' });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /usage/);

  const bad = spawnSync(process.execPath, [join(SCRIPTS, 'contrast.mjs'), 'nope', '#fff'], { encoding: 'utf8' });
  assert.equal(bad.status, 2);
});

test('scan arguments parse, with defaults and validation', () => {
  const opts = parseArgs(['--url', 'http://127.0.0.1:5173/dashboard', '--viewport', 'tablet=768x1024', '--tab', '5']);
  assert.equal(opts.url, 'http://127.0.0.1:5173/dashboard');
  assert.deepEqual(opts.viewports, [{ name: 'tablet', width: 768, height: 1024 }]);
  assert.equal(opts.tab, 5);

  const defaults = parseArgs(['--url', 'https://example.test/']);
  assert.deepEqual(defaults.viewports.map((v) => v.name), ['desktop', 'mobile']);

  assert.throws(() => parseArgs([]), /--url/);
  assert.throws(() => parseArgs(['--url', 'file:///etc/passwd']), /http or https/);
  assert.throws(() => parseViewport('desktop-1440'), /name=WIDTHxHEIGHT/);
  assert.throws(() => parseArgs(['--url', 'http://x', '--tab', '500']), /--tab/);
});

test('an axe result is reduced to rules, impact, targets and counts', () => {
  const summary = summarizeAxe({
    violations: [
      {
        id: 'label',
        impact: 'critical',
        help: 'Form elements must have labels',
        helpUrl: 'https://dequeuniversity.com/rules/axe/label',
        nodes: [{ target: ['#email'] }, { target: ['#phone'] }],
      },
    ],
    incomplete: [{ id: 'color-contrast' }],
    passes: [{}, {}, {}],
  });
  assert.equal(summary.violations[0].id, 'label');
  assert.equal(summary.violations[0].count, 2);
  assert.deepEqual(summary.violations[0].targets, ['#email', '#phone']);
  assert.deepEqual(summary.incomplete, ['color-contrast']);
  assert.equal(summary.passes, 3);
  assert.deepEqual(summarizeAxe(undefined).violations, []);
});

test('the scan CLI exits 0 with "not performed" when the project has no Playwright', () => {
  const dir = mkdtempSync(join(tmpdir(), 'a11y-cli-'));
  try {
    // NODE_PATH is cleared so a global install on this machine cannot satisfy the lookup.
    const env = { ...process.env, NODE_PATH: '' };
    const run = spawnSync(process.execPath, [join(SCRIPTS, 'axe-scan.mjs'), '--url', 'http://127.0.0.1:9/'], {
      cwd: dir,
      encoding: 'utf8',
      env,
    });
    assert.equal(run.status, 0, run.stderr);
    const summary = JSON.parse(run.stdout);
    assert.equal(summary.status, 'not performed');
    assert.match(summary.reason, /playwright was not found from the project/);

    const usage = spawnSync(process.execPath, [join(SCRIPTS, 'axe-scan.mjs')], { cwd: dir, encoding: 'utf8' });
    assert.equal(usage.status, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the accessibility reviewers are read-only under the shared guard', () => {
  const call = (tool_name, tool_input, agent_type) => ({
    tool_name,
    tool_input,
    cwd: '/nonexistent-project',
    agent_type: `frontend-engineer:${agent_type}`,
    agent_id: 'a1',
  });
  for (const agent of ['a11y-static-reviewer', 'a11y-runtime-auditor']) {
    assert.equal(guard(call('Write', { file_path: 'src/a.tsx' }, agent), {}).allow, false, agent);
    assert.equal(guard(call('Bash', { command: 'echo x > evidence.txt' }, agent), {}).allow, false, agent);
    assert.equal(guard(call('Bash', { command: 'node scripts/axe-scan.mjs --url http://x' }, agent), {}).allow, true, agent);
  }
});
