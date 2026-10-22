#!/usr/bin/env node
// PreToolUse hook for Write, Edit and MultiEdit. While a frontend-engineer run has an ownership
// file, writes are allowed only inside the paths the plan listed for the run. Writes outside
// that list are denied with a reason.
//
// The list is read from <project>/.claude/frontend-engineer/ownership.json as
// {"owned": ["src/components/Foo/", "src/pages/foo.tsx"]}. Entries ending in "/" match a
// folder and everything under it; other entries match one file. A missing or malformed file
// means no run is active, so nothing is blocked. This is a workflow guard, not a sandbox: it
// enforces the run's file list, and the plan decides which agent owns which file inside it.

import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);

export function readOwnership(projectDir) {
  try {
    const data = JSON.parse(
      readFileSync(join(projectDir, '.claude', 'frontend-engineer', 'ownership.json'), 'utf8'),
    );
    if (!Array.isArray(data?.owned)) return null;
    return data.owned.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
  } catch {
    return null;
  }
}

export function isOwned(filePath, projectDir, owned) {
  const rel = relative(projectDir, resolve(projectDir, filePath));
  if (rel === '' || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) return false;
  const target = rel.split(sep).join('/');
  return owned.some((entry) => {
    const pattern = entry.replace(/\\/g, '/').replace(/^\.\//, '');
    return pattern.endsWith('/') ? target.startsWith(pattern) : target === pattern;
  });
}

export function decide(input, env = process.env) {
  if (!WRITE_TOOLS.has(input?.tool_name)) return { allow: true };
  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath === '') return { allow: true };

  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const owned = readOwnership(projectDir);
  if (owned === null) return { allow: true };
  if (isOwned(filePath, projectDir, owned)) return { allow: true };

  return {
    allow: false,
    reason:
      `"${filePath}" is not in this frontend-engineer run's file list. Only files the plan ` +
      'assigned may be written. Report the change as a handoff to the orchestrator, or add the ' +
      'file to the plan in .claude/frontend-engineer/ownership.json before writing it.',
  };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let raw = '';
  process.stdin.setEncoding('utf8');
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    process.exit(0);
  }

  const verdict = decide(input);
  if (!verdict.allow) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}
