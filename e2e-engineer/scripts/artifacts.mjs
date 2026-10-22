#!/usr/bin/env node
// Renders the QA artifact package (plan section 19: files 00 to 11, and data/*.json) from the ledger.
// Rendering is deterministic: the same ledger and the same `now` give the same bytes. Nothing here
// reads a clock, a credential or a secret. Accounts appear as the environment-variable names that
// hold them.

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { activeStops, doublePasses, status, readLedger, testState } from './ledger.mjs';
import { canonical, planDigest, planState } from './plan.mjs';
import { inScope, validatePlan } from './traceability.mjs';
import { SEVERITIES } from './remediation.mjs';

const TEST_STATES = ['passed', 'failed', 'blocked', 'needs-confirmation', 'flaky', 'stale', 'not run'];

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

const LAYER_ORDER = ['static', 'api', 'db', 'web', 'mobile-web', 'e2e', 'android', 'ios', 'perf'];

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
      'Load testing, unless the run opts in: read-only requests only, within config.loadLimits, and only with E2E_ALLOW_LOAD=1. Thresholds are proposed until the team confirms them.',
      'Stress and soak testing.',
      'Native targets that are not declared in the config.',
      ...c.tests.filter((t) => !inScope(t)).map((t) => `${t.id}: ${t.outOfScope}`),
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
    '## Out of scope',
    '',
    'These test cases are in the plan, but this release does not run them. They do not count toward the gate.',
    '',
    bullets(c.tests.filter((t) => !inScope(t)).map((t) => `${t.id}: ${t.outOfScope}`)),
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
  const defects = sorted(c.ledger.defects || []);
  const state = (id) => `${id} ${testState(c.ledger, id).state}`;
  const remediation = defects.filter((d) => d.handoff || d.claim || d.retest || d.regression || d.mergedInto || d.flaky);
  return [
    '# 09 Defect and remediation register',
    '',
    'Each defect has one ID, its reproducing test cases, its severity, and its state. A developer saying a fix is done moves a defect to Fix Claimed only. A defect closes only after its retest and its regression run pass on the current build.',
    '',
    table(
      ['ID', 'Title', 'Severity', 'Status', 'Owner', 'Test cases (state now)'],
      defects.map((d) => [d.id, d.title, d.severity, d.status, d.owner ?? '', (d.testCases || []).map(state).join(', ')]),
    ),
    '## Remediation',
    '',
    table(
      ['ID', 'Handoff', 'Fix claim', 'Retest', 'Regression', 'Notes'],
      remediation.map((d) => [
        d.id,
        d.handoff ?? '',
        d.claim ? `${d.claim.by}, ${d.claim.at}` : '',
        d.retest ? `passed on ${short(d.retest.build)}` : '',
        d.regression ? `${d.regression.status} on ${short(d.regression.build)}${d.regression.failing ? `: ${d.regression.failing.join(', ')}` : ''}${d.regression.missing ? `: ${d.regression.missing.join(', ')}` : ''}` : '',
        [d.mergedInto ? `duplicate of ${d.mergedInto}` : '', d.flaky ? `flaky: ${d.flaky.join(', ')}` : '', d.regressionOf ? `regression of ${d.regressionOf}` : ''].filter(Boolean).join('; '),
      ]),
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
      'A fix arrives as a new build. A pass on the build where the test failed is flaky, not a fix.',
      'The retest runs the defect\'s own test cases on the new build (retest.mjs --defect).',
      'The regression set is every in-scope test case on the defect\'s journeys and on the P0 journeys (retest.mjs --defect --regression).',
      'A defect closes only after its retest and its regression run pass on the current build. A failure that another defect, found on an earlier build, already covers does not hold it open; a failure first seen on the new build does.',
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
      ['Test cases: planned / implemented / executed', `${cov.testCases.planned} / ${cov.testCases.implemented} / ${c.tests.filter((tc) => testState(ledger, tc.id).state !== 'not run').length}`],
    ]),
    '## Execution results',
    '',
    'The state of each in-scope test case on the current build. A stale run, from an earlier build or an earlier version of the test case, does not count.',
    '',
    table(['State', 'Test cases'], TEST_STATES.map((s) => [s, c.tests.filter((t) => inScope(t) && testState(ledger, t.id).state === s).length])),
    `Out of scope: ${c.tests.filter((t) => !inScope(t)).length}. Runs recorded: ${ledger.runs.length}.`,
    '',
    '## Defects',
    '',
    table(['Severity', 'Open', 'Closed'], [...SEVERITIES, 'unassigned'].map((sev) => {
      const of = (ledger.defects || []).filter((d) => d.severity === sev && d.disposition !== 'duplicate');
      return [sev, of.filter((d) => d.status !== 'Closed').length, of.filter((d) => d.status === 'Closed').length];
    })),
    '## Accepted risks',
    '',
    'Each item is an open defect that a named person decided to release with. It stays open, and its failures stay in this report.',
    '',
    bullets(
      (ledger.defects || [])
        .filter((d) => d.status !== 'Closed' && d.acceptedRisk)
        .map((d) => `${d.id} (${d.severity}): ${d.title}. Accepted by ${d.acceptedRisk.by} on ${d.acceptedRisk.at}: ${d.acceptedRisk.reason}`),
    ),
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
    '### Flaky and stale test cases',
    '',
    bullets(c.tests.filter((t) => inScope(t) && ['flaky', 'stale'].includes(testState(ledger, t.id).state)).map((t) => `${t.id} ${testState(ledger, t.id).state}`)),
    '### Out of scope for this release',
    '',
    bullets(c.tests.filter((t) => !inScope(t)).map((t) => `${t.id}: ${t.outOfScope}`)),
    '### Runs stopped by a stop condition',
    '',
    bullets(activeStops(ledger).map((s) => `${s.runner}: ${s.reason} (${s.tests.length} test case(s))`)),
    '### Passed against doubles, not live',
    '',
    'A pass against a double shows the app handles the integration as the double answers. It is not a live pass.',
    '',
    bullets(doublePasses(ledger)),
    '### Evidence removed by the retention cap',
    '',
    bullets((ledger.evidencePruned || []).map((p) => `${p.folder}: ${p.reason}`)),
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
    [DATA_FILES.defects]: { defects: sorted(c.ledger.defects || []), handoffs: c.ledger.handoffs || [] },
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

