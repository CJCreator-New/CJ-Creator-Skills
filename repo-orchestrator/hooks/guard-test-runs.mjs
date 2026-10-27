#!/usr/bin/env node
// PreToolUse hook for Bash. Blocks test runners while the orchestrator is in an
// implementation or readiness phase, so tests run only in the final verification stage.
//
// The phase is read from <project>/.claude/orchestrator/phase. A missing file means no
// orchestrator run is active, so nothing is blocked. This is a workflow guard, not a
// sandbox: it matches common test runners and fails open on malformed input.

import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const BLOCKED_PHASES = new Set(['implementation', 'readiness']);

export const TEST_RUNNERS = [
  /\b(pnpm|npm|yarn|bun)\b(\s+-\S+)*\s+(run\s+)?test(:[\w-]+)?\b/,
  /\bvitest\b/,
  /\bjest\b/,
  /\bplaywright\s+test\b/,
  /\bcypress\s+run\b/,
  /\bpytest\b/,
  /\bgo\s+test\b/,
  /\bcargo\s+test\b/,
  /\bnode\s+--test\b/,
];

export function isTestCommand(command) {
  return TEST_RUNNERS.some((pattern) => pattern.test(command));
}

export function readPhase(projectDir) {
  try {
    return readFileSync(join(projectDir, '.claude', 'orchestrator', 'phase'), 'utf8').trim();
  } catch {
    return '';
  }
}

export function decide(input, env = process.env) {
  if (input?.tool_name !== 'Bash') return { allow: true };
  const command = input?.tool_input?.command;
  if (typeof command !== 'string' || !isTestCommand(command)) return { allow: true };

  const projectDir = env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
  const phase = readPhase(projectDir);
  if (!BLOCKED_PHASES.has(phase)) return { allow: true };

  return {
    allow: false,
    reason:
      `Test runners are blocked during the "${phase}" phase of the repo-orchestrator run. ` +
      'Tests run only in the final verification stage. Finish the stage, then the orchestrator ' +
      'moves the phase to "verification". To stop the run instead, remove .claude/orchestrator/phase.',
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
