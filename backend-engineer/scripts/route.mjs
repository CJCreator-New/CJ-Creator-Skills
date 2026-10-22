#!/usr/bin/env node
// Model routing for one dispatch. Prints the model tier to pass as the Agent tool's model
// parameter, with the reasons, so the choice is traceable.
//
// The rules only raise a tier. Risk, ambiguity and repeated failure move a task up; nothing moves
// it down. A tier is a floor, so a cheap model is never chosen for a task that needs judgment.
//
// Usage: route.mjs <kind> [--risk low|medium|high] [--ambiguous] [--retries n]
// The orchestrator passes the printed model to the Agent tool's model parameter.

import { pathToFileURL } from 'node:url';

export const TIERS = ['haiku', 'sonnet', 'opus'];

export const KIND_TIER = {
  // Mechanical or read-only work
  format: 'haiku',
  docs: 'haiku',
  'repo-search': 'haiku',
  'test-enumeration': 'haiku',
  // Well-specified implementation
  crud: 'sonnet',
  implementation: 'sonnet',
  tests: 'sonnet',
  integration: 'sonnet',
  frontend: 'sonnet',
  e2e: 'sonnet',
  'design-reading': 'sonnet',
  // Judgment: design, authorization, data integrity, concurrency, review
  architecture: 'opus',
  contract: 'opus',
  authorization: 'opus',
  security: 'opus',
  migration: 'opus',
  concurrency: 'opus',
  debugging: 'opus',
  'integration-conflict': 'opus',
  review: 'opus',
};

const RISKS = ['low', 'medium', 'high'];
const USAGE = 'usage: route.mjs <kind> [--risk low|medium|high] [--ambiguous] [--retries n]';

export function raise(tier) {
  const index = TIERS.indexOf(tier);
  return TIERS[Math.min(index + 1, TIERS.length - 1)];
}

export function route({ kind, risk = 'low', ambiguous = false, retries = 0 }) {
  if (!(kind in KIND_TIER)) throw new Error(`unknown kind ${kind}; kinds are ${Object.keys(KIND_TIER).join(', ')}`);
  if (!RISKS.includes(risk)) throw new Error(`risk must be one of ${RISKS.join(', ')}`);
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries must be a non-negative integer');

  let tier = KIND_TIER[kind];
  const reasons = [`${kind} is ${tier}-class work`];

  if (risk === 'medium' && tier === 'haiku') {
    tier = raise(tier);
    reasons.push('medium risk raises haiku work to sonnet');
  }
  if (risk === 'high' && tier !== 'opus') {
    tier = 'opus';
    reasons.push('high risk runs on opus');
  }
  if (ambiguous && tier !== 'opus') {
    tier = raise(tier);
    reasons.push('ambiguous requirements raise one level');
  }
  if (retries >= 2 && tier !== 'opus') {
    tier = raise(tier);
    reasons.push(`${retries} failed attempts raise one level`);
  }
  return { model: tier, reasons };
}

export function parseArgs(args) {
  const [kind, ...flags] = args;
  if (!kind) throw new Error(USAGE);
  const options = { kind, risk: 'low', ambiguous: false, retries: 0 };
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i] === '--ambiguous') options.ambiguous = true;
    else if (flags[i] === '--risk') options.risk = flags[++i];
    else if (flags[i] === '--retries') options.retries = Number(flags[++i]);
    else throw new Error(`unknown option: ${flags[i]}`);
  }
  return options;
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    process.stdout.write(`${JSON.stringify(route(parseArgs(process.argv.slice(2))), null, 2)}\n`);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
