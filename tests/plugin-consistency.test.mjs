// Repo-level consistency checks. A plugin is listed in several places: the marketplace, its own
// manifest, the two installers, the install test, and the root README. Each place is edited by hand,
// so this test fails when they drift apart. It also checks that the version in each plugin manifest
// matches the version the marketplace lists.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');
const readJson = (rel) => JSON.parse(read(rel));
const sorted = (xs) => [...xs].sort();

const marketplace = readJson('.claude-plugin/marketplace.json');
const listed = marketplace.plugins;
const listedNames = listed.map((p) => p.name);

// Plugin folders are the top-level directories that carry a manifest.
const pluginFolders = readdirSync(ROOT).filter(
  (name) => statSync(join(ROOT, name)).isDirectory() && existsSync(join(ROOT, name, '.claude-plugin', 'plugin.json')),
);

test('every plugin folder is listed in the marketplace, and every listing has a folder', () => {
  assert.deepEqual(sorted(pluginFolders), sorted(listed.map((p) => p.source.replace(/^\.\//, ''))));
  assert.equal(new Set(listedNames).size, listedNames.length, 'duplicate plugin names in marketplace.json');
});

test('each marketplace entry matches its own manifest by name and version', () => {
  for (const entry of listed) {
    const folder = entry.source.replace(/^\.\//, '');
    const manifest = readJson(join(folder, '.claude-plugin', 'plugin.json'));
    assert.equal(manifest.name, entry.name, `${folder}: manifest name differs from the marketplace name`);
    assert.equal(manifest.version, entry.version, `${entry.name}: manifest version ${manifest.version} differs from marketplace ${entry.version}`);
  }
});

test('install.sh installs every marketplace plugin, and nothing else', () => {
  const match = read('install.sh').match(/for plugin in ([^;]+); do/);
  assert.ok(match, 'install.sh has no "for plugin in ...; do" loop');
  assert.deepEqual(sorted(match[1].trim().split(/\s+/)), sorted(listedNames));
});

test('install.ps1 installs every marketplace plugin, and nothing else', () => {
  const match = read('install.ps1').match(/foreach \(\$plugin in ([^)]+)\)/);
  assert.ok(match, 'install.ps1 has no "foreach ($plugin in ...)" loop');
  const names = [...match[1].matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual(sorted(names), sorted(listedNames));
});

test('the install test expects an install and an update for every marketplace plugin', () => {
  const text = read('tests/install_test.py');
  for (const name of listedNames) {
    assert.match(text, new RegExp(`"plugin install ${name}@forge-marketplace"`), `install test misses ${name}`);
    assert.match(text, new RegExp(`"plugin update ${name}@forge-marketplace"`), `install test misses update of ${name}`);
  }
});

test('the root README names every marketplace plugin in its install instructions', () => {
  const text = read('README.md');
  for (const name of listedNames) {
    assert.ok(text.includes(name), `root README does not mention ${name}`);
  }
});

test('every plugin folder has a README', () => {
  for (const folder of pluginFolders) {
    assert.ok(existsSync(join(ROOT, folder, 'README.md')), `${folder}/README.md is missing`);
  }
});
