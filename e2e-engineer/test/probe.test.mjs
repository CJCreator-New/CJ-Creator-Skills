import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { hasCommand, probeBrowser, probeIos, targetReadiness } from '../scripts/probe.mjs';

const NONE = {
  browser: { found: false, path: null },
  android: { adb: false, emulatorTool: false, devices: [] },
  ios: { available: false, reason: 'iOS simulators need macOS' },
  automation: { appium: false, maestro: false },
};
const ALL = { web: {}, 'mobile-web': {}, android: {}, ios: {} };

test('with no tools installed, every target is blocked with a reason, and none is skipped', () => {
  const readiness = targetReadiness(NONE, ALL);
  assert.deepEqual(readiness.web, { status: 'blocked', reason: 'no Chromium browser was found' });
  assert.deepEqual(readiness['mobile-web'], { status: 'blocked', reason: 'no Chromium browser was found' });
  assert.deepEqual(readiness.android, { status: 'blocked', reason: 'adb is not installed' });
  assert.deepEqual(readiness.ios, { status: 'blocked', reason: 'iOS simulators need macOS' });
});

test('mobile web is ready when a browser and Playwright are present, because it runs with device emulation', () => {
  const probes = { ...NONE, browser: { found: true, path: '/opt/pw-browsers/chromium-1' }, playwright: { found: true } };
  const readiness = targetReadiness(probes, { 'mobile-web': {} });
  assert.equal(readiness['mobile-web'].status, 'ready');
});

test('Android needs a device or emulator and an automation tool', () => {
  const noDevice = { ...NONE, android: { adb: true, emulatorTool: false, devices: [] }, automation: { appium: true, maestro: false } };
  assert.equal(targetReadiness(noDevice, { android: {} }).android.reason, 'no Android device or emulator is connected');

  const noTool = { ...NONE, android: { adb: true, emulatorTool: true, devices: [] } };
  assert.equal(targetReadiness(noTool, { android: {} }).android.reason, 'neither Appium nor Maestro is installed');

  const ready = { ...NONE, android: { adb: true, emulatorTool: false, devices: ['emulator-5554'] }, automation: { appium: false, maestro: true } };
  assert.deepEqual(targetReadiness(ready, { android: {} }).android, { status: 'ready', devices: ['emulator-5554'] });
});

test('iOS needs macOS, a booted simulator and an automation tool', () => {
  assert.equal(probeIos('linux').available, false);
  assert.equal(probeIos('linux').reason, 'iOS simulators need macOS');
  const noBooted = { ...NONE, ios: { available: true, booted: 0 }, automation: { appium: true, maestro: false } };
  assert.equal(targetReadiness(noBooted, { ios: {} }).ios.reason, 'no iOS simulator is booted');
  const ready = { ...NONE, ios: { available: true, booted: 1 }, automation: { appium: true, maestro: false } };
  assert.deepEqual(targetReadiness(ready, { ios: {} }).ios, { status: 'ready' });
});

test('the browser is found in the Playwright browsers path when it is set', () => {
  const root = mkdtempSync(join(tmpdir(), 'e2e-browsers-'));
  try {
    mkdirSync(join(root, 'chromium-1234'));
    const browser = probeBrowser({ PLAYWRIGHT_BROWSERS_PATH: root, PATH: '' });
    assert.equal(browser.found, true);
    assert.equal(basename(browser.path), 'chromium-1234');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a command is found on the PATH it is given, and not on an empty one', () => {
  const nodeDir = dirname(process.execPath);
  assert.equal(hasCommand(basename(process.execPath), { PATH: nodeDir }), true);
  assert.equal(hasCommand(basename(process.execPath), { PATH: '' }), false);
});
