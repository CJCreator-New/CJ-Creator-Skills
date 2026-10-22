#!/usr/bin/env node
// Structural checks for the backend-engineer plugin and the marketplace that lists it.
// Run from anywhere in the repository: node backend-engineer/scripts/validate.mjs
// For the official check run: claude plugin validate backend-engineer

import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

import { READ_ONLY_AGENTS } from '../hooks/guard.mjs';
import { validateLedger } from './ledger.mjs';

const PLUGIN = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The marketplace is the nearest ancestor folder holding .claude-plugin/marketplace.json.
function findRoot(start) {
  for (let dir = start; ; dir = dirname(dir)) {
    if (existsSync(join(dir, '.claude-plugin/marketplace.json'))) return dir;
    if (dirname(dir) === dir) return start;
  }
}
const ROOT = findRoot(dirname(PLUGIN));
const errors = [];
const fail = (msg) => errors.push(msg);
const rel = (p) => relative(ROOT, p);

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    fail(`${rel(path)}: invalid JSON (${err.message})`);
    return null;
  }
}

function frontmatter(path) {
  const text = readFileSync(path, 'utf8');
  const match = text.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) {
    fail(`${rel(path)}: missing YAML frontmatter`);
    return { fields: {}, body: text };
  }
  const fields = {};
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) fields[kv[1]] = kv[2].trim();
  }
  return { fields, body: text.slice(match[0].length) };
}

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+$/;
const MODELS = new Set(['haiku', 'sonnet', 'opus']);

// 1. Plugin manifest
const manifest = readJson(join(PLUGIN, '.claude-plugin/plugin.json'));
if (manifest) {
  if (!KEBAB.test(manifest.name ?? '')) fail('plugin.json: name must be kebab-case');
  if (!SEMVER.test(manifest.version ?? '')) fail('plugin.json: version must be semver');
  if (typeof manifest.description !== 'string' || !manifest.description.trim())
    fail('plugin.json: description is required');
}

// 2. Marketplace lists the plugin with a matching source
const marketplace = readJson(join(ROOT, '.claude-plugin/marketplace.json'));
if (marketplace) {
  const entry = (marketplace.plugins ?? []).find((p) => p.name === manifest?.name);
  if (!entry) fail('marketplace.json: plugin not listed');
  else if (resolve(ROOT, entry.source) !== PLUGIN)
    fail(`marketplace.json: source for ${manifest.name} must point to ${rel(PLUGIN)}`);
  if (!marketplace.name || !marketplace.owner?.name) fail('marketplace.json: name and owner.name are required');
}

// 3. Skills: every skill folder has SKILL.md with name and description, and every referenced file exists
const skillsDir = join(PLUGIN, 'skills');
for (const skill of readdirSync(skillsDir)) {
  const file = join(skillsDir, skill, 'SKILL.md');
  if (!existsSync(file)) {
    fail(`${rel(join(skillsDir, skill))}: missing SKILL.md`);
    continue;
  }
  const { fields, body } = frontmatter(file);
  if (fields.name !== skill) fail(`${rel(file)}: name must equal folder name "${skill}"`);
  if (!fields.description) fail(`${rel(file)}: description is required`);
  for (const ref of body.matchAll(/`(references\/[\w.-]+\.md)`/g)) {
    if (!existsSync(join(skillsDir, skill, ref[1]))) fail(`${rel(file)}: references missing file ${ref[1]}`);
  }
}

// 4. Agents: name equals filename, description, tools, a known model alias, and a body
const agentsDir = join(PLUGIN, 'agents');
for (const f of readdirSync(agentsDir).filter((n) => n.endsWith('.md'))) {
  const file = join(agentsDir, f);
  const { fields, body } = frontmatter(file);
  if (fields.name !== f.replace(/\.md$/, '')) fail(`${rel(file)}: name must equal filename`);
  if (!fields.description) fail(`${rel(file)}: description is required`);
  if (!fields.tools) fail(`${rel(file)}: tools is required (least privilege)`);
  if (!MODELS.has(fields.model)) fail(`${rel(file)}: model must be one of ${[...MODELS].join(', ')}`);
  if (body.trim().length < 100) fail(`${rel(file)}: body is too short to be an agent prompt`);
  if (READ_ONLY_AGENTS.has(fields.name) && /\b(Write|Edit|MultiEdit)\b/.test(fields.tools ?? '')) {
    fail(`${rel(file)}: read-only agent must not list Write, Edit or MultiEdit`);
  }
}
for (const name of READ_ONLY_AGENTS) {
  if (!existsSync(join(agentsDir, `${name}.md`))) fail(`guard.mjs: read-only agent ${name} has no file`);
}

// 5. Hooks: each command references an existing script under the plugin root
const hooks = readJson(join(PLUGIN, 'hooks/hooks.json'));
const KNOWN_EVENTS = new Set([
  'PreToolUse',
  'PostToolUse',
  'UserPromptSubmit',
  'Stop',
  'SubagentStop',
  'SessionStart',
  'SessionEnd',
  'Notification',
  'PreCompact',
]);
if (hooks?.hooks) {
  for (const [event, matchers] of Object.entries(hooks.hooks)) {
    if (!KNOWN_EVENTS.has(event)) fail(`hooks.json: unknown event ${event}`);
    for (const m of matchers) {
      for (const h of m.hooks ?? []) {
        if (h.type !== 'command') fail(`hooks.json: ${event} hook type must be command`);
        const script = h.command?.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/([^"\s]+)/)?.[1];
        if (!script) fail(`hooks.json: ${event} command must reference \${CLAUDE_PLUGIN_ROOT}/<script>`);
        else if (!existsSync(join(PLUGIN, script))) fail(`hooks.json: missing script ${script}`);
      }
    }
  }
} else if (hooks) {
  fail('hooks.json: top-level "hooks" key is required');
}

// 6. The example ledger is valid under the same rules the ledger command enforces
const example = readJson(join(PLUGIN, 'examples/ledger.example.json'));
if (example) {
  const { _comment, ...ledger } = example;
  for (const message of validateLedger(ledger)) fail(`examples/ledger.example.json: ${message}`);
}

// 7. No secret-bearing files inside the plugin
const walk = (dir) =>
  readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
for (const file of walk(PLUGIN)) {
  if (/(^|\/)\.env(\.|$)|\.qa-keys\.json$|\.qa-ai-models\.json$/.test(rel(file)) && !/\.example$/.test(rel(file)))
    fail(`${rel(file)}: secret-bearing file in plugin`);
}

if (errors.length) {
  console.error(`backend-engineer validation failed (${errors.length}):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log('backend-engineer structure: ok');
