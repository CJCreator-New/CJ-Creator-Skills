// Finding Playwright, and blocking the web targets when it is missing. None of these tests start a browser.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { findPlaywright } from '../scripts/browser.mjs';
import { targetReadiness } from '../scripts/probe.mjs';

const NONE = {
  browser: { found: true, path: '/opt/pw-browsers/chromium-1' },
  android: { adb: false, emulatorTool: false, devices: [] },
  ios: { available: false, reason: 'iOS simulators need macOS' },
  automation: { appium: false, maestro: false },
};

test('a configured Playwright module that does not exist is reported as missing, with its path', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-pw-'));
  try {
    const found = findPlaywright({ root, config: { browser: { playwrightModule: 'vendor/playwright' } } });
    assert.equal(found.found, false);
    assert.match(found.reason, /browser.playwrightModule .* does not exist/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a configured Playwright module that exists is used as given', () => {
  const found = findPlaywright({ root: tmpdir(), config: { browser: { playwrightModule: '/opt/node22/lib/node_modules/playwright' } } });
  assert.equal(found.found, true);
  assert.equal(found.path, '/opt/node22/lib/node_modules/playwright');
});

test('with no configured module and none in the repository, Playwright is missing, and nothing is installed', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-pw-'));
  try {
    const found = findPlaywright({ root, config: {} });
    assert.equal(found.found, false);
    assert.match(found.reason, /Playwright is not in the repository dependencies; install it there, or set browser.playwrightModule/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('the web targets are blocked, with the reason, when the browser is present but Playwright is not', () => {
  const probes = { ...NONE, playwright: { found: false, reason: 'Playwright is not in the repository dependencies' } };
  const readiness = targetReadiness(probes, { web: {}, 'mobile-web': {} });
  assert.deepEqual(readiness.web, { status: 'blocked', reason: 'Playwright is not in the repository dependencies' });
  assert.equal(readiness['mobile-web'].status, 'blocked');
});

test('the web targets are ready only when both the browser and Playwright are present', () => {
  const readiness = targetReadiness({ ...NONE, playwright: { found: true, path: '/x' } }, { web: {} });
  assert.deepEqual(readiness.web, { status: 'ready' });
});
