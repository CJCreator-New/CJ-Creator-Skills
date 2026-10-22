#!/usr/bin/env node
// Renders the QA artifact package (plan section 19: files 00 to 11, and data/*.json) from the ledger.
// Rendering is deterministic: the same ledger and the same `now` give the same bytes. Nothing here
// reads a clock, a credential or a secret. Accounts appear as the environment-variable names that
// hold them.

import { mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { status, readLedger } from './ledger.mjs';
import { canonical, planDigest, planState } from './plan.mjs';
import { validatePlan } from './traceability.mjs';

export const NAMES = {
  summary: '00_QA_EXECUTIVE_SUMMARY.md',
  inventory: '01_APPLICATION_AND_ARCHITECTURE_INVENTORY.md',
  screens: '02_SCREEN_AND_UI_INTERACTION_INVENTORY.md',
  flows: '03_USER_FLOW_AND_GOLDEN_PATHS.md',
  rbac: '04_RBAC_AND_PERMISSION_TEST_MATRIX.md',
  strategy: '05_MASTER_QA_STRATEGY.md',
  catalog: '06_TEST_CASE_CATALOG.md',
  execution: '07_TEST_EXECUTION_PLAN.md',
  data: '08_MOCK_DATA_AND_ENVIRONMENT_GUIDE.md',
  defects: '09_DEFECT_AND_REMEDIATION_REGISTER.md',
  acceptance: '10_ACCEPTANCE_CRITERIA_AND_REGRESSION_PLAN.md',
  report: '11_FINAL_QA_REPORT.md',
};

export const DATA_FILES = {
  requirements: 'data/requirements-traceability.json',
  flows: 'data/user-flow-coverage.json',
  rbac: 'data/role-permission-matrix.json',
  catalog: 'data/test-catalog.json',
  defects: 'data/defect-register.json',
};

const LAYER_ORDER = ['static', 'api', 'db', 'web', 'mobile-web', 'android', 'ios'];

const cell = (value) => (value === undefined || value === null ? '' : String(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' '));
const short = (hash) => (hash ? hash.slice(0, 12) : 'none');
const byId = (a, b) => (a.id === b.id ? 0 : a.id < b.id ? -1 : 1);
const sorted = (items) => [...(items || [])].sort(byId);

function table(headers, rows) {
  if (rows.length === 0) return '_None recorded._\n\n';
  const lines = [
    `| ${headers.join(' | ')} |`,
    `| ${headers.map(() => '---').join(' | ')} |`,
    ...rows.map((row) => `| ${row.map(cell).join(' | ')} |`),
  ];
  return `${lines.join('\n')}\n\n`;
}

function bullets(items, empty = '_None._') {
  if (items.length === 0) return `${empty}\n\n`;
  return `${items.map((item) => `- ${item}`).join('\n')}\n\n`;
}

// Everything the renderers need, computed once from the ledger.
function context(ledger, now) {
  const check = validatePlan(ledger);
  const screens = sorted(ledger.screens);
  const journeys = sorted(ledger.journeys);
  const tests = sorted(ledger.testCases);
  const roles = sorted(ledger.roles);
  const permissions = sorted(ledger.permissions);
  const operations = sorted(ledger.operations);
  const requirements = sorted(ledger.requirements);
  const fixtures = sorted(ledger.fixtures);
  const rolesFor = (screenId) => [...new Set(journeys.filter((j) => (j.screens || []).includes(screenId)).flatMap((j) => j.roles || []))].sort();
  const journeysFor = (id, field) => journeys.filter((j) => (j[field] || []).includes(id)).map((j) => j.id);
  const testsFor = (field, id) => tests.filter((t) => (t[field] || []).includes(id)).map((t) => t.id);
  const controlTests = (key) => tests.filter((t) => (t.controls || []).includes(key)).map((t) => t.id);
  return {
    ledger,
    now,
    check,
    st: status(ledger),
    state: planState(ledger),
    digest: planDigest(ledger),
    screens,
    journeys,
    tests,
    roles,
    permissions,
    operations,
    requirements,
    fixtures,
    rolesFor,
    journeysFor,
    testsFor,
    controlTests,
    runsByResult: (result) => ledger.runs.filter((run) => run.result === result).length,
  };
}

function renderSummary(c) {
  const { ledger, st, check } = c;
  const approval = ledger.approval
    ? `${ledger.approval.approver} on ${ledger.approval.approvedAt}, for digest ${short(ledger.approval.planHash)}`
    : 'none';
  const readiness = Object.entries(ledger.intake?.readiness || {}).sort(([a], [b]) => (a < b ? -1 : 1));
  const p0 = c.journeys.filter((j) => j.priority === 'P0').length;
  return [
    '# 00 QA executive summary',
    '',
    `Status: **${st.status}**`,
    '',
    bullets(st.reasons),
    `- Generated at: ${c.now}`,
    `- Build: commit ${ledger.intake?.build?.commit ?? 'unknown'}, tree ${short(ledger.intake?.build?.treeHash)}, ${ledger.intake?.build?.current ? 'current' : 'not current'}`,
    `- Plan: ${c.state}, digest ${short(ledger.planFrozen?.hash)}`,
    `- Approval: ${approval}`,
    `- Design source: ${ledger.designMap ? ledger.designMap.source : 'not recorded'}`,
    '',
    '## Scope',
    '',
    table(['Target', 'Readiness', 'Reason or note'], readiness.map(([target, r]) => [target, r.status, r.reason || r.note || ''])),
    '## Counts',
    '',
    table(['Item', 'Count'], [
      ['Requirements', c.requirements.length],
      ['Journeys (P0 / all)', `${p0} / ${c.journeys.length}`],
      ['Screens', c.screens.length],
      ['Permissions', c.permissions.length],
      ['Operations', c.operations.length],
      ['Test cases', c.tests.length],
      ['Runs passed / failed', `${c.runsByResult('passed')} / ${c.runsByResult('failed')}`],
      ['Defects', (ledger.defects || []).length],
    ]),
    '## Plan checks',
    '',
    `Errors: ${check.errors.length}. Gaps: ${check.gaps.length}. Warnings: ${check.warnings.length}.`,
    '',
    'A plan with errors cannot be frozen. Gaps and warnings are listed in 11 and 10.',
    '',
    '## Read next',
    '',
    ...Object.entries(NAMES).filter(([key]) => key !== 'summary').map(([, name]) => `- ${name}`),
    '',
  ].join('\n');
}

function renderInventory(c) {
  const { ledger } = c;
  const readiness = Object.entries(ledger.intake?.readiness || {});
  return [
    '# 01 Application and architecture inventory',
    '',
    'The stack and module map come from repo-intel. In this version they are recorded in the run notes, not in the ledger.',
    '',
    '## Targets in scope',
    '',
    table(['Target', 'Readiness'], readiness.map(([t, r]) => [t, r.status])),
    '## Operations',
    '',
    table(['ID', 'Method', 'Path', 'Test cases'], c.operations.map((op) => [op.id, op.method, op.path, c.testsFor('operations', op.id).join(', ')])),
    '## Roles',
    '',
    table(['ID', 'Label', 'Tenant', 'Description'], c.roles.map((r) => [r.id, r.label, r.tenant, r.description])),
    '## Routes',
    '',
    table(['Screen', 'Route', 'Title'], c.screens.map((s) => [s.id, s.route, s.title])),
  ].join('\n');
}

function renderScreens(c) {
  const parts = ['# 02 Screen and UI interaction inventory', ''];
  if (c.screens.length === 0) parts.push('_No screens recorded._', '');
  for (const screen of c.screens) {
    const entry = c.ledger.designMap?.screens?.[screen.id];
    const design = entry ? (entry.status === 'mapped' ? `mapped to ${entry.frame}` : entry.status) : 'not recorded';
    parts.push(
      `## ${screen.id}: ${screen.title || screen.id}`,
      '',
      `Route: \`${screen.route}\`. Roles: ${c.rolesFor(screen.id).join(', ') || 'none'}. Journeys: ${c.journeysFor(screen.id, 'screens').join(', ') || 'none'}. Design: ${design}.`,
      '',
      table(
        ['Control', 'Label', 'Kind', 'Test cases'],
        (screen.controls || []).map((control) => [control.id, control.label, control.kind, c.controlTests(`${screen.id}.${control.id}`).join(', ') || 'none']),
      ),
      'States:',
      '',
      bullets(screen.states || [], '_None recorded._'),
    );
  }
  return parts.join('\n');
}

function renderFlows(c) {
  const parts = ['# 03 User flows and golden paths', ''];
  if (c.journeys.length === 0) parts.push('_No journeys recorded._', '');
  for (const journey of c.journeys) {
    parts.push(
      `## ${journey.id}: ${journey.title || journey.id} (${journey.priority})`,
      '',
      `Roles: ${(journey.roles || []).join(', ') || 'none'}. Screens: ${(journey.screens || []).join(', ') || 'none'}. Requirements: ${(journey.requirements || []).join(', ') || 'none'}. Operations: ${(journey.operations || []).join(', ') || 'none'}. Permissions: ${(journey.permissions || []).join(', ') || 'none'}.`,
      '',
      table(['Branch', 'Summary'], (journey.branches || []).map((b) => [b.kind, b.summary])),
      `Test cases: ${c.testsFor('journeys', journey.id).join(', ') || 'none'}.`,
      '',
    );
  }
  return parts.join('\n');
}

function renderRbac(c) {
  const header = ['Permission', ...c.roles.map((r) => r.id)];
  const rows = c.permissions.map((perm) => [
    perm.id,
    ...c.roles.map((role) => {
      const rule = (perm.rules || []).find((r) => r.role === role.id);
      if (!rule) return 'not stated';
      return rule.condition ? `${rule.outcome} (${rule.condition})` : rule.outcome;
    }),
  ]);
  return [
    '# 04 RBAC and permission test matrix',
    '',
    'Each cell is the outcome the spec states for that role. "conditional" names the condition. "not stated" means the plan does not decide it yet.',
    '',
    table(header, rows),
    '## Permission details',
    '',
    table(
      ['Permission', 'Requirements', 'Test cases', 'Denied role or reason'],
      c.permissions.map((perm) => [
        perm.id,
        (perm.requirements || []).join(', '),
        c.testsFor('permissions', perm.id).join(', ') || 'none',
        (perm.rules || []).some((r) => r.outcome === 'denied') ? 'a role is denied' : perm.noDeniedReason || 'GAP: no denied role',
      ]),
    ),
  ].join('\n');
}

function renderStrategy(c) {
  const layers = {};
  for (const t of c.tests) layers[t.layer] = (layers[t.layer] || 0) + 1;
  return [
    '# 05 Master QA strategy',
    '',
    '## Scope',
    '',
    'End-to-end verification of the journeys in this plan, through each target in scope, the API and the data layer.',
    '',
    '## Exclusions',
    '',
    bullets([
      'Load and stress testing: opt-in in a later version, with declared limits.',
      'Native targets that are not declared in the config.',
      'Desktop and command-line interfaces.',
      'Live third-party integrations: doubles only, unless sandbox credentials are supplied.',
    ]),
    '## Oracle policy',
    '',
    bullets([
      'A PASS or FAIL against intended behaviour needs a spec, design, contract or doc oracle.',
      'An observed result is recorded as behaviour that needs confirmation. It is never a defect on its own.',
      'A derived requirement that is not confirmed cannot drive a FAIL.',
    ]),
    '## Priorities',
    '',
    table(['Priority', 'Meaning', 'Journeys'], [
      ['P0', 'Essential, release-blocking', c.journeys.filter((j) => j.priority === 'P0').map((j) => j.id).join(', ')],
      ['P1', 'Important, with a workaround', c.journeys.filter((j) => j.priority === 'P1').map((j) => j.id).join(', ')],
      ['P2', 'Lower priority', c.journeys.filter((j) => j.priority === 'P2').map((j) => j.id).join(', ')],
    ]),
    '## Test layers',
    '',
    table(['Layer', 'Test cases'], LAYER_ORDER.filter((l) => layers[l]).map((l) => [l, layers[l]])),
    '## Entry and exit',
    '',
    bullets([
      'Entry: the target is identified, intake is allowed, the plan is frozen and approved, and every target in scope is ready.',
      'Exit: every P0 journey is verified on every target in scope, no Critical or High defect is open, and the gate status is computed from the ledger.',
    ]),
  ].join('\n');
}

function renderCatalog(c) {
  return [
    '# 06 Test case catalog',
    '',
    table(
      ['ID', 'Layer', 'Mutates', 'Oracle', 'Requirements', 'Journeys', 'Automation', 'First expected result'],
      c.tests.map((t) => [t.id, t.layer, t.mutates, t.oracle, (t.requirements || []).join(', '), (t.journeys || []).join(', '), t.automation, (t.expected || [])[0]]),
    ),
  ].join('\n');
}

function renderExecution(c) {
  const ordered = [...c.tests].sort((a, b) => LAYER_ORDER.indexOf(a.layer) - LAYER_ORDER.indexOf(b.layer) || byId(a, b));
  const readOnly = ordered.filter((t) => !t.mutates);
  const serial = ordered.filter((t) => t.mutates);
  return [
    '# 07 Test execution plan',
    '',
    `Order of layers: ${LAYER_ORDER.join(', ')}. Within each layer, read-only test cases run in parallel first, then mutating test cases run one at a time.`,
    '',
    '## Read-only lane (parallel)',
    '',
    bullets(readOnly.map((t) => `${t.id} (${t.layer})`), '_None._'),
    '## Mutating lane (serial)',
    '',
    bullets(serial.map((t) => `${t.id} (${t.layer})`), '_None._'),
    '## Durations',
    '',
    'Not measured in this version.',
    '',
    '## Stop conditions',
    '',
    bullets([
      'A safety check fails, or a target is outside the allowlist.',
      'The environment fails its health check twice.',
      'A lane has more than 30 percent infrastructure failures (a default, configurable).',
      'A security probe finds a Critical issue. Mutating tests against that host stop.',
      'The run budget is exceeded.',
    ]),
    '## Retest',
    '',
    'A fix is retested by test case ID. Regression covers the test cases that share a journey with the fix.',
    '',
  ].join('\n');
}

function renderData(c) {
  const accounts = c.roles.map((r) => [r.id, r.tenant, r.account ? `${r.account.usernameEnv} / ${r.account.passwordEnv}` : 'not declared']);
  return [
    '# 08 Mock data and environment guide',
    '',
    `Config: ${c.ledger.intake?.configName ?? 'not recorded'}. Reset allowed: ${c.ledger.intake?.safety?.resetAllowed ? 'yes' : 'no'}.`,
    '',
    '## Fixtures',
    '',
    table(['ID', 'Description', 'Used by'], c.fixtures.map((f) => [f.id, f.description, c.tests.filter((t) => (t.fixtures || []).includes(f.id)).map((t) => t.id).join(', ')])),
    '## Accounts by role',
    '',
    'Credentials are never written here. The table names the environment variables that hold them.',
    '',
    table(['Role', 'Tenant', 'Environment variables (username / password)'], accounts),
  ].join('\n');
}

function renderDefects(c) {
  const defects = c.ledger.defects || [];
  return [
    '# 09 Defect and remediation register',
    '',
    'Each defect has one ID, its reproducing test cases, its severity, and its state. A developer saying a fix is done moves a defect to Fix Claimed only.',
    '',
    table(
      ['ID', 'Title', 'Severity', 'Status', 'Test cases'],
      sorted(defects).map((d) => [d.id, d.title, d.severity, d.status, (d.testCases || []).join(', ')]),
    ),
  ].join('\n');
}

function renderAcceptance(c) {
  return [
    '# 10 Acceptance criteria and regression plan',
    '',
    table(
      ['ID', 'Requirement', 'Oracle', 'Source', 'Confirmed', 'Test cases'],
      c.requirements.map((r) => [r.id, r.text, r.oracle, r.source, r.derived ? (r.confirmed ? 'yes' : 'no (derived)') : 'yes', c.testsFor('requirements', r.id).join(', ') || 'none']),
    ),
    '## Regression',
    '',
    bullets([
      'Each fix re-runs the test cases that reference its requirement, and the test cases of the journeys it touches.',
      'A defect closes only after its retest and its regression run pass on the current build.',
    ]),
  ].join('\n');
}

function renderReport(c) {
  const { ledger, check, st } = c;
  const unconfirmed = c.requirements.filter((r) => r.derived && !r.confirmed).map((r) => r.id);
  const observed = c.requirements.filter((r) => r.oracle === 'observed').map((r) => r.id);
  const blocked = Object.entries(ledger.intake?.readiness || {}).filter(([, r]) => r.status === 'blocked').map(([t, r]) => `${t}: ${r.reason}`);
  const cov = check.coverage;
  return [
    '# 11 Final QA report',
    '',
    `Status: **${st.status}**`,
    '',
    bullets(st.reasons),
    '## Coverage (separate measures; no combined percentage)',
    '',
    table(['Measure', 'Count'], [
      ['Requirements with test cases', `${cov.requirements.withTestCases} of ${cov.requirements.total}`],
      ['P0 journeys with test cases', `${cov.journeys.p0WithTestCases} of ${cov.journeys.p0Total}`],
      ['Screens in journeys', `${cov.screens.inJourneys} of ${cov.screens.total}`],
      ['Controls mapped to test cases', `${cov.controls.mapped} of ${cov.controls.total}`],
      ['Permissions with test cases', `${cov.permissions.withTestCases} of ${cov.permissions.total}`],
      ['Operations with test cases', `${cov.operations.withTestCases} of ${cov.operations.total}`],
      ['Test cases: planned / implemented / executed', `${cov.testCases.planned} / ${cov.testCases.implemented} / ${cov.testCases.executed}`],
    ]),
    '## Execution results',
    '',
    table(['Result', 'Runs'], ['passed', 'failed', 'blocked', 'skipped', 'not-run', 'stale', 'flaky'].map((r) => [r, c.runsByResult(r)])),
    '## Defects',
    '',
    `${(ledger.defects || []).length} recorded.`,
    '',
    '## Security and access control',
    '',
    `Permissions with test cases: ${cov.permissions.withTestCases} of ${cov.permissions.total}. Security probes: ${ledger.intake?.safety?.securityProbes?.allowed ? 'allowed' : `refused (${ledger.intake?.safety?.securityProbes?.reason})`}.`,
    '',
    '## Unverified areas',
    '',
    '### Blocked targets',
    '',
    bullets(blocked),
    '### Gaps',
    '',
    bullets(check.gaps),
    '### Observed requirements (need confirmation)',
    '',
    bullets(observed),
    '### Derived requirements not yet confirmed',
    '',
    bullets(unconfirmed),
    '## Release recommendation',
    '',
    `${st.status}. The gate status is the recommendation. This report does not change it.`,
    '',
    '## Supporting artifacts',
    '',
    ...Object.values(NAMES).filter((n) => n !== NAMES.report).map((n) => `- ${n}`),
    ...Object.values(DATA_FILES).map((n) => `- ${n}`),
    '',
  ].join('\n');
}

function dataFiles(c) {
  const requirementTrace = c.requirements.map((r) => ({
    id: r.id,
    text: r.text,
    oracle: r.oracle,
    derived: Boolean(r.derived),
    confirmed: r.derived ? Boolean(r.confirmed) : true,
    journeys: c.journeysFor(r.id, 'requirements'),
    testCases: c.testsFor('requirements', r.id),
  }));
  const flows = c.journeys.map((j) => ({
    id: j.id,
    priority: j.priority,
    roles: j.roles || [],
    screens: j.screens || [],
    branches: (j.branches || []).map((b) => b.kind),
    testCases: c.testsFor('journeys', j.id),
  }));
  const rbac = {
    roles: c.roles.map((r) => r.id),
    permissions: c.permissions.map((p) => ({ id: p.id, rules: p.rules || [], noDeniedReason: p.noDeniedReason ?? null, testCases: c.testsFor('permissions', p.id) })),
  };
  return {
    [DATA_FILES.requirements]: requirementTrace,
    [DATA_FILES.flows]: flows,
    [DATA_FILES.rbac]: rbac,
    [DATA_FILES.catalog]: c.tests,
    [DATA_FILES.defects]: { defects: sorted(c.ledger.defects || []) },
  };
}

// Returns { files: { path: text }, } for every artifact. Each JSON file is canonical, so its bytes do
// not depend on how the ledger was written.
export function renderArtifacts(ledger, { now }) {
  const c = context(ledger, now);
  const files = {
    [NAMES.summary]: renderSummary(c),
    [NAMES.inventory]: renderInventory(c),
    [NAMES.screens]: renderScreens(c),
    [NAMES.flows]: renderFlows(c),
    [NAMES.rbac]: renderRbac(c),
    [NAMES.strategy]: renderStrategy(c),
    [NAMES.catalog]: renderCatalog(c),
    [NAMES.execution]: renderExecution(c),
    [NAMES.data]: renderData(c),
    [NAMES.defects]: renderDefects(c),
    [NAMES.acceptance]: renderAcceptance(c),
    [NAMES.report]: renderReport(c),
  };
  for (const [path, value] of Object.entries(dataFiles(c))) {
    files[path] = `${JSON.stringify(canonical(value), null, 2)}\n`;
  }
  return files;
}

export function writeArtifacts(ledger, outDir, { now }) {
  const files = renderArtifacts(ledger, { now });
  for (const [path, text] of Object.entries(files)) {
    const target = join(outDir, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text);
  }
  return Object.keys(files).sort();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [ledgerPath, outDir] = process.argv.slice(2);
  if (!ledgerPath || !outDir) {
    console.error('usage: artifacts.mjs <ledger.json> <out-dir>');
    process.exit(1);
  }
  const ledger = readLedger(resolve(ledgerPath));
  const written = writeArtifacts(ledger, resolve(outDir), { now: new Date().toISOString() });
  console.log(written.join('\n'));
}
