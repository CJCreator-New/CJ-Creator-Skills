#!/usr/bin/env node
// PreToolUse guard for Write, Edit, MultiEdit and Bash in a backend-engineer run.
//
// 1. Secret-bearing files are never written by an agent: .env files other than examples, key and
//    certificate files, and credentials files.
// 2. A committed migration is never edited. Add a new migration instead. A new migration file is
//    allowed.
// 3. Read-only agents never write, with a tool or with a shell command, whether or not a run is
//    active.
// 4. Subagents never change the ledger: no writes under .claude/backend-engineer/, and no ledger
//    command except run, validate, status and release. The orchestrator records the rest.
// 5. While the run has an ownership file, subagents write only inside it, through Edit or Write,
//    and not through the shell. The orchestrator writes only inside it, or under the ledger folder.
//
// Subagents are recognised by agent_id in the hook input, and the agent by agent_type. If the
// harness omits either field, the guard applies the orchestrator's rules. This is a workflow
// guard, not a sandbox: shell writes are detected by pattern, and an interpreter such as
// `node -e` or `python -c` can still write.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { covers, relativePath } from '../scripts/ownership.mjs';

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
export const READ_ONLY_AGENTS = new Set([
  'requirements-analyst',
  'repo-intel',
  'security-reviewer',
  'e2e-verifier',
  'release-reviewer',
]);
const STATE_DIR = '.claude/backend-engineer/';
const LEDGER_WRITES = /\bledger\.mjs\s+(init|add|set|gap|review|ownership|finish|abort)\b/;
const MIGRATION_PATH = /(^|\/)(migrations?|db\/migrate|alembic\/versions|prisma\/migrations)\//;
const SECRET_NAME = /^(\.env(\..+)?|.*\.(pem|key|p12|pfx)|id_(rsa|ecdsa|ed25519)|credentials(\.json)?)$/i;
const SECRET_EXEMPT = /\.(example|sample|template)$/i;

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
  "Shell writes are blocked for subagents during a backend-engineer run. Use Edit or Write on a file in the run's list.";
const LEDGER_REASON =
  'Subagents may not change the ledger. Report the result in your handoff; the orchestrator records it. run, validate, status and release are allowed.';
const STATE_REASON = 'Subagents may not write the run state under .claude/backend-engineer/.';
const SECRET_REASON = 'Secret-bearing files are never written by an agent. Put the value in the environment or a secrets manager.';
const MIGRATION_REASON =
  'This migration is committed, so it may already be applied. Do not edit it; add a new migration that makes the change.';

export function readOwnership(projectDir) {
  try {
    const data = JSON.parse(readFileSync(join(projectDir, '.claude', 'backend-engineer', 'ownership.json'), 'utf8'));
    if (!Array.isArray(data?.owned)) return null;
    return data.owned.filter((entry) => typeof entry === 'string' && entry.trim() !== '');
  } catch {
    return null;
  }
}

export function isShellWrite(command) {
  return SHELL_WRITE_PATTERNS.some((pattern) => pattern.test(command));
}

export function isSecretPath(filePath) {
  const name = basename(filePath);
  return SECRET_NAME.test(name) && !SECRET_EXEMPT.test(name);
}

// True only when the file is in a migrations folder and git tracks it, which means it was committed.
export function isCommittedMigration(filePath, projectDir) {
  const rel = relativePath(filePath, projectDir);
  if (rel === null || !MIGRATION_PATH.test(rel)) return false;
  try {
    execFileSync('git', ['ls-files', '--error-unmatch', '--', rel], { cwd: projectDir, stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const agentName = (input) => (input?.agent_type ?? '').split(':').pop();
const isSubagent = (input) => typeof input?.agent_id === 'string' && input.agent_id !== '';
const notInList = (filePath) =>
  `"${filePath}" is not in this backend-engineer run's file list. Only files a task owns may be written. ` +
  'Report the change as a handoff to the orchestrator, or add it to a task with ledger.mjs add tasks.';

export function decide(input, env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  const readOnly = READ_ONLY_AGENTS.has(agentName(input));
  const subagent = isSubagent(input);

  if (input?.tool_name === 'Bash') {
    const command = input?.tool_input?.command;
    if (typeof command !== 'string') return ALLOW;
    if (subagent && LEDGER_WRITES.test(command)) return deny(LEDGER_REASON);
    if (!isShellWrite(command)) return ALLOW;
    if (readOnly) return deny(READ_ONLY_REASON);
    if (subagent && readOwnership(projectDir) !== null) return deny(SHELL_REASON);
    return ALLOW;
  }

  if (!WRITE_TOOLS.has(input?.tool_name)) return ALLOW;
  if (readOnly) return deny(READ_ONLY_REASON);

  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath === '') return ALLOW;
  if (isSecretPath(filePath)) return deny(SECRET_REASON);
  if (isCommittedMigration(filePath, projectDir)) return deny(MIGRATION_REASON);

  const rel = relativePath(filePath, projectDir);
  const inState = rel !== null && rel.startsWith(STATE_DIR);
  if (subagent && inState) return deny(STATE_REASON);

  const owned = readOwnership(projectDir);
  if (owned === null) return ALLOW;
  if (covers(owned, filePath, projectDir)) return ALLOW;
  if (!subagent && inState) return ALLOW;
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
