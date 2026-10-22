// The self-test, run once in full. With Chromium it must pass: 13 of 13 planted defects, no finding on
// the clean control, and a report that reproduces. Without it, the browser suites are reported as not
// run, and the verdict is incomplete, never pass.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

import { browserReadiness, renderScorecard, runSelfTest } from '../scripts/self-test.mjs';

const PLAYWRIGHT = [process.env.E2E_PLAYWRIGHT_MODULE, '/opt/node22/lib/node_modules/playwright'].filter(Boolean).find((p) => existsSync(p)) ?? null;
const browser = await browserReadiness(PLAYWRIGHT);

test('the self-test scores the plugin on its fixture', async () => {
  const card = await runSelfTest({ playwrightModule: PLAYWRIGHT, now: '2026-10-22T00:00:00.000Z' });
  assert.deepEqual(card.problems, []);
  assert.deepEqual(card.clean.findings, []);
  assert.deepEqual(card.planted.unexplained, []);
  assert.equal(card.flaky.state, 'flaky');
  assert.equal(card.flaky.defectsOpened, 0);
  assert.equal(card.report.ok, true);
  if (browser.available) {
    assert.equal(card.verdict, 'pass');
    assert.equal(card.recall, '13 of 13');
    assert.equal(card.clean.gate, 'PASS');
  } else {
    assert.equal(card.verdict, 'incomplete');
    assert.deepEqual(card.notRun, [1, 8, 9, 10, 12]);
    assert.match(card.suites.web, /^not run: /);
  }
  assert.match(renderScorecard(card), /^# e2e-engineer self-test/);
});
