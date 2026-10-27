#!/usr/bin/env node
// Test database control for an e2e run: validate, seed and reset. Every write first proves that the
// database is the test database this tool seeded, by reading its run-marker row. A database with no
// marker, or a marker that names another database, is never written. Seeding refuses a database that
// already has tables, so unrelated developer data is never touched.
//
// node scripts/env.mjs validate|seed|reset <config.json> --root <repo>

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { validateRun } from './safety.mjs';

export const MARKER_TABLE = 'qa_run_marker';
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

function ident(name) {
  if (!IDENTIFIER.test(name)) throw new Error(`"${name}" is not a plain table or column name`);
  return name;
}

function resolvePath(root, file) {
  return isAbsolute(file) ? file : resolve(root, file);
}

function databaseFile(config, root) {
  const file = config.db?.file;
  if (typeof file !== 'string' || file.trim() === '') throw new Error('config.db.file is required');
  return resolvePath(root, file);
}

function tableNames(db) {
  return db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => row.name);
}

function readMarker(db) {
  if (!tableNames(db).includes(MARKER_TABLE)) return null;
  return db.prepare(`SELECT name, run_id, seeded_at FROM ${MARKER_TABLE} WHERE id = 1`).get() ?? null;
}

function readSeed(config, root) {
  if (typeof config.db.seed !== 'string') throw new Error('config.db.seed is required: the JSON file of seed rows');
  return JSON.parse(readFileSync(resolvePath(root, config.db.seed), 'utf8'));
}

function insertSeed(db, seed) {
  for (const [table, rows] of Object.entries(seed)) {
    if (!Array.isArray(rows)) throw new Error(`seed table ${table} must be a list of rows`);
    for (const row of rows) {
      const columns = Object.keys(row).map(ident);
      const placeholders = columns.map(() => '?').join(', ');
      db.prepare(`INSERT INTO ${ident(table)} (${columns.join(', ')}) VALUES (${placeholders})`).run(...Object.values(row));
    }
  }
}

function counts(db, seed) {
  const out = {};
  for (const table of Object.keys(seed)) out[table] = db.prepare(`SELECT COUNT(*) AS n FROM ${ident(table)}`).get().n;
  return out;
}

// Checks that the configured database is the test database this tool seeded. Returns the reasons it
// is not, so the caller can stop with all of them.
export function validateTarget({ config, root }) {
  const reasons = [];
  if (!config.db) return { ok: false, reasons: ['no database is declared in the config'], file: null };
  const decision = validateRun(config);
  if (!decision.allowed) reasons.push(...decision.problems);
  const file = databaseFile(config, root);
  if (!existsSync(file)) return { ok: false, reasons: [...reasons, `database file ${file} does not exist`], file };
  const db = new DatabaseSync(file);
  try {
    const marker = readMarker(db);
    if (!marker) reasons.push(`database has no ${MARKER_TABLE} row, so it was not seeded by this tool and is not written`);
    else if (marker.name !== config.db.name) reasons.push(`database marker names "${marker.name}", not "${config.db.name}"`);
  } finally {
    db.close();
  }
  return { ok: reasons.length === 0, reasons, file };
}

// Creates the schema, the marker and the seed rows in a database that has no tables yet.
export function seedDatabase({ config, root, runId = randomUUID(), now }) {
  const decision = validateRun(config);
  if (!decision.allowed) throw new Error(`refused: ${decision.problems.join('; ')}`);
  if (typeof config.db?.schema !== 'string') throw new Error('config.db.schema is required: the SQL file that creates the tables');
  const file = databaseFile(config, root);
  const schema = readFileSync(resolvePath(root, config.db.schema), 'utf8');
  const seed = readSeed(config, root);
  const db = new DatabaseSync(file);
  try {
    if (tableNames(db).length > 0) {
      throw new Error('database already has tables, so seeding refuses it. Only a database this tool seeded can be reset.');
    }
    db.exec('BEGIN');
    try {
      db.exec(schema);
      db.exec(`CREATE TABLE ${MARKER_TABLE} (id INTEGER PRIMARY KEY CHECK (id = 1), name TEXT NOT NULL, run_id TEXT NOT NULL, seeded_at TEXT NOT NULL)`);
      db.prepare(`INSERT INTO ${MARKER_TABLE} (id, name, run_id, seeded_at) VALUES (1, ?, ?, ?)`).run(config.db.name, runId, now);
      insertSeed(db, seed);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { runId, rows: counts(db, seed) };
  } finally {
    db.close();
  }
}

// Deletes the rows of every seeded table, then seeds them again. Refused unless the config allows
// reset and the database passes validateTarget.
export function resetDatabase({ config, root, now }) {
  if (config.allowReset !== true) throw new Error('reset is not allowed: the config sets allowReset to false');
  const target = validateTarget({ config, root });
  if (!target.ok) throw new Error(`refused: ${target.reasons.join('; ')}`);
  const seed = readSeed(config, root);
  const db = new DatabaseSync(target.file);
  try {
    db.exec('BEGIN');
    for (const table of Object.keys(seed).reverse()) db.exec(`DELETE FROM ${ident(table)}`);
    insertSeed(db, seed);
    db.prepare(`UPDATE ${MARKER_TABLE} SET seeded_at = ? WHERE id = 1`).run(now);
    const rows = counts(db, seed);
    for (const [table, n] of Object.entries(rows)) {
      if (n !== seed[table].length) throw new Error(`reset left ${table} with ${n} rows, not ${seed[table].length}`);
    }
    db.exec('COMMIT');
    return { rows };
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    db.close();
  }
}

// Reads the rows of one SELECT, on a connection the caller does not keep open.
export function queryDatabase({ config, root, sql }) {
  if (!/^\s*select\b/i.test(sql) || sql.includes(';')) throw new Error('only one SELECT statement may be run against the database');
  const db = new DatabaseSync(databaseFile(config, root));
  try {
    return db.prepare(sql).all().map((row) => ({ ...row }));
  } finally {
    db.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const [command, configArg] = args;
  let root = '.';
  const rootIndex = args.indexOf('--root');
  if (rootIndex >= 0) root = args[rootIndex + 1];
  root = resolve(root);
  try {
    const config = JSON.parse(readFileSync(resolve(root, configArg), 'utf8'));
    const now = new Date().toISOString();
    let output;
    if (command === 'validate') output = validateTarget({ config, root });
    else if (command === 'seed') output = seedDatabase({ config, root, now });
    else if (command === 'reset') output = resetDatabase({ config, root, now });
    else throw new Error('usage: env.mjs validate|seed|reset <config.json> --root <repo>');
    console.log(JSON.stringify(output, null, 2));
    if (command === 'validate' && !output.ok) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