export const MANIFEST = 'data/report-manifest.json';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

// Writes every artifact, and a manifest with the render time, the SHA-256 of the ledger file it was
// rendered from, and the SHA-256 of each file. With the manifest, the package can be checked later
// against the ledger: verifyArtifacts renders it again and compares.
export function writeArtifacts(ledger, outDir, { now, ledgerText = null }) {
  const files = renderArtifacts(ledger, { now });
  for (const [path, text] of Object.entries(files)) {
    const target = join(outDir, path);
    mkdirSync(join(target, '..'), { recursive: true });
    writeFileSync(target, text);
  }
  const manifest = {
    generatedAt: now,
    ledgerSha256: ledgerText === null ? null : sha256(ledgerText),
    files: Object.fromEntries(Object.entries(files).map(([path, text]) => [path, sha256(text)]).sort(([a], [b]) => (a < b ? -1 : 1))),
  };
  writeFileSync(join(outDir, MANIFEST), `${JSON.stringify(manifest, null, 2)}\n`);
  return [...Object.keys(files), MANIFEST].sort();
}

// Checks that a written package reproduces from the ledger: the ledger file is the one it was rendered
// from, a fresh render at the recorded time gives the same bytes, and no file was changed on disk.
export function verifyArtifacts(ledgerPath, outDir) {
  const problems = [];
  const manifestPath = join(outDir, MANIFEST);
  if (!existsSync(manifestPath)) return { ok: false, problems: [`${MANIFEST} is missing`] };
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const ledgerText = readFileSync(ledgerPath, 'utf8');
  if (manifest.ledgerSha256 !== sha256(ledgerText)) problems.push('the ledger changed since the report was rendered');
  const files = renderArtifacts(readLedger(ledgerPath), { now: manifest.generatedAt });
  for (const [path, text] of Object.entries(files)) {
    if (manifest.files[path] !== sha256(text)) problems.push(`${path} does not reproduce from the ledger`);
    const onDisk = join(outDir, path);
    if (!existsSync(onDisk)) problems.push(`${path} is missing`);
    else if (sha256(readFileSync(onDisk, 'utf8')) !== manifest.files[path]) problems.push(`${path} was changed after it was rendered`);
  }
  for (const path of Object.keys(manifest.files)) if (!(path in files)) problems.push(`${path} is not part of the package`);
  return { ok: problems.length === 0, problems };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const verify = args[0] === 'verify';
  const [ledgerPath, outDir] = verify ? args.slice(1) : args;
  if (!ledgerPath || !outDir) {
    console.error('usage: artifacts.mjs [verify] <ledger.json> <out-dir>');
    process.exit(1);
  }
  if (verify) {
    const result = verifyArtifacts(resolve(ledgerPath), resolve(outDir));
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = result.ok ? 0 : 1;
  } else {
    const ledgerText = readFileSync(resolve(ledgerPath), 'utf8');
    const ledger = readLedger(resolve(ledgerPath));
    const written = writeArtifacts(ledger, resolve(outDir), { now: new Date().toISOString(), ledgerText });
    console.log(written.join('\n'));
  }
}
