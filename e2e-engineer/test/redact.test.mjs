import { test } from 'node:test';
import assert from 'node:assert/strict';

import { redactBody, redactHeaders, redactString, redactValue, REDACTED } from '../scripts/redact.mjs';

test('a bearer token and a JWT-shaped value are removed from text', () => {
  assert.equal(redactString('Authorization: Bearer abc.def-123'), `Authorization: Bearer ${REDACTED}`);
  assert.equal(redactString('token eyJhbGciOi.eyJzdWIiOi.c2lnbmF0dXJl here'), `token ${REDACTED} here`);
});

test('a credential in a query string is removed, and the rest of the URL is kept', () => {
  assert.equal(redactString('https://app.test/x?page=2&token=secret-value#/a'), `https://app.test/x?page=2&token=${REDACTED}#/a`);
});

test('a known secret value is removed wherever it appears, if it is long enough to be a secret', () => {
  assert.equal(redactString('the password is manager-pass, again manager-pass', ['manager-pass']), `the password is ${REDACTED}, again ${REDACTED}`);
  assert.equal(redactString('abc is short', ['abc']), 'abc is short', 'a value under four characters is not treated as a secret');
});

test('a header that names a credential is replaced whole, and other headers are kept', () => {
  assert.deepEqual(redactHeaders({ Authorization: 'Bearer x', cookie: 'sid=1', 'content-type': 'application/json' }), {
    Authorization: REDACTED,
    cookie: REDACTED,
    'content-type': 'application/json',
  });
});

test('a JSON key that names a credential is replaced whole, at any depth', () => {
  assert.deepEqual(redactValue({ username: 'manager', password: 'x', nested: { apiToken: 'y', ok: 1 }, list: [{ secret: 'z' }] }), {
    username: 'manager',
    password: REDACTED,
    nested: { apiToken: REDACTED, ok: 1 },
    list: [{ secret: REDACTED }],
  });
});

test('a body is redacted by key when it is JSON, and as text when it is not', () => {
  assert.deepEqual(redactBody('{"username":"manager","password":"manager-pass"}', ['manager-pass']), { username: 'manager', password: REDACTED });
  assert.equal(redactBody('plain manager-pass text', ['manager-pass']), `plain ${REDACTED} text`);
  assert.equal(redactBody(''), '');
});

test('a value that is not a credential is never changed', () => {
  assert.deepEqual(redactValue({ total: 500, item: 'Desk', status: 'pending' }), { total: 500, item: 'Desk', status: 'pending' });
});
