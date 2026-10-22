#!/usr/bin/env node
// Records stage timings, reported token usage, defects and correction iterations for one
// frontend-engineer run, and prints a summary. Entries are appended to
// <project>/.claude/frontend-engineer/telemetry.jsonl. A metric that was never recorded is
// reported as "unavailable" in the summary. It is never estimated.
//
// Usage:
//   telemetry.mjs start <stage>
//   telemetry.mjs end <stage>
//   telemetry.mjs tokens <agent> <input> <output>
//   telemetry.mjs defect <critical|high|medium|low> [--fixed]
//   telemetry.mjs iteration
//   telemetry.mjs summary

import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const SEVERITIES = ['critical', 'high', 'medium', 'low'];

const USAGE =
  'usage: telemetry.mjs start|end <stage> | tokens <agent> <input> <output> | ' +
  'defect <severity> [--fixed] | iteration | summary';

export function telemetryPath(projectDir) {
  return join(projectDir, '.claude', 'frontend-engineer', 'telemetry.jsonl');
}

export function toEntry(command, args) {
  switch (command) {
    case 'start':
    case 'end':
      if (!args[0]) throw new Error(`${command} needs a stage name`);
      return { type: command, stage: args[0] };
    case 'tokens': {
      const [agent, input, output] = args;
      if (!agent || !isCount(input) || !isCount(output)) {
        throw new Error('tokens needs: <agent> <input> <output>, as non-negative integers');
      }
      return { type: 'tokens', agent, input: Number(input), output: Number(output) };
    }
    case 'defect': {
      const [severity, flag] = args;
      if (!SEVERITIES.includes(severity)) {
        throw new Error(`defect severity must be one of ${SEVERITIES.join(', ')}`);
      }
      return { type: 'defect', severity, fixed: flag === '--fixed' };
    }
    case 'iteration':
      return { type: 'iteration' };
    default:
      throw new Error(USAGE);
  }
}

export function parseEntries(text) {
  return text.split('\n').filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line)];
    } catch {
      return [];
    }
  });
}

export function summarize(entries) {
  const openStages = new Map();
  const stageMs = {};
  const tokens = { input: 0, output: 0, reportedCalls: 0 };
  const defects = Object.fromEntries(SEVERITIES.map((s) => [s, { found: 0, fixed: 0 }]));
  let iterations = 0;

  for (const entry of entries) {
    if (entry.type === 'start') {
      openStages.set(entry.stage, Date.parse(entry.ts));
    } else if (entry.type === 'end' && openStages.has(entry.stage)) {
      const elapsed = Date.parse(entry.ts) - openStages.get(entry.stage);
      stageMs[entry.stage] = (stageMs[entry.stage] ?? 0) + elapsed;
      openStages.delete(entry.stage);
    } else if (entry.type === 'tokens') {
      tokens.input += entry.input;
      tokens.output += entry.output;
      tokens.reportedCalls += 1;
    } else if (entry.type === 'defect' && defects[entry.severity]) {
      defects[entry.severity].found += 1;
      if (entry.fixed) defects[entry.severity].fixed += 1;
    } else if (entry.type === 'iteration') {
      iterations += 1;
    }
  }

  return {
    stageMs,
    tokens: tokens.reportedCalls > 0 ? tokens : 'unavailable',
    defects,
    iterations,
  };
}

export function record(file, entry, now = new Date()) {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify({ ts: now.toISOString(), ...entry })}\n`);
}

export function main(argv, env = process.env) {
  const [command, ...args] = argv;
  const file = telemetryPath(env.CLAUDE_PROJECT_DIR || process.cwd());

  if (command === 'summary') {
    const text = existsSync(file) ? readFileSync(file, 'utf8') : '';
    return `${JSON.stringify(summarize(parseEntries(text)), null, 2)}\n`;
  }

  record(file, toEntry(command, args));
  return '';
}

const isCount = (value) => typeof value === 'string' && /^\d+$/.test(value);

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.stdout.write(main(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
