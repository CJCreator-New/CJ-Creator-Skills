#!/usr/bin/env node
// PreToolUse guard for Write, Edit, MultiEdit, Bash, Read, Grep and Glob in a backend-engineer run.
//
// For every agent:
//   1. The ledger file and its lock are never written by a tool. Only the ledger's own commands
//      write them.
//   2. Secret-bearing files are never written. Their names (.env other than examples, keys,
//      certificates, credentials files) are never read through Read, Grep or Glob, and never named
//      in a shell command. The check covers redirection and file-moving targets too.
//   3. A committed migration is never edited, through a tool or a shell target. A new migration is
//      allowed.
//   4. Shell commands that touch the run state must be the plugin's own commands. Interpreters
//      with inline code that touch the state are denied.
//
// For read-only agents (design-analyst, repo-intel, security-reviewer, e2e-verifier,
// release-reviewer): no writes, with a tool or through the shell, whether or not a run is active.
//
// For subagents (recognised by agent_id): no ledger writes; the ledger is read and run only, through
// its run, validate, status and release commands. While a run has an ownership file, subagents
// write only inside it, through Edit or Write, and not through the shell.
//
// For the orchestrator (no agent_id): the ledger commands are allowed, the plugin's other commands
// too. While a run has an ownership file, its writes stay inside it, or under the state folder.
//
// Subagents are recognised by agent_id in the hook input, and the agent by agent_type. If the
// harness omits either, the guard applies the orchestrator's rules. This is a workflow guard, not a
// sandbox. An interpreter can still write a file that the command text does not name, and a
// directory-wide search can still return the contents of a secret file it does not name.

import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { covers, relativePath } from '../scripts/ownership.mjs';

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit']);
export const READ_TOOLS = new Set(['Read', 'Grep', 'Glob']);
export const READ_ONLY_AGENTS = new Set([
  'requirements-analyst',
  'repo-intel',
  'security-reviewer',
  'e2e-verifier',
  'release-reviewer',
]);
const STATE_DIR = '.claude/backend-engineer/';
const LEDGER_FILES = new Set(['ledger.json', 'ledger.lock']);
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
const WRITERS = new Set(['tee', 'cp', 'mv', 'rm', 'touch', 'truncate', 'ln', 'chmod', 'chown', 'patch']);
const GIT_WRITERS = new Set(['checkout', 'restore', 'apply', 'am', 'reset', 'clean', 'stash', 'mv', 'rm', 'switch']);
const ENV_ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=/;

// The plugin's own commands, which may touch the state. A subagent may only read and run the ledger.
const SANCTIONED =
  /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*node\s+(?:\S*\/)?(ledger|telemetry|report|route|contract|orchestrate|inventory)\.mjs(?=\s|$)/;
const SUBAGENT_SANCTIONED = /^\s*(?:[A-Za-z_][A-Za-z0-9_]*=\S+\s+)*node\s+(?:\S*\/)?ledger\.mjs\s+(run|validate|status|release)(?=\s|$)/;
const INTERPRETER_WRITE = /\b(node|python3?|perl|ruby)\s+(-e|--eval|-p|-c)\b/;

const ALLOW = { allow: true };
const deny = (reason) => ({ allow: false, reason });

const READ_ONLY_REASON =
  'This agent is read-only. It reports findings and does not write files. Return the change in your handoff for the orchestrator to assign.';
const SHELL_REASON =
  "Shell writes are blocked for subagents during a backend-engineer run. Use Edit or Write on a file in the run's list.";
const LEDGER_TOOL_REASON = 'The ledger is written only by its own commands. Use ledger.mjs add, set, gap, review, or run.';
const SUBAGENT_LEDGER_REASON =
  'Subagents may read and run the ledger, but not change it. Report the result in your handoff; the orchestrator records it.';
const STATE_SHELL_REASON =
  'Shell commands may touch the run state only through the plugin commands (ledger.mjs, telemetry.mjs, and the others).';
