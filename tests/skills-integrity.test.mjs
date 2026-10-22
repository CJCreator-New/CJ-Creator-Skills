// Repo-level checks that every skill is intact: its frontmatter, the files and scripts it names, and
// the agents it dispatches. Also checks the docs for stale layout paths and test commands that do not
// run on this repo. Each plugin's own validator checks its structure; this test checks the links between
// the skills, their references, and the docs that point at them.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (path) => readFileSync(path, 'utf8');
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === '.git' || name === 'node_modules') return [];
    return statSync(path).isDirectory() ? walk(path) : [path];
  });

const skillFiles = walk(ROOT).filter((p) => p.endsWith('/SKILL.md'));
const docFiles = walk(ROOT).filter((p) => p.endsWith('.md'));

// Reads the frontmatter. A folded block (description: >) continues on the indented lines below it.
function frontmatter(path) {
  const match = read(path).match(/^---\n([\s\S]*?)\n---\n/);
  assert.ok(match, `${path}: missing frontmatter`);
  const fields = {};
  let key = null;
  for (const line of match[1].split('\n')) {
    const kv = line.match(/^([a-z-]+):\s*(.*)$/);
    if (kv) {
      key = kv[1];
      fields[key] = kv[2].trim();
    } else if (key && /^\s+\S/.test(line)) {
      fields[key] = `${fields[key]} ${line.trim()}`.trim();
    }
  }
  return fields;
}

test('there are seven skills, and each frontmatter names its folder and has a description', () => {
  assert.equal(skillFiles.length, 7, skillFiles.map((p) => p.slice(ROOT.length)).join('\n'));
  for (const file of skillFiles) {
    const fields = frontmatter(file);
    const folder = file.split('/').slice(-2, -1)[0];
    assert.equal(fields.name, folder, `${file}: name must equal its folder`);
    assert.ok(fields.description && fields.description.length > 40, `${file}: description is missing or too short`);
  }
});

test('every reference file a skill names exists under its references folder', () => {
  for (const file of skillFiles) {
    const body = read(file);
    for (const match of body.matchAll(/`(references\/[\w.-]+\.md)`/g)) {
      assert.ok(existsSync(join(dirname(file), match[1])), `${file}: missing ${match[1]}`);
    }
  }
});

test('every plugin script, hook or agent a skill names through CLAUDE_PLUGIN_ROOT exists', () => {
  for (const file of skillFiles) {
    const pluginRoot = resolve(dirname(file), '../..');
    for (const match of read(file).matchAll(/\$\{CLAUDE_PLUGIN_ROOT\}\/([\w./-]+)/g)) {
      assert.ok(existsSync(join(pluginRoot, match[1])), `${file}: missing ${match[1]}`);
    }
  }
});

test('every agent a skill dispatches by name exists in its plugin', () => {
  for (const file of skillFiles) {
    const pluginRoot = resolve(dirname(file), '../..');
    const agentsDir = join(pluginRoot, 'agents');
    if (!existsSync(agentsDir)) continue;
    const agents = readdirSync(agentsDir).filter((n) => n.endsWith('.md')).map((n) => n.replace(/\.md$/, ''));
    const agentNames = new Set(agents);
    for (const match of read(file).matchAll(/`([a-z][a-z0-9]*(?:-[a-z0-9]+)+)`/g)) {
      // A dispatched agent is named in backticks and is a file of this plugin. Anything else
      // (a hook script, a WCAG token, a flag) is not checked here.
      if (agentNames.has(match[1])) continue;
      if (agents.some((a) => a.includes(match[1]) && a.length > match[1].length)) {
        assert.fail(`${file}: \`${match[1]}\` looks like a misnamed agent`);
      }
    }
  }
});

test('the docs do not describe a plugins/ layout, which this repo does not use', () => {
  for (const file of docFiles) {
    assert.doesNotMatch(read(file), /\bplugins\/[\w-]+/, `${file} uses a plugins/ path`);
  }
});

test('the docs do not name a test script this repo does not have', () => {
  for (const file of docFiles) {
    assert.doesNotMatch(read(file), /pnpm test:plugin/, `${file} names pnpm test:plugin, which does not exist here`);
  }
});

test('the docs do not run node --test on a directory, which Node 22 does not expand', () => {
  for (const file of docFiles) {
    for (const line of read(file).split('\n')) {
      assert.doesNotMatch(line, /node --test [^\s*]+\/(\s|$)/, `${file}: ${line.trim()}`);
    }
  }
});

test('the frontend example routes an accessibility request to the accessibility skill', () => {
  const readme = read(join(ROOT, 'frontend-engineer/README.md'));
  assert.doesNotMatch(readme, /frontend-build Review .*accessibility/);
  assert.match(readme, /\/frontend-engineer:accessibility-audit/);
});
