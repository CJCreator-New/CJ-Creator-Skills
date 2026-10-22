#!/usr/bin/env node
// Structural checks for the e2e-engineer plugin and the marketplace entry that lists it.
// Run from anywhere in the repository: node e2e-engineer/scripts/validate.mjs

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = resolve(PLUGIN, '..');
const problems = [];
const check = (ok, message) => {
  if (!ok) problems.push(message);
};
const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'));

function frontmatter(path) {
  const match = readFileSync(path, 'utf8').match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) return null;
  const fields = {};
  for (const line of match[1].split('\n')) {
    const field = line.match(/^([a-z-]+):\s*(.*)$/);
    if (field) fields[field[1]] = field[2];
  }
  return fields;
}

const manifest = readJson(join(PLUGIN, '.claude-plugin/plugin.json'));
check(manifest.name === 'e2e-engineer', 'plugin.json name must be e2e-engineer');
check(/^\d+\.\d+\.\d+$/.test(manifest.version), 'plugin.json version must be semver');
check(typeof manifest.description === 'string' && manifest.description.length > 0, 'plugin.json needs a description');

const skillPath = join(PLUGIN, 'skills/e2e-engineer/SKILL.md');
const skill = existsSync(skillPath) ? frontmatter(skillPath) : null;
check(skill !== null, 'SKILL.md needs frontmatter');
check(skill && skill.name === 'e2e-engineer', 'SKILL.md name must be e2e-engineer');
check(skill && Boolean(skill.description), 'SKILL.md needs a description');

for (const file of readdirSync(join(PLUGIN, 'agents'))) {
  if (!file.endsWith('.md')) continue;
  const fields = frontmatter(join(PLUGIN, 'agents', file));
  check(fields !== null, `agents/${file} needs frontmatter`);
  if (!fields) continue;
  check(fields.name === file.replace(/\.md$/, ''), `agents/${file} name must match its file name`);
  for (const key of ['description', 'tools', 'model']) check(Boolean(fields[key]), `agents/${file} needs ${key}`);
}

for (const file of readdirSync(join(PLUGIN, 'scripts'))) {
  if (!file.endsWith('.mjs')) continue;
  const result = spawnSync(process.execPath, ['--check', join(PLUGIN, 'scripts', file)], { encoding: 'utf8' });
  check(result.status === 0, `scripts/${file} does not parse: ${result.stderr.trim()}`);
}

// The fixture's defect list must number 1 to 13 with no gaps, and every flag must be wired into the code.
const fixtureDir = join(PLUGIN, 'fixtures/planted-app');
const fixture = readJson(join(fixtureDir, 'manifest.json'));
const numbers = fixture.defects.map((defect) => defect.planted).sort((a, b) => a - b);
check(JSON.stringify(numbers) === JSON.stringify(Array.from({ length: 13 }, (_, i) => i + 1)), 'fixture manifest must list defects 1 to 13 once each');
const code = ['server.mjs', 'public/index.html'].map((file) => readFileSync(join(fixtureDir, file), 'utf8')).join('\n');
for (const defect of fixture.defects) {
  if (defect.flag) check(code.includes(`'${defect.flag}'`), `planted flag ${defect.flag} is not wired into the fixture code`);
}
let openapiParses = true;
try {
  readJson(join(fixtureDir, 'openapi.json'));
} catch {
  openapiParses = false;
}
check(openapiParses, 'openapi.json must parse');

const marketplace = readJson(join(ROOT, '.claude-plugin/marketplace.json'));
const entry = marketplace.plugins.find((plugin) => plugin.name === 'e2e-engineer');
check(entry && entry.source === './e2e-engineer', 'marketplace.json needs an e2e-engineer entry with source ./e2e-engineer');

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join('\n'));
  process.exit(1);
}
console.log('e2e-engineer structure OK');
