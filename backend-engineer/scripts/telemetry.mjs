#!/usr/bin/env node
// Telemetry for one backend-engineer run: stage timings, agent dispatches by agent and model,
// reported token usage, agent failures and correction rounds. Entries are appended to
// <project>/.claude/backend-engineer/telemetry.jsonl. A metric that was never recorded is reported
// as "unavailable". Nothing is estimated.
//
// Usage:
//   telemetry.mjs start <stage>
//   telemetry.mjs end <stage>
//   telemetry.mjs dispatch <agent> [--model haiku|sonnet|opus]
//   telemetry.mjs tokens <agent> <input> <output>
//   telemetry.mjs failure <agent> <timeout|blocked|invalid-output|tool-error|model-error>
//   telemetry.mjs iteration <name>
//   telemetry.mjs summary
//   telemetry.mjs compare <before.jsonl> <after.jsonl>
//
// A comparison is meaningful only between runs of the same mode and scope. The script reports the
// numbers; it does not decide that a run was more efficient.

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const FAILURE_KINDS = ['timeout', 'blocked', 'invalid-output', 'tool-error', 'model-error'];
export const MODELS = ['haiku', 'sonnet', 'opus'];

const USAGE =
  'usage: telemetry.mjs start|end <stage> | dispatch <agent> [--model m] | tokens <agent> <in> <out> | ' +
  'failure <agent> <kind> | iteration <name> | summary | compare <before> <after>';

export const telemetryPath = (projectDir) => join(projectDir, '.claude', 'backend-engineer', 'telemetry.jsonl');

export function parseEntries(text) {
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

const isCount = (value) => typeof value === 'string' && /^\d+$/.test(value);

export function toEntry(command, args) {
  switch (command) {
    case 'start':
    case 'end':
      if (!args[0]) throw new Error(`${command} needs a stage name`);
      return { type: command, stage: args[0] };
    case 'dispatch': {
      const [agent, ...flags] = args;
      if (!agent) throw new Error('dispatch needs an agent name');
      let model = null;
      for (let i = 0; i < flags.length; i += 2) {
        if (flags[i] !== '--model' || flags[i + 1] === undefined) throw new Error(`unknown dispatch option: ${flags[i]}`);
        model = flags[i + 1];
      }
      if (model !== null && !MODELS.includes(model)) throw new Error(`model must be one of ${MODELS.join(', ')}`);
      return { type: 'dispatch', agent, model };
    }
    case 'tokens': {
      const [agent, input, output] = args;
      if (!agent || !isCount(input) || !isCount(output)) {
        throw new Error('tokens needs: <agent> <input> <output>, as non-negative integers');
      }
      return { type: 'tokens', agent, input: Number(input), output: Number(output) };
    }
    case 'failure': {
      const [agent, kind] = args;
      if (!agent) throw new Error('failure needs an agent name');
      if (!FAILURE_KINDS.includes(kind)) throw new Error(`failure kind must be one of ${FAILURE_KINDS.join(', ')}`);
      return { type: 'failure', agent, kind };
    }
    case 'iteration':
      if (!args[0]) throw new Error('iteration needs a name, such as the journey or the screen');
      return { type: 'iteration', name: args[0] };
    default:
      throw new Error(USAGE);
  }
}

const sum = (values) => values.reduce((total, n) => total + n, 0);
const count = (list, key) => list.reduce((acc, item) => ({ ...acc, [item[key]]: (acc[item[key]] ?? 0) + 1 }), {});

export function summarize(entries) {
  const open = new Map();
  const stageMs = {};
  const dispatched = [];
  const tokens = { input: 0, output: 0, reportedCalls: 0 };
  const failures = [];
  const iterations = [];

  for (const entry of entries) {
    if (entry.type === 'start') {
      open.set(entry.stage, Date.parse(entry.ts));
    } else if (entry.type === 'end' && open.has(entry.stage)) {
      stageMs[entry.stage] = (stageMs[entry.stage] ?? 0) + Date.parse(entry.ts) - open.get(entry.stage);
      open.delete(entry.stage);
    } else if (entry.type === 'dispatch') {
      dispatched.push({ agent: entry.agent, model: entry.model ?? 'unspecified' });
    } else if (entry.type === 'tokens') {
      tokens.input += entry.input;
      tokens.output += entry.output;
      tokens.reportedCalls += 1;
    } else if (entry.type === 'failure') {
      failures.push({ kind: entry.kind });
    } else if (entry.type === 'iteration') {
      iterations.push({ name: entry.name });
    }
  }

  return {
    stageMs,
    dispatches: {
      total: dispatched.length,
      byAgent: count(dispatched, 'agent'),
      byModel: count(dispatched, 'model'),
    },
    tokens: tokens.reportedCalls > 0 ? tokens : 'unavailable',
    failures: { total: failures.length, byKind: count(failures, 'kind') },
    iterations: { total: iterations.length, byName: count(iterations, 'name') },
  };
}

export function compare(before, after) {
  const a = summarize(before);
  const b = summarize(after);
  const pair = (x, y) => ({ before: x, after: y });
  return {
    elapsedMs: pair(sum(Object.values(a.stageMs)), sum(Object.values(b.stageMs))),
    dispatches: pair(a.dispatches.total, b.dispatches.total),
    failures: pair(a.failures.total, b.failures.total),
    iterations: pair(a.iterations.total, b.iterations.total),
    tokens: pair(a.tokens, b.tokens),
  };
}

export function record(file, entry, now = new Date()) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ts: now.toISOString(), ...entry })}\n`);
}

const readEntries = (file) => (existsSync(file) ? parseEntries(readFileSync(file, 'utf8')) : []);

// Returns the text to print. Recording commands print nothing.
export function main(argv, env = process.env) {
  const [command, ...args] = argv;
  if (command === 'summary') {
    return `${JSON.stringify(summarize(readEntries(telemetryPath(env.CLAUDE_PROJECT_DIR || process.cwd()))), null, 2)}\n`;
  }
  if (command === 'compare') {
    const [before, after] = args;
    if (!before || !after) throw new Error('compare needs two telemetry files');
    if (!existsSync(before) || !existsSync(after)) throw new Error('compare needs two existing telemetry files');
    const result = compare(readEntries(before), readEntries(after));
    return `${JSON.stringify(result, null, 2)}\n`;
  }
  record(telemetryPath(env.CLAUDE_PROJECT_DIR || process.cwd()), toEntry(command, args));
  return '';
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
