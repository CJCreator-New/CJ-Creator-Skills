#!/usr/bin/env node
// Checks an OpenAPI 3 document (JSON) against the journeys in the ledger and against the frontend's
// API client. The script reports problems; the orchestrator records each one as a gap.
//
// The document is checked for:
//   - every API a journey step names, which must exist in it;
//   - each operation's success and client-error responses;
//   - protection on each state-changing operation (security, or x-public: true);
//   - idempotency, stated for each state-changing operation (x-idempotent, or an Idempotency-Key header);
//   - request bodies that reject unknown fields (additionalProperties: false), so that a client
//     cannot set a field it should not;
//   - unique operation IDs.
// Each frontend client file given with --client is scanned for literal calls, and each call must
// exist in the document.
//
// Usage: contract.mjs check <openapi.json> [--client <file>]...
//
// This is a static check. It does not call the service, and it does not generate the document. The
// client scan is a heuristic: it reads literal paths in fetch and in api/client/http/axios calls,
// and skips paths built from a variable base. Transaction boundaries are not checked here; they are
// a judgment the reviewer makes.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

import { loadLedger } from './ledger.mjs';

const MUTATING = ['post', 'put', 'patch', 'delete'];
const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];

// "POST /expenses/:id/submit" -> { method: 'post', path: '/expenses/{id}/submit' }
export function parseApi(api) {
  const match = /^\s*(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(\S+)\s*$/i.exec(api ?? '');
  if (!match) return null;
  return { method: match[1].toLowerCase(), path: match[2].replace(/:([A-Za-z0-9_]+)/g, '{$1}') };
}

// The request body schema, following a $ref into components.schemas when there is one.
export function bodySchema(body, openapi) {
  const content = body?.content ?? {};
  const media = content['application/json'] ?? Object.values(content)[0];
  let schema = media?.schema;
  if (schema?.$ref) {
    const name = schema.$ref.split('/').pop();
    schema = openapi.components?.schemas?.[name];
  }
  return schema ?? null;
}

const isParam = (segment) => /^(\{.*\}|:.*|\$\{.*\})$/.test(segment);

// Two paths match when they have the same segments, and each segment is equal or a parameter on
// either side. Query strings are ignored.
export function samePath(documented, called) {
  const a = documented.split('?')[0].split('/');
  const b = called.split('?')[0].split('/');
  return a.length === b.length && a.every((s, i) => s === b[i] || isParam(s) || isParam(b[i]));
}

// The literal calls a client source makes. Calls built from a variable base are skipped.
const CLIENT_PATTERNS = {
  fetchWithMethod: /\bfetch\(\s*(['"`])([^'"`]+)\1\s*,\s*\{[^}]*?method:\s*(['"`])(\w+)\3/g,
  fetchGet: /\bfetch\(\s*(['"`])([^'"`]+)\1\s*\)/g,
  clientMethod: /\b(?:api|client|http|axios)\.(get|post|put|patch|delete)\(\s*(['"`])([^'"`]+)\2/g,
};
export function scanClient(source) {
  const calls = [];
  for (const m of source.matchAll(CLIENT_PATTERNS.fetchWithMethod)) calls.push({ method: m[4].toUpperCase(), path: m[2] });
  for (const m of source.matchAll(CLIENT_PATTERNS.fetchGet)) calls.push({ method: 'GET', path: m[2] });
  for (const m of source.matchAll(CLIENT_PATTERNS.clientMethod)) calls.push({ method: m[1].toUpperCase(), path: m[3] });
  return calls.filter((c) => c.path.startsWith('/'));
}

export function checkClientCalls(openapi, calls, label) {
  const problems = [];
  const paths = openapi.paths ?? {};
  for (const call of calls) {
    const found = Object.keys(paths).some((p) => samePath(p, call.path) && paths[p]?.[call.method.toLowerCase()]);
    if (!found) problems.push(`${label}: the client calls ${call.method} ${call.path}, which the document does not define`);
  }
  return problems;
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

      // The effective security is the operation's own list, or the document's default when the
      // operation has none. An empty list means no authentication, so it does not count as protected.
      const security = 'security' in operation ? operation.security : openapi.security;
      const protectedOp = Array.isArray(security) && security.length > 0;
      const mutating = MUTATING.includes(method);
      if (mutating && !protectedOp && operation['x-public'] !== true) {
        fail(`${label}: a state-changing operation must declare security, or x-public: true`);
      }

      const keyHeader = (operation.parameters ?? []).some(
        (p) => p?.in === 'header' && typeof p.name === 'string' && p.name.toLowerCase() === 'idempotency-key',
      );
      if (mutating && operation['x-idempotent'] === undefined && !keyHeader) {
        fail(`${label}: a state-changing operation must state whether it is idempotent (x-idempotent), or take an Idempotency-Key header`);
      }

      if (operation.requestBody) {
        const schema = bodySchema(operation.requestBody, openapi);
        if (!schema) fail(`${label}: the request body has no schema`);
        else if (schema.additionalProperties !== false) {
          fail(`${label}: the request body must reject unknown fields (additionalProperties: false), so a client cannot set a field it should not`);
        }
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

// Returns { code, out }. Usage: check <openapi.json> [--client <file>]...
export function main(argv, env = process.env) {
  const [command, file, ...rest] = argv;
  if (command !== 'check' || !file) throw new Error('usage: contract.mjs check <openapi.json> [--client <file>]...');
  const clients = [];
  for (let i = 0; i < rest.length; i += 2) {
    if (rest[i] !== '--client' || rest[i + 1] === undefined) throw new Error(`unknown option: ${rest[i]}`);
    clients.push(rest[i + 1]);
  }
  const openapi = JSON.parse(readFileSync(file, 'utf8'));
  const problems = checkContract(loadLedger(env.CLAUDE_PROJECT_DIR || process.cwd()), openapi);
  for (const client of clients) {
    problems.push(...checkClientCalls(openapi, scanClient(readFileSync(client, 'utf8')), client));
  }
  if (problems.length === 0) return { code: 0, out: 'contract consistent with the journeys and the client\n' };
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
