// Capability probes for intake. Each tool is checked, never assumed. A missing tool makes the
// targets that need it `blocked` with the reason. Nothing is installed here: installs need consent.

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { delimiter, join } from 'node:path';

function run(cmd, args) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10000 });
  } catch {
    return null;
  }
}

export function hasCommand(name, env = process.env) {
  const dirs = (env.PATH || '').split(delimiter).filter(Boolean);
  return dirs.some((dir) => existsSync(join(dir, name)));
}

// Playwright keeps browsers in folders named chromium-<build>. The path is honoured when it is set.
export function probeBrowser(env = process.env) {
  const roots = [env.PLAYWRIGHT_BROWSERS_PATH, '/opt/pw-browsers'].filter(Boolean);
  for (const root of roots) {
    try {
      const found = readdirSync(root).find((entry) => entry.startsWith('chromium'));
      if (found) return { found: true, path: join(root, found) };
    } catch {
      // The root does not exist here. Try the next one.
    }
  }
  for (const name of ['chromium', 'chromium-browser', 'google-chrome']) {
    if (hasCommand(name, env)) return { found: true, path: name };
  }
  return { found: false, path: null };
}

export function probeAndroid(env = process.env) {
  const adb = hasCommand('adb', env);
  const emulatorTool = hasCommand('emulator', env);
  let devices = [];
  if (adb) {
    const out = run('adb', ['devices']) || '';
    devices = out
      .split('\n')
      .slice(1)
      .map((line) => line.trim().split(/\s+/))
      .filter((parts) => parts.length >= 2 && parts[1] === 'device')
      .map((parts) => parts[0]);
  }
  return { adb, emulatorTool, devices };
}

export function probeIos(platform = process.platform) {
  if (platform !== 'darwin') return { available: false, reason: 'iOS simulators need macOS' };
  const xcrun = hasCommand('xcrun');
  if (!xcrun) return { available: false, reason: 'xcrun is not installed' };
  const out = run('xcrun', ['simctl', 'list', 'devices', 'booted']) || '';
  const booted = out.split('\n').filter((line) => /\(Booted\)/.test(line)).length;
  return { available: true, booted };
}

export function probeAutomation(env = process.env) {
  return { appium: hasCommand('appium', env), maestro: hasCommand('maestro', env) };
}

// Probes everything intake needs. The Figma connector is not a process, so the skill checks it at
// intake through the connector list, and the probe only records that it was not checked here.
export function probeAll({ env = process.env, platform = process.platform } = {}) {
  return {
    browser: probeBrowser(env),
    android: probeAndroid(env),
    ios: probeIos(platform),
    automation: probeAutomation(env),
    figma: { checked: false, note: 'checked by the skill at intake through the connector list' },
    platform,
  };
}

// Readiness for each target, from the probe results. A target that needs a missing tool is blocked
// with the reason. A blocked target is reported, never skipped.
export function targetReadiness(probes, targets) {
  const out = {};
  const browserReady = probes.browser.found;
  const webReason = !browserReady
    ? 'no Chromium browser was found'
    : !probes.playwright?.found
      ? probes.playwright?.reason ?? 'Playwright is not available'
      : null;
  if (targets.web) out.web = webReason ? { status: 'blocked', reason: webReason } : { status: 'ready' };
  if (targets['mobile-web']) {
    out['mobile-web'] = webReason
      ? { status: 'blocked', reason: webReason }
      : { status: 'ready', note: 'device emulation in Chromium' };
  }
  if (targets.android) {
    const { adb, emulatorTool, devices } = probes.android;
    if (!adb) out.android = { status: 'blocked', reason: 'adb is not installed' };
    else if (devices.length === 0 && !emulatorTool) out.android = { status: 'blocked', reason: 'no Android device or emulator is connected' };
    else if (!probes.automation.appium && !probes.automation.maestro) out.android = { status: 'blocked', reason: 'neither Appium nor Maestro is installed' };
    else out.android = { status: 'ready', devices };
  }
  if (targets.ios) {
    if (!probes.ios.available) out.ios = { status: 'blocked', reason: probes.ios.reason };
    else if (probes.ios.booted === 0) out.ios = { status: 'blocked', reason: 'no iOS simulator is booted' };
    else if (!probes.automation.appium && !probes.automation.maestro) out.ios = { status: 'blocked', reason: 'neither Appium nor Maestro is installed' };
    else out.ios = { status: 'ready' };
  }
  return out;
}
