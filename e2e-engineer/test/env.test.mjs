import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import { clone, NOW, seededDatabase } from './helpers.mjs';
import { MARKER_TABLE, queryDatabase, resetDatabase, seedDatabase, validateTarget } from '../scripts/env.mjs';

function sql(file, statement) {
  const db = new DatabaseSync(file);
  try {
    return db.prepare(statement).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

function exec(file, statement) {
  const db = new DatabaseSync(file);
  try {
    db.exec(statement);
  } finally {
    db.close();
  }
}

test('seeding writes the marker and the seed rows', () => {
  const db = seededDatabase();
  try {
    assert.deepEqual(sql(db.file, `SELECT name FROM ${MARKER_TABLE}`), [{ name: 'test_fixture' }]);
    assert.deepEqual(sql(db.file, 'SELECT COUNT(*) AS n FROM users')[0].n, 4);
    assert.deepEqual(sql(db.file, 'SELECT COUNT(*) AS n FROM orders')[0].n, 4);
  } finally {
    db.cleanup();
  }
});

test('seeding refuses a database that already has tables, and writes nothing', () => {
  const db = seededDatabase();
  try {
    assert.throws(() => seedDatabase({ config: db.config, root: db.root, now: NOW }), /already has tables/);
    assert.deepEqual(sql(db.file, 'SELECT COUNT(*) AS n FROM orders')[0].n, 4);
  } finally {
    db.cleanup();
  }
});

test('seeding refuses a config whose database name does not match the allowlist', () => {
  const db = seededDatabase();
  try {
    const config = clone(db.config);
    config.db.name = 'orders';
    assert.throws(() => seedDatabase({ config, root: db.root, now: NOW }), /does not match allowlist/);
  } finally {
    db.cleanup();
  }
});

test('a failed seed leaves no tables behind', () => {
  const db = seededDatabase();
  try {
    // A table name that is not a plain identifier fails inside the transaction, so the seed rolls back.
    const bad = join(db.root, 'bad-seed.json');
    writeFileSync(bad, JSON.stringify({ 'users; DROP TABLE users': [{ id: 'x' }] }));
    const config = clone(db.config);
    config.db.file = 'other.sqlite';
    config.db.seed = bad;
    assert.throws(() => seedDatabase({ config, root: db.root, now: NOW }), /not a plain table or column name/);
    assert.deepEqual(sql(join(db.root, 'other.sqlite'), "SELECT name FROM sqlite_master WHERE type = 'table'"), []);
  } finally {
    db.cleanup();
  }
});

test('validation refuses a database with no marker, so it is never written', () => {
  const db = seededDatabase();
  try {
    exec(db.file, `DROP TABLE ${MARKER_TABLE}`);
    const result = validateTarget({ config: db.config, root: db.root });
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(' '), /has no qa_run_marker row, so it was not seeded by this tool/);
  } finally {
    db.cleanup();
  }
});

test('validation refuses a marker that names another database', () => {
  const db = seededDatabase();
  try {
    exec(db.file, `UPDATE ${MARKER_TABLE} SET name = 'test_other' WHERE id = 1`);
    const result = validateTarget({ config: db.config, root: db.root });
    assert.equal(result.ok, false);
    assert.match(result.reasons.join(' '), /marker names "test_other", not "test_fixture"/);
  } finally {
    db.cleanup();
  }
});

test('validation passes for a database this tool seeded', () => {
  const db = seededDatabase();
  try {
    assert.deepEqual(validateTarget({ config: db.config, root: db.root }).reasons, []);
  } finally {
    db.cleanup();
  }
});

test('reset restores the seed after the rows were changed', () => {
  const db = seededDatabase();
  try {
    exec(db.file, "UPDATE orders SET status = 'approved', approvals = 1 WHERE id = 'o-1'; INSERT INTO orders VALUES ('o-9', 't1', 'u-staff', 'Extra', 1, 'pending', 0);");
    const { rows } = resetDatabase({ config: db.config, root: db.root, now: NOW });
    assert.deepEqual(rows, { users: 4, orders: 4 });
    assert.deepEqual(sql(db.file, "SELECT status, approvals FROM orders WHERE id = 'o-1'"), [{ status: 'pending', approvals: 0 }]);
    assert.equal(sql(db.file, "SELECT COUNT(*) AS n FROM orders WHERE id = 'o-9'")[0].n, 0);
  } finally {
    db.cleanup();
  }
});

test('reset is refused unless the config allows it', () => {
  const db = seededDatabase({ allowReset: false });
  try {
    assert.throws(() => resetDatabase({ config: db.config, root: db.root, now: NOW }), /reset is not allowed/);
  } finally {
    db.cleanup();
  }
});

test('reset is refused for a database whose marker does not match the config', () => {
  const db = seededDatabase();
  try {
    const config = clone(db.config);
    config.db.name = 'test_renamed';
    assert.throws(() => resetDatabase({ config, root: db.root, now: NOW }), /refused: database marker names "test_fixture", not "test_renamed"/);
  } finally {
    db.cleanup();
  }
});

test('a query accepts one SELECT, and refuses anything else', () => {
  const db = seededDatabase();
  try {
    assert.equal(queryDatabase({ config: db.config, root: db.root, sql: 'SELECT COUNT(*) AS n FROM users' })[0].n, 4);
    assert.throws(() => queryDatabase({ config: db.config, root: db.root, sql: 'DELETE FROM users' }), /only one SELECT/);
    assert.throws(() => queryDatabase({ config: db.config, root: db.root, sql: 'SELECT 1; DROP TABLE users' }), /only one SELECT/);
  } finally {
    db.cleanup();
  }
});
