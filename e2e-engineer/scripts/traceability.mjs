// Traceability and coverage for the test plan. The plan is the set of items recorded in the ledger:
// requirements, roles, permissions, operations, screens, journeys, test cases and fixtures, with an
// optional design map. Errors stop the plan from being frozen. Gaps and warnings are reported, never
// hidden. Coverage is reported as separate measures, with no single percentage.

import { validateChecks } from './checks.mjs';
import { validateSteps } from './web-steps.mjs';
import { validateNativeChecks } from './native.mjs';
import { validateLoadChecks } from './load.mjs';

export const ORACLES = ['spec', 'design', 'contract', 'doc', 'observed'];
export const PRIORITIES = ['P0', 'P1', 'P2'];
export const LAYERS = ['web', 'mobile-web', 'android', 'ios', 'api', 'db', 'static', 'perf'];
export const AUTOMATION = ['planned', 'implemented', 'executed'];
export const BRANCH_KINDS = ['success', 'failure', 'permission', 'cancel', 'duplicate', 'recovery'];
export const OUTCOMES = ['allowed', 'denied', 'conditional'];

function index(items, errors, label) {
  const byId = new Map();
  for (const item of items) {
    if (!item || typeof item.id !== 'string') {
      errors.push(`a ${label} has no id`);
      continue;
    }
    if (byId.has(item.id)) errors.push(`${label} ${item.id} is defined twice`);
    byId.set(item.id, item);
  }
  return byId;
}

function refs(list, known, errors, owner, label) {
  for (const ref of list || []) {
    if (!known.has(ref)) errors.push(`${owner} refers to ${label} ${ref}, which is not in the plan`);
  }
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim() !== '';
}

// A test case is in scope unless the plan takes it out, with a reason. An out-of-scope test case is not
// run and does not count toward the gate, and the report lists it with its reason.
export function inScope(testCase) {
  return testCase.outOfScope === undefined;
}

