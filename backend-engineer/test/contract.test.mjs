import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkClientCalls, checkContract, main as contractMain, parseApi, samePath, scanClient } from '../scripts/contract.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const load = (name) => JSON.parse(readFileSync(resolve(HERE, '../examples', name), 'utf8'));
const { _comment, ...LEDGER } = load('ledger.example.json');
const OPENAPI = load('openapi.example.json');

test('parseApi turns route parameters into OpenAPI braces', () => {
  assert.deepEqual(parseApi('POST /expenses/:id/submit'), { method: 'post', path: '/expenses/{id}/submit' });
  assert.equal(parseApi('submit the form'), null);
});

test('the example contract is consistent with the example journeys', () => {
  assert.deepEqual(checkContract(LEDGER, OPENAPI), []);
});

test('a journey API missing from the document is reported', () => {
  const doc = structuredClone(OPENAPI);
  delete doc.paths['/expenses/{id}/submit'];
  const problems = checkContract(LEDGER, doc);
  assert.match(problems.join('\n'), /J-01: POST \/expenses\/\{id\}\/submit is used by the journey but not in the document/);
});

test('an operation with no documented error response is reported', () => {
  const doc = structuredClone(OPENAPI);
  doc.paths['/expenses/{id}'].get.responses = { 200: { description: 'ok' } };
  assert.match(checkContract(LEDGER, doc).join('\n'), /GET \/expenses\/\{id\}: no client error response documented/);
});

test('a state-changing operation without security or an explicit public flag is reported', () => {
  const doc = structuredClone(OPENAPI);
  delete doc.paths['/expenses/{id}/submit'].post.security;
  assert.match(checkContract(LEDGER, doc).join('\n'), /state-changing operation must declare security/);
  doc.paths['/expenses/{id}/submit'].post['x-public'] = true;
  assert.deepEqual(checkContract(LEDGER, doc), []);
});

test('duplicate operation ids and a non-3 document are reported', () => {
  const doc = structuredClone(OPENAPI);
  doc.paths['/expenses/{id}'].get.operationId = 'submitExpenseReport';
  assert.match(checkContract(LEDGER, doc).join('\n'), /duplicate operationId submitExpenseReport/);
  assert.match(checkContract(LEDGER, { openapi: '2.0', paths: {} }).join('\n'), /OpenAPI 3 version/);
});

test('a journey API that is not a method and path is reported', () => {
  const ledger = structuredClone(LEDGER);
  ledger.journeys[0].steps[0].api = 'submit the form';
  assert.match(checkContract(ledger, OPENAPI).join('\n'), /is not a method and path/);
});

test('an empty security list means no authentication, so a state-changing operation is still reported', () => {
  const doc = structuredClone(OPENAPI);
  doc.paths['/expenses/{id}/submit'].post.security = [];
  assert.match(checkContract(LEDGER, doc).join('\n'), /POST \/expenses\/\{id\}\/submit: a state-changing operation must declare security/);
  doc.paths['/expenses/{id}/submit'].post['x-public'] = true;
  assert.deepEqual(checkContract(LEDGER, doc), []);
});

test('security inherited from the document default counts for an operation that does not name its own', () => {
  const doc = structuredClone(OPENAPI);
  doc.security = [{ bearerAuth: [] }];
  delete doc.paths['/expenses/{id}/submit'].post.security;
  assert.deepEqual(checkContract(LEDGER, doc), []);
  doc.security = [];
  assert.match(checkContract(LEDGER, doc).join('\n'), /must declare security/);
});

test('a state-changing operation must say whether it is idempotent, or take an Idempotency-Key header', () => {
  const doc = structuredClone(OPENAPI);
  delete doc.paths['/expenses/{id}/submit'].post['x-idempotent'];
  assert.match(checkContract(LEDGER, doc).join('\n'), /must state whether it is idempotent/);
  doc.paths['/expenses/{id}/submit'].post.parameters = [{ name: 'Idempotency-Key', in: 'header', required: true, schema: { type: 'string' } }];
  assert.deepEqual(checkContract(LEDGER, doc), []);
});

test('a request body must reject unknown fields, inline or through a $ref', () => {
  const doc = structuredClone(OPENAPI);
  doc.components.schemas = {
    Draft: { type: 'object', properties: { note: { type: 'string' } }, additionalProperties: false },
    Loose: { type: 'object', properties: { note: { type: 'string' } } },
  };
  doc.paths['/expenses/{id}/submit'].post.requestBody = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Loose' } } } };
  assert.match(checkContract(LEDGER, doc).join('\n'), /request body must reject unknown fields/);
  doc.paths['/expenses/{id}/submit'].post.requestBody = { content: { 'application/json': { schema: { $ref: '#/components/schemas/Draft' } } } };
  assert.deepEqual(checkContract(LEDGER, doc), []);
  doc.paths['/expenses/{id}/submit'].post.requestBody = { content: {} };
  assert.match(checkContract(LEDGER, doc).join('\n'), /the request body has no schema/);
});

test('a client literal path is matched to the document, with template and parameter segments', () => {
  assert.equal(samePath('/expenses/{id}/submit', '/expenses/${id}/submit'), true);
  assert.equal(samePath('/expenses/{id}/submit', '/orders/42/submit'), false);
  assert.equal(samePath('/expenses/{id}', '/expenses/{id}?draft=1'), true);
});

test('the client scan finds literal calls, and skips paths built from a variable base', () => {
  const source = `
    await fetch('/expenses/' + id);
    await fetch(\`/expenses/\${id}/submit\`, { method: 'POST', body: '{}' });
    await api.get('/expenses/\${id}');
    await client.delete('/expenses/\${id}');
    await fetch(\`\${base}/expenses\`);
  `;
  assert.deepEqual(scanClient(source), [
    { method: 'POST', path: '/expenses/${id}/submit' },
    { method: 'GET', path: '/expenses/${id}' },
    { method: 'DELETE', path: '/expenses/${id}' },
  ]);
});

test('a client call the document does not define is reported', () => {
  const calls = [{ method: 'POST', path: '/expenses/${id}/submit' }, { method: 'PUT', path: '/expenses/${id}' }];
  const problems = checkClientCalls(OPENAPI, calls, 'src/api.ts');
  assert.deepEqual(problems, ['src/api.ts: the client calls PUT /expenses/${id}, which the document does not define']);
});

test('the contract CLI takes frontend client files, and reports a call the document lacks', () => {
  const dir = mkdtempSync(join(tmpdir(), 'be-client-'));
  try {
    const client = join(dir, 'api.ts');
    writeFileSync(client, "export const cancel = (id) => api.delete(`/expenses/${id}`);\n");
    const doc = join(dir, 'openapi.json');
    writeFileSync(doc, JSON.stringify(OPENAPI));
    const result = contractMain(['check', doc, '--client', client], { CLAUDE_PROJECT_DIR: dir });
    assert.equal(result.code, 1);
    assert.match(result.out, /the client calls DELETE \/expenses\/\$\{id\}, which the document does not define/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