const STATE_TOOL_REASON = 'Subagents may not write the run state under .claude/backend-engineer/.';
const INTERPRETER_REASON =
  'Inline interpreter code may not touch the run state. Use the plugin commands.';
const SECRET_REASON = 'Secret-bearing files are never written by an agent. Put the value in the environment or a secrets manager.';
const SECRET_READ_REASON =
  'Secret-bearing files are never read by an agent, through a tool or a shell command. Use the example file, or ask the user for the value.';
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

// A name is a secret when its basename is a secret file name and is not an example file.
export function isSecretName(name) {
  const base = basename(name);
  return SECRET_NAME.test(base) && !SECRET_EXEMPT.test(base);
}

export const isSecretPath = (filePath) => isSecretName(filePath);

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

const unquote = (word) => word.replace(/^['"`]+|['"`]+$/g, '');
// Command separators only. Parentheses are not split on, because inline code uses them.
export const segmentsOf = (command) => command.split(/\s*(?:&&|\|\||;|\||\n)\s*/).filter(Boolean);
const wordsOf = (segment) => segment.trim().split(/\s+/).map(unquote).filter(Boolean);

// Every name a command mentions, after splitting on whitespace, quotes and '=' (so --file=.env counts).
const mentionedNames = (command) =>
  command
    .split(/[\s'"`=]+/)
    .filter(Boolean)
    .flatMap((word) => word.split(/[\/\\*?{},]+/))
    .filter(Boolean);

export const mentionsSecret = (command) => mentionedNames(command).some(isSecretName);

// The paths a shell command writes to: redirection targets, and the arguments of commands that write.
export function shellTargets(command) {
  const targets = [];
  for (const m of command.matchAll(/\d*>>?(?!&)\s*([^\s;&|<>()'"`]+)/g)) {
    if (m[1] !== '/dev/null') targets.push(m[1]);
  }
  for (const segment of segmentsOf(command)) {
    const words = wordsOf(segment);
    const start = words.findIndex((w) => !ENV_ASSIGNMENT.test(w));
    if (start < 0) continue;
    const name = words[start];
    const args = words.slice(start + 1);
    const operands = args.filter((a) => !a.startsWith('-'));
    if (WRITERS.has(name)) targets.push(...operands);
    if (name === 'git') {
      const sub = args.findIndex((a) => GIT_WRITERS.has(a));
      if (sub >= 0) targets.push(...args.slice(sub + 1).filter((a) => !a.startsWith('-')));
    }
    if (name === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === '--in-place')) targets.push(...operands.slice(1));
    if ((name === 'perl' || name === 'awk') && args.some((a) => /^-[a-zA-Z]*i/.test(a) || a === 'inplace')) targets.push(...operands);
    if (name === 'dd') for (const a of args) if (a.startsWith('of=')) targets.push(a.slice(3));
  }
  return targets;
}

// A command touches the run state when it names the state folder or its files, or invokes one of the
// plugin's commands. Subagents may invoke only the ledger's read and run commands.
const touchesState = (command) =>
  command.includes('.claude/backend-engineer') ||
  /\bledger\.(json|lock)\b|ownership\.json|telemetry\.jsonl/.test(command) ||
  /\b(ledger|telemetry|report|orchestrate|inventory)\.mjs\b/.test(command);

// What the trace records about one hook call: the tool, the key names of the payload, and the agent
// type. Values are not recorded, except the tool name and the agent type. Run a session with
// BACKEND_GUARD_TRACE=1 to see whether agent_id and agent_type are present for subagents.
export function traceEntry(input) {
  return {
    tool: input?.tool_name ?? null,
    keys: Object.keys(input ?? {}).sort(),
    agent_type: input?.agent_type ?? null,
    agent_id_present: typeof input?.agent_id === 'string' && input.agent_id !== '',
  };
}

const agentName = (input) => (input?.agent_type ?? '').split(':').pop();
const isSubagent = (input) => typeof input?.agent_id === 'string' && input.agent_id !== '';
const notInList = (filePath) =>
  `"${filePath}" is not in this backend-engineer run's file list. Only files a task owns may be written. ` +
  'Report the change as a handoff to the orchestrator, or add it to a task with ledger.mjs add tasks.';

function decideBash(command, { projectDir, readOnly, subagent }) {
  if (mentionsSecret(command)) return deny(SECRET_READ_REASON);

  const targets = shellTargets(command);
  if (targets.some(isSecretPath)) return deny(SECRET_REASON);
  if (targets.some((t) => isCommittedMigration(t, projectDir))) return deny(MIGRATION_REASON);

  if (touchesState(command)) {
    // Inline interpreter code that names the state is denied as a whole, not per segment.
    if (INTERPRETER_WRITE.test(command)) return deny(INTERPRETER_REASON);
    for (const segment of segmentsOf(command)) {
      if (!touchesState(segment)) continue;
      if (INTERPRETER_WRITE.test(segment)) return deny(INTERPRETER_REASON);
      const sanctioned = subagent ? SUBAGENT_SANCTIONED.test(segment) : SANCTIONED.test(segment);
      if (!sanctioned) return deny(subagent ? SUBAGENT_LEDGER_REASON : STATE_SHELL_REASON);
    }
  }

  const writes = isShellWrite(command);
  if (readOnly && writes) return deny(READ_ONLY_REASON);
  const owned = readOwnership(projectDir);
  if (subagent && writes && owned !== null) return deny(SHELL_REASON);
  if (!subagent && owned !== null) {
    for (const target of targets) {
      const rel = relativePath(target, projectDir);
      if (rel === null || rel.startsWith(STATE_DIR) || covers(owned, target, projectDir)) continue;
      return deny(notInList(target));
    }
  }
  return ALLOW;
}

function decideRead(input) {
  const ti = input?.tool_input ?? {};
  const values = [ti.file_path, ti.path, ti.glob, input.tool_name === 'Glob' ? ti.pattern : undefined];
  const hit = values
    .filter((v) => typeof v === 'string')
    .flatMap((v) => v.split(/[\s\/\\*?{},]+/))
    .some((token) => token !== '' && isSecretName(token));
  return hit ? deny(SECRET_READ_REASON) : ALLOW;
}

export function decide(input, env = process.env) {
  const projectDir = env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
  const readOnly = READ_ONLY_AGENTS.has(agentName(input));
  const subagent = isSubagent(input);
  const tool = input?.tool_name;

  if (tool === 'Bash') {
    const command = input?.tool_input?.command;
    return typeof command === 'string' ? decideBash(command, { projectDir, readOnly, subagent }) : ALLOW;
  }
  if (READ_TOOLS.has(tool)) return decideRead(input);
  if (!WRITE_TOOLS.has(tool)) return ALLOW;
  if (readOnly) return deny(READ_ONLY_REASON);

  const filePath = input?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath === '') return ALLOW;

  const rel = relativePath(filePath, projectDir);
  const inState = rel !== null && rel.startsWith(STATE_DIR);
  if (inState && LEDGER_FILES.has(basename(rel))) return deny(LEDGER_TOOL_REASON);
  if (isSecretPath(filePath)) return deny(SECRET_REASON);
  if (isCommittedMigration(filePath, projectDir)) return deny(MIGRATION_REASON);
  if (subagent && inState) return deny(STATE_TOOL_REASON);

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

  if (process.env.BACKEND_GUARD_TRACE) {
    const projectDir = process.env.CLAUDE_PROJECT_DIR || input?.cwd || process.cwd();
    try {
      mkdirSync(join(projectDir, '.claude', 'backend-engineer'), { recursive: true });
      appendFileSync(join(projectDir, '.claude', 'backend-engineer', 'hook-trace.jsonl'), `${JSON.stringify(traceEntry(input))}\n`);
    } catch {
      // The trace is a diagnostic. It must never block a tool call.
    }
  }

  const verdict = decide(input);
  if (!verdict.allow) {
    process.stderr.write(`${verdict.reason}\n`);
    process.exit(2);
  }
  process.exit(0);
}