// Checks the plan and returns { errors, warnings, gaps, coverage }. The plan is complete enough to
// freeze only when errors is empty.
export function validatePlan(ledger) {
  const errors = [];
  const warnings = [];
  const gaps = [];

  const requirements = index(ledger.requirements || [], errors, 'requirement');
  const roles = index(ledger.roles || [], errors, 'role');
  const permissions = index(ledger.permissions || [], errors, 'permission');
  const operations = index(ledger.operations || [], errors, 'operation');
  const screens = index(ledger.screens || [], errors, 'screen');
  const journeys = index(ledger.journeys || [], errors, 'journey');
  const tests = index(ledger.testCases || [], errors, 'test case');
  const fixtures = index(ledger.fixtures || [], errors, 'fixture');

  if (journeys.size === 0) errors.push('the plan has no journeys');

  for (const req of requirements.values()) {
    if (!ORACLES.includes(req.oracle)) errors.push(`requirement ${req.id} needs an oracle: ${ORACLES.join(', ')}`);
    if (!nonEmptyText(req.text)) errors.push(`requirement ${req.id} needs text`);
    if (req.derived === true && req.confirmed !== true) {
      warnings.push(`requirement ${req.id} is derived and not confirmed, so it cannot drive a FAIL`);
    }
    if (req.oracle === 'observed') {
      warnings.push(`requirement ${req.id} has the observed oracle, so it records behaviour that needs confirmation`);
    }
  }

  for (const perm of permissions.values()) {
    const rules = perm.rules || [];
    for (const rule of rules) {
      if (!roles.has(rule.role)) errors.push(`permission ${perm.id} has a rule for unknown role ${rule.role}`);
      if (!OUTCOMES.includes(rule.outcome)) errors.push(`permission ${perm.id} has an unknown outcome for ${rule.role}`);
    }
    const outcomes = new Set(rules.map((rule) => rule.outcome));
    if (!outcomes.has('allowed') && !outcomes.has('conditional')) errors.push(`permission ${perm.id} has no rule that allows anyone`);
    if (!outcomes.has('denied') && !nonEmptyText(perm.noDeniedReason)) {
      gaps.push(`permission ${perm.id} has no denied role; add one, or state why in noDeniedReason`);
    }
    refs(perm.requirements, requirements, errors, `permission ${perm.id}`, 'requirement');
  }

  const controlKeys = new Set();
  for (const screen of screens.values()) {
    if (!nonEmptyText(screen.route)) errors.push(`screen ${screen.id} needs a route`);
    for (const control of screen.controls || []) {
      if (!control || typeof control.id !== 'string') {
        errors.push(`a control on ${screen.id} has no id`);
        continue;
      }
      controlKeys.add(`${screen.id}.${control.id}`);
      if (!nonEmptyText(control.label)) gaps.push(`control ${screen.id}.${control.id} has no label in the spec`);
    }
  }

  for (const journey of journeys.values()) {
    if (!PRIORITIES.includes(journey.priority)) errors.push(`journey ${journey.id} needs a priority: ${PRIORITIES.join(', ')}`);
    refs(journey.requirements, requirements, errors, `journey ${journey.id}`, 'requirement');
    refs(journey.roles, roles, errors, `journey ${journey.id}`, 'role');
    refs(journey.screens, screens, errors, `journey ${journey.id}`, 'screen');
    refs(journey.permissions, permissions, errors, `journey ${journey.id}`, 'permission');
    refs(journey.operations, operations, errors, `journey ${journey.id}`, 'operation');
    if (!journey.roles || journey.roles.length === 0) errors.push(`journey ${journey.id} names no role`);
    const kinds = new Set((journey.branches || []).map((branch) => branch.kind));
    for (const branch of journey.branches || []) {
      if (!BRANCH_KINDS.includes(branch.kind)) errors.push(`journey ${journey.id} has a branch of unknown kind ${branch.kind}`);
    }
    if (!kinds.has('success')) errors.push(`journey ${journey.id} has no success branch`);
    if (journey.priority === 'P0' && !kinds.has('failure')) errors.push(`P0 journey ${journey.id} has no failure branch`);
    if ((journey.permissions || []).length > 0 && !kinds.has('permission')) {
      errors.push(`journey ${journey.id} uses permissions but has no permission branch`);
    }
  }

  for (const test of tests.values()) {
    if (!test.journeys || test.journeys.length === 0) errors.push(`test case ${test.id} is linked to no journey`);
    refs(test.journeys, journeys, errors, `test case ${test.id}`, 'journey');
    refs(test.requirements, requirements, errors, `test case ${test.id}`, 'requirement');
    refs(test.roles, roles, errors, `test case ${test.id}`, 'role');
    refs(test.operations, operations, errors, `test case ${test.id}`, 'operation');
    refs(test.permissions, permissions, errors, `test case ${test.id}`, 'permission');
    refs(test.fixtures, fixtures, errors, `test case ${test.id}`, 'fixture');
    for (const key of test.controls || []) {
      if (!controlKeys.has(key)) errors.push(`test case ${test.id} refers to control ${key}, which is not on any screen`);
    }
    if (!LAYERS.includes(test.layer)) errors.push(`test case ${test.id} needs a layer: ${LAYERS.join(', ')}`);
    if (!AUTOMATION.includes(test.automation)) errors.push(`test case ${test.id} needs an automation status: ${AUTOMATION.join(', ')}`);
    if (typeof test.mutates !== 'boolean') errors.push(`test case ${test.id} must say whether it mutates data (mutates: true or false)`);
    if (test.outOfScope !== undefined) {
      if (nonEmptyText(test.outOfScope)) warnings.push(`test case ${test.id} is out of scope: ${test.outOfScope}`);
      else errors.push(`test case ${test.id} is out of scope, so it needs the reason as text in outOfScope`);
    }
    if (!Array.isArray(test.expected) || test.expected.length === 0) errors.push(`test case ${test.id} has no expected results`);
    if (test.automation === 'implemented' && ['api', 'db'].includes(test.layer)) {
      for (const problem of validateChecks(test)) errors.push(problem);
    }
    if (test.automation === 'implemented' && ['web', 'mobile-web'].includes(test.layer)) {
      for (const problem of validateSteps(test)) errors.push(problem);
    }
    if (test.automation === 'implemented' && ['static', 'android', 'ios'].includes(test.layer)) {
      for (const problem of validateNativeChecks(test)) errors.push(problem);
    }
    if (test.automation === 'implemented' && test.layer === 'perf') {
      for (const problem of validateLoadChecks(test)) errors.push(problem);
    }

    if (!ORACLES.includes(test.oracle)) {
      errors.push(`test case ${test.id} needs an oracle: ${ORACLES.join(', ')}`);
    } else if (test.oracle === 'observed') {
      warnings.push(`test case ${test.id} has the observed oracle, so it can record behaviour but cannot PASS or FAIL`);
    } else {
      if (!test.requirements || test.requirements.length === 0) {
        errors.push(`test case ${test.id} has the ${test.oracle} oracle but no requirement it checks`);
      }
      for (const reqId of test.requirements || []) {
        const req = requirements.get(reqId);
        if (req && req.oracle !== test.oracle) {
          errors.push(`test case ${test.id} has the ${test.oracle} oracle, but ${reqId} has the ${req.oracle} oracle`);
        }
      }
    }
  }

  const coveredRequirements = new Set();
  const coveredJourneys = new Set();
  const journeysInScope = new Set();
  const coveredControls = new Set();
  const coveredPermissions = new Set();
  const coveredOperations = new Set();
  for (const test of tests.values()) {
    for (const id of test.requirements || []) coveredRequirements.add(id);
    for (const id of test.journeys || []) coveredJourneys.add(id);
    if (inScope(test)) for (const id of test.journeys || []) journeysInScope.add(id);
    for (const key of test.controls || []) coveredControls.add(key);
    for (const id of test.permissions || []) coveredPermissions.add(id);
    for (const id of test.operations || []) coveredOperations.add(id);
  }

  for (const req of requirements.values()) {
    if (!coveredRequirements.has(req.id)) gaps.push(`requirement ${req.id} has no test case`);
  }
  for (const journey of journeys.values()) {
    if (coveredJourneys.has(journey.id) && journeysInScope.has(journey.id)) continue;
    const what = coveredJourneys.has(journey.id) ? 'no test case in scope' : 'no test case';
    if (journey.priority === 'P0') errors.push(`P0 journey ${journey.id} has ${what}`);
    else gaps.push(`journey ${journey.id} has ${what}`);
  }
  for (const screen of screens.values()) {
    const inJourney = [...journeys.values()].some((journey) => (journey.screens || []).includes(screen.id));
    if (!inJourney) gaps.push(`screen ${screen.id} is in no journey`);
    for (const control of screen.controls || []) {
      const key = `${screen.id}.${control.id}`;
      if (!coveredControls.has(key)) gaps.push(`control ${key} is not mapped to a test case`);
    }
  }
  for (const perm of permissions.values()) {
    if (!coveredPermissions.has(perm.id)) gaps.push(`permission ${perm.id} has no test case`);
  }
  for (const op of operations.values()) {
    if (!coveredOperations.has(op.id)) gaps.push(`operation ${op.id} has no test case`);
  }
  const usedRoles = new Set([...journeys.values()].flatMap((journey) => journey.roles || []));
  for (const role of roles.values()) {
    if (!usedRoles.has(role.id)) warnings.push(`role ${role.id} is used by no journey`);
  }

  if (ledger.designMap) {
    const entries = ledger.designMap.screens || {};
    for (const screen of screens.values()) {
      const entry = entries[screen.id];
      if (!entry) errors.push(`the design map has no entry for screen ${screen.id}`);
      else if (entry.status === 'mapped' && !nonEmptyText(entry.frame)) errors.push(`design map entry ${screen.id} is mapped but names no frame`);
      else if (!['mapped', 'no reference'].includes(entry.status)) errors.push(`design map entry ${screen.id} needs status mapped or no reference`);
    }
  } else {
    errors.push('the design map is missing; record it with the design source, even when the source is none');
  }

  const screensInJourneys = [...screens.keys()].filter((id) => [...journeys.values()].some((j) => (j.screens || []).includes(id)));
  const coverage = {
    requirements: { total: requirements.size, withTestCases: coveredRequirements.size },
    journeys: {
      total: journeys.size,
      p0Total: [...journeys.values()].filter((j) => j.priority === 'P0').length,
      p0WithTestCases: [...journeys.values()].filter((j) => j.priority === 'P0' && coveredJourneys.has(j.id)).length,
      withTestCases: coveredJourneys.size,
    },
    screens: { total: screens.size, inJourneys: screensInJourneys.length },
    controls: { total: controlKeys.size, mapped: coveredControls.size },
    permissions: { total: permissions.size, withTestCases: coveredPermissions.size },
    operations: { total: operations.size, withTestCases: coveredOperations.size },
    testCases: {
      total: tests.size,
      planned: [...tests.values()].filter((t) => t.automation === 'planned').length,
      implemented: [...tests.values()].filter((t) => t.automation === 'implemented').length,
      executed: [...tests.values()].filter((t) => t.automation === 'executed').length,
      outOfScope: [...tests.values()].filter((t) => !inScope(t)).length,
    },
  };

  return { errors, warnings, gaps, coverage };
}
