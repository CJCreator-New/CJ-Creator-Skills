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

test('the requirement table shows a derived requirement as confirmed only once it is confirmed', () => {
  assert.match(renderArtifacts(fixtureLedger(), { now: NOW })[NAMES.acceptance], /\| REQ-UI-004 .*\| yes \|/);
  const ledger = fixtureLedger();
  ledger.requirements.find((r) => r.id === 'REQ-UI-004').confirmed = false;
  assert.match(renderArtifacts(ledger, { now: NOW })[NAMES.acceptance], /\| REQ-UI-004 .*no \(derived\)/);
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
    assert.equal(written.length, 18, 'the 17 files and the report manifest');
    assert.match(readFileSync(join(dir, NAMES.summary), 'utf8'), /# 00 QA executive summary/);
    assert.ok(readFileSync(join(dir, DATA_FILES.defects), 'utf8').includes('"defects": []'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the register and the report show remediation, flaky and out-of-scope state from the ledger', async () => {
  const { recordResults } = await import('../scripts/ledger.mjs');
  const { handOff, triageDefect } = await import('../scripts/remediation.mjs');
  const ledger = fixtureLedger();
  freezePlan(ledger, { now: NOW });
  approvePlan(ledger, { approver: 'tester', approvedAt: '2026-10-22' });
  const result = (id, r) => ({ id, result: r, failures: r === 'failed' ? [{ check: 'check 1 (http)', message: 'status was 200' }] : [], reasons: [], evidence: [] });
  recordResults(ledger, [result('TC-ORD-03', 'failed'), result('TC-AUTH-02', 'passed')], { now: NOW });
  recordResults(ledger, [result('TC-AUTH-02', 'failed')], { now: NOW });
  triageDefect(ledger, 'DEF-001', { severity: 'High', owner: 'backend-engineer', rootCause: 'no tenant check', by: 'triage', now: NOW });
  handOff(ledger, 'DEF-001', { now: NOW });
  const files = renderArtifacts(ledger, { now: NOW });
  assert.match(files[NAMES.defects], /\| DEF-001 \| .* \| High \| Handed Off \| backend-engineer \| TC-ORD-03 failed \|/);
  assert.match(files[NAMES.defects], /\| DEF-001 \| HO-DEF-001-1 \|/);
  assert.match(files[NAMES.report], /\| flaky \| 1 \|/);
  assert.match(files[NAMES.report], /- TC-AUTH-02 flaky/);
  assert.match(files[NAMES.report], /- TC-AND-01: native targets are out of scope/);
  assert.match(files[NAMES.report], /\| High \| 1 \| 0 \|/);
  assert.match(files[NAMES.catalog], /## Out of scope/);
  assert.ok(files[DATA_FILES.defects].includes('"HO-DEF-001-1"'));
});

test('a written package reproduces from its ledger, and a change to either is detected', async () => {
  const { writeFileSync: write, readFileSync: read } = await import('node:fs');
  const { verifyArtifacts } = await import('../scripts/artifacts.mjs');
  const dir = mkdtempSync(join(tmpdir(), 'e2e-verify-'));
  try {
    const ledgerPath = join(dir, 'ledger.json');
    const ledger = fixtureLedger();
    const text = `${JSON.stringify(ledger, null, 2)}\n`;
    write(ledgerPath, text);
    writeArtifacts(ledger, join(dir, 'out'), { now: NOW, ledgerText: text });
    assert.deepEqual(verifyArtifacts(ledgerPath, join(dir, 'out')), { ok: true, problems: [] });
    const report = join(dir, 'out', NAMES.report);
    write(report, read(report, 'utf8').replace('Status:', 'Status (edited):'));
    assert.deepEqual(verifyArtifacts(ledgerPath, join(dir, 'out')).problems, [`${NAMES.report} was changed after it was rendered`]);
    write(ledgerPath, text.replace('"configName": "fixture"', '"configName": "other"'));
    assert.ok(verifyArtifacts(ledgerPath, join(dir, 'out')).problems.includes('the ledger changed since the report was rendered'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
