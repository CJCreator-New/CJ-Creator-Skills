import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { emptyLedger, recordIntake } from '../scripts/ledger.mjs';
import { loadPlan } from '../scripts/plan.mjs';
import { seedDatabase } from '../scripts/env.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const NOW = '2026-10-22T00:00:00.000Z';
export const FIXTURE_PLAN = join(HERE, '../fixtures/planted-app/plan.json');
export const FIXTURE_DIR = join(HERE, '../fixtures/planted-app');

export function readFixturePlan() {
  return JSON.parse(readFileSync(FIXTURE_PLAN, 'utf8'));
}

// A ledger for a run that intake allowed, with the given target readiness.
export function allowedLedger(readiness = { web: { status: 'ready' }, 'mobile-web': { status: 'ready' } }) {
  const ledger = emptyLedger();
  recordIntake(ledger, {
    configName: 'fixture',
    safety: {
      allowed: true,
      problems: [],
      resetAllowed: false,
      securityProbes: { allowed: false, reason: 'no authorization is recorded' },
    },
    build: { commit: 'abc123', treeHash: 'def456', current: true, note: null },
    probes: {},
    readiness,
    targets: { web: { baseUrl: 'http://localhost:4173' }, 'mobile-web': { baseUrl: 'http://localhost:4173' } },
    now: NOW,
  });
  return ledger;
}

// An allowed ledger with the planted-app plan loaded.
export function fixtureLedger(readiness) {
  const ledger = allowedLedger(readiness);
  loadPlan(ledger, readFixturePlan());
  return ledger;
}

// A deep copy, so a test can change one item without changing the shared fixture.
export function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

// A fresh, seeded test database in its own folder. Call cleanup() when the test ends.
export function seededDatabase({ allowReset = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'e2e-db-'));
  const config = {
    name: 'fixture',
    targets: { web: { baseUrl: 'http://127.0.0.1:4173' } },
    allowlist: { hosts: ['127.0.0.1'], dbNamePattern: '^(test|qa)_' },
    db: {
      engine: 'sqlite',
      name: 'test_fixture',
      file: 'orders.sqlite',
      schema: join(FIXTURE_DIR, 'schema.sql'),
      seed: join(FIXTURE_DIR, 'seed.json'),
    },
    allowReset,
    authorization: null,
  };
  seedDatabase({ config, root, now: NOW });
  return {
    root,
    config,
    file: join(root, 'orders.sqlite'),
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}
