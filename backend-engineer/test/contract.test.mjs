import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { checkContract, parseApi } from '../scripts/contract.mjs';

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
