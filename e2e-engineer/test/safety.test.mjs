import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { productionLike, validateRun } from '../scripts/safety.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const example = JSON.parse(readFileSync(join(HERE, '../templates/qa.config.example.json'), 'utf8'));
const clone = (value) => JSON.parse(JSON.stringify(value));

test('the example config is allowed, with security probes refused until authorization is recorded', () => {
  const decision = validateRun(example);
  assert.equal(decision.allowed, true, decision.problems.join('; '));
  assert.equal(decision.securityProbes.allowed, false);
  assert.match(decision.securityProbes.reason, /static checks only/);
});

test('refuses a web host that is not on the allowlist', () => {
  const config = clone(example);
  config.targets.web.baseUrl = 'https://app.other.example';
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /host "app.other.example" is not on the allowlist/);
});

test('refuses a production-looking host even when it is on the allowlist', () => {
  const config = clone(example);
  config.allowlist.hosts.push('api.prod.example.com');
  config.targets.web.baseUrl = 'https://api.prod.example.com';
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /looks like production and is refused/);
});

test('refuses an Android package that is not on the allowlist', () => {
  const config = clone(example);
  config.targets.android = { packageName: 'com.other.app' };
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /package "com.other.app" is not on the allowlist/);
});

test('refuses an iOS bundle that is not on the allowlist', () => {
  const config = clone(example);
  config.targets.ios = { bundleId: 'com.other.app' };
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /bundle "com.other.app" is not on the allowlist/);
});

test('refuses a database whose name does not match the allowlist pattern', () => {
  const config = clone(example);
  config.db.name = 'orders';
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /db "orders" does not match allowlist.dbNamePattern/);
});

test('refuses a database whose name looks like production, even if the pattern matches it', () => {
  const config = clone(example);
  config.allowlist.dbNamePattern = '.*';
  config.db.name = 'prod_orders';
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /looks like production/);
});

test('refuses a database pattern that is not a valid regular expression', () => {
  const config = clone(example);
  config.allowlist.dbNamePattern = '(';
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /not a valid regular expression/);
});

test('refuses reset when no database is declared', () => {
  const config = clone(example);
  delete config.db;
  config.allowReset = true;
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /allowReset is true but no db is declared/);
});

test('allows reset only with a declared database that passes every check', () => {
  const config = clone(example);
  config.allowReset = true;
  const decision = validateRun(config);
  assert.equal(decision.allowed, true);
  assert.equal(decision.resetAllowed, true);
  assert.equal(validateRun(example).resetAllowed, false);
});

test('refuses a non-http scheme', () => {
  const config = clone(example);
  config.targets.web.baseUrl = 'ftp://localhost';
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /must use http or https/);
});

test('refuses a config with no targets', () => {
  const config = clone(example);
  config.targets = {};
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /at least one of web, mobile-web, android, ios/);
});

test('refuses a partial authorization, and refuses security probes with it', () => {
  const config = clone(example);
  config.authorization = { scope: 'staging', authorizedBy: 'lead' };
  const decision = validateRun(config);
  assert.equal(decision.allowed, false);
  assert.match(decision.problems.join(' '), /authorization.date is required/);
});

test('a complete authorization allows security probes', () => {
  const config = clone(example);
  config.authorization = { scope: 'local fixture', authorizedBy: 'test owner', date: '2026-10-22' };
  const decision = validateRun(config);
  assert.equal(decision.allowed, true);
  assert.equal(decision.securityProbes.allowed, true);
});

test('production-like names are recognised as whole words only', () => {
  for (const name of ['prod', 'api-prod.example.com', 'live.example', 'production', 'prod_orders']) {
    assert.equal(productionLike(name), true, name);
  }
  for (const name of ['product', 'reproduction', 'localhost', 'test_orders', 'deliver']) {
    assert.equal(productionLike(name), false, name);
  }
});
