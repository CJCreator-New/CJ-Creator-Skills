#!/usr/bin/env node
// PreToolUse guard for Write, Edit, MultiEdit, NotebookEdit and Bash in an e2e-engineer run.
//
// The guard is inert unless a run is active. Intake writes the active marker for an allowed run, and
// `ledger.mjs finish` removes it. While a run is active:
//   1. The ledger is written only by the plugin's commands, never by a tool.
//   2. Writes go only under .claude/e2e-engineer/. The skill never edits application source.
//   3. Secret-looking files (.env other than examples, keys, credential files) are never written.
// The analysts are read-only: they are denied any write, whether or not a run is active.
//
// Shell commands are checked too, while a run is active: a redirection, tee, an in-place edit, or a
// file command (rm, mv, cp, touch, mkdir, chmod, ln, truncate, dd) is denied when its target is outside
// the state folder or the temp folder; git commands that change the repository and package installs are
// denied. The plugin's own scripts pass, since they are not file commands. An analyst's shell command
// that writes is denied always.
//
// A denied call exits with status 2 and the reason on stderr. This is a workflow guard, not a sandbox:
// it reads the command as text, so a program that writes files itself (a script, `node -e`) is not
// seen.

import { tmpdir } from 'node:os';

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

const FILE_COMMANDS = new Set(['rm', 'mv', 'cp', 'touch', 'mkdir', 'chmod', 'chown', 'ln', 'truncate', 'dd', 'install', 'rsync']);
const GIT_WRITES = /\bgit\s+(?:-C\s+\S+\s+)?(commit|push|reset|checkout|switch|merge|rebase|apply|am|stash|clean|restore|add|rm|mv|tag|cherry-pick|revert|pull)\b/;
const INSTALLS = /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:install|i|add|ci|update)|pip3?\s+install|brew\s+install|apt(?:-get)?\s+install|gem\s+install|cargo\s+install|npx\s+playwright\s+install)\b/;

// Whether a shell path is a place a run may write: the state folder, the temp folder, or /dev/null.
function writable(projectDir, target) {
  const path = target.replace(/^["']|["']$/g, '');
  if (['/dev/null', '/dev/stdout', '/dev/stderr'].includes(path)) return true;
  // Inside the project, only the state folder, and never the ledger. Outside it, only the temp folder.
  const rel = relativeTo(projectDir, path);
  if (rel !== null) return (rel === STATE_DIR.slice(0, -1) || rel.startsWith(STATE_DIR)) && rel !== LEDGER && rel !== `${LEDGER}.tmp`;
  const absolute = resolve(projectDir, path);
  return [tmpdir(), '/tmp'].some((temp) => {
    const inTemp = relative(temp, absolute);
    return inTemp === '' || (!inTemp.startsWith('..') && !inTemp.startsWith(sep));
  });
}

// The reasons a shell command would write where a run must not. Empty when it would not.
export function shellWrites(command, projectDir) {
  const reasons = [];
  if (GIT_WRITES.test(command)) reasons.push('it changes the git repository');
  if (INSTALLS.test(command)) reasons.push('it installs packages, which needs the user\'s consent and a finished run');
  for (const [, target] of command.matchAll(/(?:^|[^<>&\d])(?:\d|&)?>>?\s*([^\s;|&<>]+)/g)) {
    if (!target.startsWith('&') && !writable(projectDir, target)) reasons.push(`it redirects output to ${target}`);
  }
  for (const segment of command.split(/(?:&&|\|\||;|\||\n)/)) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    while (words.length > 0 && /^(sudo|env|command|nohup|time|[A-Z_][A-Z0-9_]*=.*)$/.test(words[0])) words.shift();
    const [verb, ...args] = words;
    if (!verb) continue;
    const paths = args.filter((a) => !a.startsWith('-'));
    if (verb === 'tee') {
      for (const p of paths) if (!writable(projectDir, p)) reasons.push(`tee writes ${p}`);
    } else if ((verb === 'sed' && args.some((a) => /^-[a-zA-Z]*i/.test(a))) || (verb === 'perl' && args.some((a) => /^-[a-zA-Z]*i/.test(a)))) {
      const target = paths[paths.length - 1];
      if (!target || !writable(projectDir, target)) reasons.push(`${verb} edits ${target ?? 'a file'} in place`);
    } else if (FILE_COMMANDS.has(verb)) {
      // cp and install read their sources; only the destination is written.
      const targets = ['cp', 'install', 'rsync'].includes(verb) ? paths.slice(-1) : verb === 'dd' ? args.filter((a) => a.startsWith('of=')).map((a) => a.slice(3)) : paths;
      for (const p of targets) if (!writable(projectDir, p)) reasons.push(`${verb} changes ${p}`);
    }
  }
  return [...new Set(reasons)];
}

function decideShell(input, env) {
  const command = input.tool_input?.command;
  if (typeof command !== 'string' || command.trim() === '') return allow;
  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const agent = agentName(input);
  const analyst = agent && READ_ONLY_AGENTS.has(agent);
  if (!analyst && !existsSync(join(projectDir, ACTIVE))) return allow;
  // The plugin's own scripts are not file commands, so they pass; a redirection or a chained command
  // around them is still checked.
  const reasons = shellWrites(command, projectDir);
  if (reasons.length === 0) return allow;
  if (analyst) return deny(`${agent} is read-only, and this command writes: ${reasons.join('; ')}`);
  return deny(`the run is active, and this command writes outside ${STATE_DIR}: ${reasons.join('; ')}. Run ledger.mjs finish when the run ends.`);
}

export function decide(input, env = process.env) {
  if (input?.tool_name === 'Bash') return decideShell(input, env);
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
