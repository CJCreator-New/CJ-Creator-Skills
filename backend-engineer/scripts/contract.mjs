#!/usr/bin/env node
// Checks an OpenAPI 3 document (JSON) against the journeys in the ledger. Each API a journey step
// names must exist in the document, and the document must describe its operations well enough to
// implement and test them. The script reports problems; the orchestrator records each one as a gap.
//
// Usage: contract.mjs check <openapi.json>
//
// This is a static check of the document. It does not call the running service, and it does not
// generate the document. Generating it depends on the framework the project already uses.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadLedger } from './ledger.mjs';

const MUTATING = ['post', 'put', 'patch', 'delete'];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// "POST /expenses/:id/submit" -> { method: 'POST', path: '/expenses/{id}/submit' }
export function parseApi(api) {
  const match = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s*$/i.exec(api ?? '');
  if (!match) return null;
  return { method: match[1].toLowerCase(), path: match[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}') };
}

export function checkContract(ledger, openapi) {
  const problems = [];
  const fail = (message) => problems.push(message);

  if (typeof openapi?.openapi !== 'string' || !openapi.openapi.startsWith('3.')) {
    fail('the document must declare an OpenAPI 3 version');
    return problems;
  }
  const paths = openapi.paths ?? {};
  const operationIds = new Set();

  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const operation = item?.[method];
      if (!operation) continue;
      const label = `${method.toUpperCase()} ${path}`;
      const responses = Object.keys(operation.responses ?? {});
      if (!responses.some((code) => code.startsWith('2'))) fail(`${label}: no success response documented`);
      if (!responses.some((code) => code.startsWith('4'))) fail(`${label}: no client error response documented`);
      if (MUTATING.includes(method) && !('security' in operation) && operation['x-public'] !== true) {
        fail(`${label}: a state-changing operation must declare security, or x-public: true`);
      }
      if (operation.operationId) {
        if (operationIds.has(operation.operationId)) fail(`${label}: duplicate operationId ${operation.operationId}`);
        operationIds.add(operation.operationId);
      }
    }
  }

  for (const journey of ledger.journeys ?? []) {
    for (const step of journey.steps ?? []) {
      if (!step.api) continue;
      const parsed = parseApi(step.api);
      if (!parsed) {
        fail(`${journey.id}: api "${step.api}" is not a method and path`);
        continue;
      }
      if (!paths[parsed.path]?.[parsed.method]) {
        fail(`${journey.id}: ${parsed.method.toUpperCase()} ${parsed.path} is used by the journey but not in the document`);
      }
    }
  }
  return problems;
}

export function main(argv, env = process.env) {
  const [command, file] = argv;
  if (command !== 'check' || !file) throw new Error('usage: contract.mjs check <openapi.json>');
  const openapi = JSON.parse(readFileSync(file, 'utf8'));
  const problems = checkContract(loadLedger(env.CLAUDE_PROJECT_DIR || process.cwd()), openapi);
  if (problems.length === 0) return { code: 0, out: 'contract consistent with the journeys\n' };
  return { code: 1, out: `${problems.length} contract problem(s):\n${problems.map((p) => `  - ${p}`).join('\n')}\n` };
}

const isMain = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  try {
    const { code, out } = main(process.argv.slice(2));
    process.stdout.write(out);
    process.exit(code);
  } catch (err) {
    process.stderr.write(`${err.message}\n`);
    process.exit(1);
  }
}
