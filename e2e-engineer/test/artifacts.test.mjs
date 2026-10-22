import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { fixtureLedger, NOW } from './helpers.mjs';
import { DATA_FILES, NAMES, renderArtifacts, writeArtifacts } from '../scripts/artifacts.mjs';
import { freezePlan, approvePlan } from '../scripts/plan.mjs';

function frozenAndApproved() {
  const ledger = fixtureLedger();
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  return ledger;
}

test('renders the twelve artifact files and the five data files', () => {
  const files = renderArtifacts(fixtureLedger(), { now: NOW });
  for (const name of [...Object.values(NAMES), ...Object.values(DATA_FILES)]) {
    assert.ok(files[name], `missing ${name}`);
  }
  assert.equal(Object.keys(files).length, 17);
});

test('the same ledger and the same time give the same bytes', () => {
  const a = renderArtifacts(fixtureLedger(), { now: NOW });
  const b = renderArtifacts(fixtureLedger(), { now: NOW });
  assert.deepEqual(a, b);
});

test('a plan that is not approved says so, and the gate is blocked', () => {
  const summary = renderArtifacts(fixtureLedger(), { now: NOW })[NAMES.summary];
  assert.match(summary, /Status: \*\*BLOCKED\*\*/);
  assert.match(summary, /Approval: none/);
});

test('an approved plan reports partially tested, with the approver and the digest', () => {
  const ledger = frozenAndApproved();
  const summary = renderArtifacts(ledger, { now: NOW })[NAMES.summary];
  assert.match(summary, /Status: \*\*PARTIALLY TESTED\*\*/);
  assert.match(summary, /Approval: tester on 2026-10-22/);
});

test('the RBAC matrix states each outcome, with its condition, and a denied role where there is one', () => {
  const rbac = renderArtifacts(fixtureLedger(), { now: NOW })[NAMES.rbac];
  assert.match(rbac, /\| PERM-APPROVE \| conditional \(same tenant, not own request\) \| conditional \(same tenant, not own request, total up to 1000\) \| conditional \(same tenant\) \| denied \|/);
  assert.match(rbac, /\| PERM-CREATE \| allowed \| allowed \| allowed \| allowed \|/);
});

test('every test case appears in the catalogue', () => {
  const ledger = fixtureLedger();
  const catalog = renderArtifacts(ledger, { now: NOW })[NAMES.catalog];
  for (const test of ledger.testCases) assert.ok(catalog.includes(`| ${test.id} |`), test.id);
});

test('the requirement table shows a derived, unconfirmed requirement as not confirmed', () => {
  const acceptance = renderArtifacts(fixtureLedger(), { now: NOW })[NAMES.acceptance];
  assert.match(acceptance, /\| REQ-APR-004 .*no \(derived\)/);
});

test('the report keeps coverage as separate counts, with no combined percentage', () => {
  const report = renderArtifacts(fixtureLedger(), { now: NOW })[NAMES.report];
  assert.match(report, /\| Requirements with test cases \| 15 of 15 \|/);
  assert.match(report, /\| P0 journeys with test cases \| 4 of 4 \|/);
  assert.match(report, /\| Controls mapped to test cases \| 8 of 11 \|/);
  assert.doesNotMatch(report, /\d+%/);
  assert.match(report, /- control SCR-ORDERS\.order-link is not mapped to a test case/);
});

test('no credential value appears in any artifact, and the environment-variable names do', () => {
  const files = renderArtifacts(fixtureLedger(), { now: NOW });
  const text = Object.values(files).join('\n');
  for (const secret of ['admin-pass', 'manager-pass', 'staff-pass', 'outsider-pass']) {
    assert.ok(!text.includes(secret), `${secret} leaked into an artifact`);
  }
  assert.match(text, /E2E_ADMIN_PASSWORD/);
});

test('the data files are canonical JSON', () => {
  const files = renderArtifacts(fixtureLedger(), { now: NOW });
  const rbac = JSON.parse(files[DATA_FILES.rbac]);
  assert.deepEqual(rbac.roles, ['admin', 'manager', 'manager-other-tenant', 'staff']);
  const keys = Object.keys(JSON.parse(files[DATA_FILES.catalog])[0]);
  assert.deepEqual(keys, [...keys].sort());
});

test('writeArtifacts writes every file under the output folder', () => {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-artifacts-'));
  try {
    const written = writeArtifacts(fixtureLedger(), dir, { now: NOW });
    assert.equal(written.length, 17);
    assert.match(readFileSync(join(dir, NAMES.summary), 'utf8'), /# 00 QA executive summary/);
    assert.ok(readFileSync(join(dir, DATA_FILES.defects), 'utf8').includes('"defects": []'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
