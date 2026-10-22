#!/usr/bin/env node
// PreToolUse guard for Write, Edit, MultiEdit, NotebookEdit and Bash in a security audit.
//
// Two rules:
//   1. The audit agents are read-only. They are denied every write and every state-changing
//      command, whether or not an audit is running.
//   2. While an audit is running, the main session may write only under .claude/security-audit/,
//      and may not run commands that change files, git state, or installed packages.
//
// An audit is running while <project>/.claude/security-audit/phase contains "audit". The skill
// writes "done" when it finishes, and a missing file means no audit is running.
//
// A denied call exits with status 2 and the reason on stderr. This is a workflow guard, not a
// sandbox: it matches common write patterns and fails open on malformed input.

import { readFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const READ_ONLY_AGENTS = new Set([
  'secrets-scanner',
  'dependency-auditor',
  'access-control-reviewer',
  'input-handler-reviewer',
  'config-reviewer',
]);
export const STATE_DIR = '.claude/security-audit/';
const PHASE = '.claude/security-audit/phase';

// Commands that change files, git state, or installed packages. Read-only forms (git diff,
// git log, npm audit, 2>/dev/null) are not matched.
export const MUTATING_COMMANDS = [
  /\bgit\s+(commit|push|reset|checkout|switch|clean|apply|stash|rebase|merge|tag|add|rm|mv|restore|cherry-pick|am|pull|fetch)\b/,
  /\bgit\s+branch\s+(-d|-D|-m|-M|--delete)\b/,
  /\b(rm|mv|cp|chmod|chown|truncate|dd|tee|touch|mkdir|ln|rmdir)\b/,
  /\bsed\s+-i\b/,
  /\bperl\s+-i\b/,
  /(^|[^\d>=])>{1,2}\s*(?!\/dev\/null\b)(?!&)[^\s&]/,
  /\b(npm|pnpm|yarn|bun)\s+(install|i|ci|add|update|up|uninstall|remove|publish|link|audit\s+fix)\b/,
  /\b(pip|pip3|uv|poetry)\s+(install|add|update|uninstall|publish)\b/,
  /\bcargo\s+(install|add|update|publish)\b/,
  /\bgo\s+(install|get)\b/,
  /\bdocker\s+(run|exec|build|push|compose)\b/,
  /\bcurl\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)\b|\s-d\s|\s--data)/,
  /(^|\s)--fix\b/,
];

export function isMutatingCommand(command) {
  return MUTATING_COMMANDS.some((pattern) => pattern.test(command));
}

// The path relative to the project, with forward slashes, or null when it is outside the project.
export function relativeTo(projectDir, filePath) {
  const rel = relative(projectDir, resolve(projectDir, filePath));
  if (rel === '' || rel.startsWith('..') || resolve(projectDir, rel) !== resolve(projectDir, filePath)) return null;
  return rel.split(sep).join('/');
}

// The agent name without its plugin prefix, such as "secrets-scanner" from "security-audit:secrets-scanner".
export function agentName(input) {
  const type = input?.agent_type;
  if (typeof type !== 'string' || type === '') return null;
  return type.includes(':') ? type.slice(type.lastIndexOf(':') + 1) : type;
}

export function auditRunning(projectDir) {
  try {
    return readFileSync(join(projectDir, PHASE), 'utf8').trim() === 'audit';
  } catch {
    return false;
  }
}

const allow = { allow: true, reason: '' };
const deny = (reason) => ({ allow: false, reason });

export function decide(input, env = process.env) {
  if (!input || typeof input !== 'object') return allow;
  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const agent = agentName(input);

  if (WRITE_TOOLS.has(input.tool_name)) {
    const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
    if (typeof filePath !== 'string' || filePath === '') return allow;
    if (agent && READ_ONLY_AGENTS.has(agent)) return deny(`${agent} is read-only and cannot write ${filePath}`);
    if (!auditRunning(projectDir)) return allow;

    const rel = relativeTo(projectDir, filePath);
    if (rel === null || !rel.startsWith(STATE_DIR)) {
      return deny(
        `The security audit is read-only. It writes only its report under ${STATE_DIR}, not ${filePath}. ` +
          'Propose the change in the report instead.',
      );
    }
    return allow;
  }

  if (input.tool_name === 'Bash') {
    const command = input.tool_input?.command;
    if (typeof command !== 'string') return allow;
    if (agent && READ_ONLY_AGENTS.has(agent) && isMutatingCommand(command)) {
      return deny(`${agent} is read-only and cannot run a command that changes state: ${command}`);
    }
    if (!auditRunning(projectDir) || !isMutatingCommand(command)) return allow;
    return deny(
      'The security audit is read-only, and this command would change files, git state or packages. ' +
        'Read with Read, Grep and Glob, or run a read-only command such as git log, git ls-files or npm audit. ' +
        'To end the audit, write "done" to .claude/security-audit/phase with the Write tool.',
    );
  }

  return allow;
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
