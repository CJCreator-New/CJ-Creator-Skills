#!/usr/bin/env node
// PreToolUse guard for Write, Edit, MultiEdit and Bash. It enforces three rules:
//
// 1. Read-only agents (design-analyst, repo-intel, visual-qa, code-reviewer, a11y-static-reviewer,
//    a11y-runtime-auditor) never write files,
//    with a tool or with a shell command, whether or not a run is active.
// 2. While a run has an ownership file, subagents may not write through the shell. They must use
//    Edit or Write, which this guard checks against the list.
// 3. While a run has an ownership file, every write (subagent or orchestrator) must fall inside
//    the list. The orchestrator may always write under .claude/frontend-engineer/, which holds
//    the run's own state.
//
// The list is read from <project>/.claude/frontend-engineer/ownership.json as
// {"owned": ["src/components/Foo/", "src/pages/foo.tsx"]}. A missing or malformed file means no
// run is active, so nothing is blocked (except rule 1).
//
// Subagents are recognised by agent_id in the hook input, and the agent is recognised by
// agent_type. If the harness omits either field, the guard cannot tell the caller apart and
// applies the rule for the main session. This is a workflow guard, not a sandbox: shell writes
// are detected by pattern, and an interpreter such as `node -e` or `python -c` can still write.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { covers, relativePath } from '../scripts/ownership.mjs';

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
export const READ_ONLY_AGENTS = new Set([
  'design-analyst',
  'repo-intel',
  'visual-qa',
  'code-reviewer',
  'a11y-static-reviewer',
  'a11y-runtime-auditor',
]);
const STATE_DIR = '.claude/frontend-engineer/';

// Shell commands that write files. Redirections to /dev/null and fd duplication (2>&1) are allowed.
export const SHELL_WRITE_PATTERNS = [
  /(^|[^>&=-])\d*>>?(?![>&])\s*(?!\/dev\/null(?=[\s;&|)]|$))\S/,
  /(^|[\s;&|(`])(tee|cp|mv|rm|touch|truncate|dd|patch|chmod|chown|ln)(?=\s|$)/,
  /\bgit\s+(checkout|restore|apply|am|reset|clean|stash|mv|rm|switch)\b/,
  /\bsed\b[^|;&\n]*\s(-[a-zA-Z]*i[a-zA-Z]*|--in-place)(?=\s|=|$)/,
  /\bperl\b[^|;&\n]*\s-[a-zA-Z]*i/,
  /\bawk\b[^|;&\n]*-i\s+inplace/,
];

const ALLOW = { allow: true };
const deny = (reason) => ({ allow: false, reason });

const READ_ONLY_REASON =
  'This agent is read-only. It reports findings and does not write files. Return the change in your handoff for the orchestrator to assign.';
const SHELL_REASON =
  'Shell writes are blocked for subagents during a frontend-engineer run. Use Edit or Write on a file in the run\'s list.';

export function readOwnership(projectDir) {
  try {
    const data = JSON.parse(readFileSync(join(projectDir, '.claude', 'frontend-engineer', 'ownership.json'), 'utf8'));
    if (!Array.isArray(data?.owned)) return null;
    return data.owned.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
  } catch {
    return null;
  }
}

export function isShellWrite(command) {
  return SHELL_WRITE_PATTERNS.some((pattern) => pattern.test(command));
}

const agentName = (input) => (input?.agent_type ?? '').split(':').pop();
const isSubagent = (input) => typeof input?.agent_id === 'string' && input.agent_id !== '';
const notInList = (filePath) =>
  `"${filePath}" is not in this frontend-engineer run's file list. Only files the plan assigned may be written. ` +
  'Report the change as a handoff to the orchestrator, or add the file to the plan with gates.mjs package before writing it.';

export function decide(input, env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  const readOnly = READ_ONLY_AGENTS.has(agentName(input));
  const subagent = isSubagent(input);

  if (input?.tool_name === 'Bash') {
    const command = input?.tool_input?.command;
    if (typeof command !== 'string' || !isShellWrite(command)) return ALLOW;
    if (readOnly) return deny(READ_ONLY_REASON);
    if (subagent && readOwnership(projectDir) !== null) return deny(SHELL_REASON);
    return ALLOW;
  }

  if (!WRITE_TOOLS.has(input?.tool_name)) return ALLOW;
  if (readOnly) return deny(READ_ONLY_REASON);

  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath === '') return ALLOW;

  const owned = readOwnership(projectDir);
  if (owned === null) return ALLOW;
  if (covers(owned, filePath, projectDir)) return ALLOW;

  if (!subagent) {
    const rel = relativePath(filePath, projectDir);
    if (rel !== null && rel.startsWith(STATE_DIR)) return ALLOW;
  }
  return deny(notInList(filePath));
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
