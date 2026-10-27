#!/usr/bin/env node
// PreToolUse guard for Write, Edit, MultiEdit and NotebookEdit in an e2e-engineer run.
//
// The guard is inert unless a run is active. Intake writes the active marker for an allowed run, and
// `ledger.mjs finish` removes it. While a run is active:
//   1. The ledger is written only by the plugin's commands, never by a tool.
//   2. Writes go only under .claude/e2e-engineer/. The skill never edits application source.
//   3. Secret-looking files (.env other than examples, keys, credential files) are never written.
// The analysts are read-only: they are denied any write, whether or not a run is active.
//
// A denied call exits with status 2 and the reason on stderr. This is a workflow guard, not a sandbox.
// A shell command that writes a file is not checked here.

import { existsSync } from 'node:fs';
import { basename, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

export const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
export const READ_ONLY_AGENTS = new Set(['repo-intel', 'flow-analyst', 'rbac-analyst', 'ux-analyst', 'test-strategist']);
export const STATE_DIR = '.claude/e2e-engineer/';
const LEDGER = '.claude/e2e-engineer/ledger.json';
const ACTIVE = '.claude/e2e-engineer/active';
const SECRET = /^(\.env(\..+)?|.*\.(pem|key|p12|pfx)|id_(rsa|ecdsa|ed25519)|credentials(\.json)?)$/i;
const SECRET_EXEMPT = /\.(example|sample|template)$/i;

const allow = { allow: true, reason: '' };
const deny = (reason) => ({ allow: false, reason });

// The path relative to the project, with forward slashes, or null when it is outside the project.
export function relativeTo(projectDir, filePath) {
  const rel = relative(projectDir, resolve(projectDir, filePath));
  if (rel === '' || rel.startsWith('..') || resolve(projectDir, rel) !== resolve(projectDir, filePath)) return null;
  return rel.split(sep).join('/');
}

// The agent name without its plugin prefix, such as "flow-analyst" from "e2e-engineer:flow-analyst".
export function agentName(input) {
  const type = input?.agent_type;
  if (typeof type !== 'string' || type === '') return null;
  return type.includes(':') ? type.slice(type.lastIndexOf(':') + 1) : type;
}

export function decide(input, env = process.env) {
  if (!WRITE_TOOLS.has(input?.tool_name)) return allow;
  const filePath = input.tool_input?.file_path ?? input.tool_input?.notebook_path;
  if (typeof filePath !== 'string' || filePath === '') return allow;

  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const agent = agentName(input);
  const rel = relativeTo(projectDir, filePath);
  if (agent && READ_ONLY_AGENTS.has(agent)) {
    return deny(`${agent} is read-only and cannot write ${filePath}`);
  }
  if (!existsSync(join(projectDir, ACTIVE))) return allow;

  if (rel === null) return deny(`the run is active, and ${filePath} is outside the project`);
  if (rel === LEDGER || rel === `${LEDGER}.tmp`) return deny('the ledger is written only by its own commands');
  if (!rel.startsWith(STATE_DIR)) {
    return deny(`the run is active; this skill writes only under ${STATE_DIR}, not ${rel}. Run ledger.mjs finish when the run ends.`);
  }
  if (SECRET.test(basename(rel)) && !SECRET_EXEMPT.test(basename(rel))) {
    return deny(`${rel} looks like a secret file, and a secret file is never written`);
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
