// Finds the Playwright library for browser runs. The plugin never installs it: the library comes from
// config.browser.playwrightModule when that is set, and otherwise from the target repository's own
// dependencies. A missing library blocks the web targets with the reason; nothing is installed.

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, resolve } from 'node:path';

function findInNodeModules(start, name) {
  let dir = resolve(start);
  for (;;) {
    const candidate = join(dir, 'node_modules', name, 'package.json');
    if (existsSync(candidate)) return join(dir, 'node_modules', name);
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

export function findPlaywright({ root, config }) {
  const named = config.browser?.playwrightModule;
  if (named) {
    const path = isAbsolute(named) ? named : resolve(root, named);
    if (existsSync(path)) return { found: true, path, reason: null };
    return { found: false, path: null, reason: `browser.playwrightModule ${path} does not exist` };
  }
  // Only the repository's own node_modules folders, walking up from its root. Global installs are not used,
  // because a global copy is not a dependency of this repository.
  for (const name of ['playwright', 'playwright-core']) {
    const found = findInNodeModules(root, name);
    if (found) return { found: true, path: found, reason: null };
  }
  return {
    found: false,
    path: null,
    reason: 'Playwright is not in the repository dependencies; install it there, or set browser.playwrightModule',
  };
}

// Finds axe-core for the full accessibility scan, the same way: config.browser.axeModule (a folder or
// the axe.min.js file), or the repository's own node_modules. It is never installed.
export function findAxe({ root, config }) {
  const named = config.browser?.axeModule;
  const fileIn = (path) => (path.endsWith('.js') ? path : join(path, 'axe.min.js'));
  if (named) {
    const path = fileIn(isAbsolute(named) ? named : resolve(root, named));
    if (existsSync(path)) return { found: true, path, reason: null };
    return { found: false, path: null, reason: `browser.axeModule ${path} does not exist` };
  }
  const found = findInNodeModules(root, 'axe-core');
  if (found && existsSync(fileIn(found))) return { found: true, path: fileIn(found), reason: null };
  return { found: false, path: null, reason: 'axe-core is not in the repository dependencies; add it there, or set browser.axeModule' };
}

export function loadPlaywright(found) {
  if (!found.found) throw new Error(found.reason);
  return createRequire(import.meta.url)(found.path);
}
