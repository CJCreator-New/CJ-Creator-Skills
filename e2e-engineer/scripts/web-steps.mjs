// The step vocabulary for web, mobile-web and e2e test cases. A test case lists its steps in order. Each
// step names one user action or one check, and it finds its control the way a user does: by its
// accessible role and name, or by its label. The plan check validates the steps with this module,
// without a browser, so a step that cannot run is refused when the plan is frozen.
//
// An e2e (cross-layer) test case may also list backend steps, { "act": "check", "check": { ... } },
// where the check is an http or db check from checks.mjs. They run in order with the browser steps, so
// one test case can act through the UI and then verify the API and the stored data.

import { validateChecks } from './checks.mjs';

export const ACTS = [
  'signIn',
  'goto',
  'fill',
  'click',
  'expectText',
  'expectVisible',
  'expectUrl',
  'expectTestId',
  'expectDownload',
  'interceptNext',
  'expectNotClipped',
  'expectMinTarget',
  'scanA11y',
  'expectResponse',
  'check',
  'expectKeyboardReach',
  'expectMatchesDesign',
];

export const ROLES = ['button', 'link', 'textbox', 'table', 'heading', 'status', 'alert'];
// The built-in rules, and `axe` for the full axe-core scan when the repository provides axe-core.
export const A11Y_RULES = ['input-label', 'button-name', 'axe'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function need(step, fields, at, problems) {
  for (const field of fields) {
    if (step[field] === undefined || step[field] === null || step[field] === '') {
      problems.push(`${at}: ${step.act} needs ${field}`);
    }
  }
}

// Returns the problems with one step. The check is on shape only; whether a control exists is a run-time
// question, answered by the browser. Backend checks are allowed in e2e test cases only.
export function validateStep(step, at, layer = 'web') {
  const problems = [];
  if (!step || !ACTS.includes(step.act)) return [`${at}: act must be one of ${ACTS.join(', ')}`];
  switch (step.act) {
    case 'check':
      if (layer !== 'e2e') {
        problems.push(`${at}: a backend check step is allowed only in an e2e test case`);
        break;
      }
      if (!step.check || !['http', 'db'].includes(step.check.kind)) {
        problems.push(`${at}: check needs an http or db check`);
        break;
      }
      for (const problem of validateChecks({ id: at, checks: [step.check] })) problems.push(problem.replace(`${at} check 1`, at));
      break;
    case 'expectKeyboardReach':
      need(step, ['role', 'name'], at, problems);
      if (step.role && !ROLES.includes(step.role)) problems.push(`${at}: role must be one of ${ROLES.join(', ')}`);
      if (step.maxTabs !== undefined && (!Number.isInteger(step.maxTabs) || step.maxTabs < 1)) problems.push(`${at}: maxTabs must be a positive integer`);
      break;
    case 'expectMatchesDesign':
      need(step, ['image'], at, problems);
      if (step.maxDiffRatio !== undefined && !(typeof step.maxDiffRatio === 'number' && step.maxDiffRatio >= 0 && step.maxDiffRatio <= 1)) {
        problems.push(`${at}: maxDiffRatio must be between 0 and 1`);
      }
      break;
    case 'expectResponse':
      need(step, ['role', 'name', 'method', 'path', 'status'], at, problems);
      if (step.role && !ROLES.includes(step.role)) problems.push(`${at}: role must be one of ${ROLES.join(', ')}`);
      if (step.method && !METHODS.includes(step.method)) problems.push(`${at}: method must be one of ${METHODS.join(', ')}`);
      if (step.path && !String(step.path).startsWith('/')) problems.push(`${at}: expectResponse path must start with /`);
      if (step.status !== undefined && !Number.isInteger(step.status)) problems.push(`${at}: status must be an integer`);
      break;
    case 'signIn':
      need(step, ['as'], at, problems);
      break;
    case 'goto':
      need(step, ['path'], at, problems);
      if (typeof step.path === 'string' && !/^[#/]/.test(step.path)) problems.push(`${at}: goto path must start with # or /`);
      break;
    case 'fill':
      need(step, ['label', 'value'], at, problems);
      break;
    case 'click':
    case 'expectVisible':
    case 'expectMinTarget':
      need(step, ['role', 'name'], at, problems);
      if (step.role && !ROLES.includes(step.role)) problems.push(`${at}: role must be one of ${ROLES.join(', ')}`);
      if (step.act === 'expectMinTarget') need(step, ['min'], at, problems);
      break;
    case 'expectText':
      need(step, ['text'], at, problems);
      break;
    case 'expectUrl':
      need(step, ['contains'], at, problems);
      break;
    case 'expectTestId':
      need(step, ['testId', 'text'], at, problems);
      break;
    case 'expectDownload':
      need(step, ['role', 'name', 'filename'], at, problems);
      if (step.role && !ROLES.includes(step.role)) problems.push(`${at}: role must be one of ${ROLES.join(', ')}`);
      break;
    case 'interceptNext':
      need(step, ['method', 'path', 'status'], at, problems);
      if (step.method && !METHODS.includes(step.method)) problems.push(`${at}: method must be one of ${METHODS.join(', ')}`);
      if (step.path && !String(step.path).startsWith('/')) problems.push(`${at}: interceptNext path must start with /`);
      break;
    case 'expectNotClipped':
      need(step, ['role'], at, problems);
      if (step.role && !ROLES.includes(step.role)) problems.push(`${at}: role must be one of ${ROLES.join(', ')}`);
      break;
    case 'scanA11y':
      if (!Array.isArray(step.rules) || step.rules.length === 0) problems.push(`${at}: scanA11y needs a list of rules`);
      for (const rule of step.rules || []) {
        if (!A11Y_RULES.includes(rule)) problems.push(`${at}: unknown rule ${rule}; use ${A11Y_RULES.join(', ')}`);
      }
      break;
    default:
      break;
  }
  return problems;
}

// Returns the problems with a test case's steps. A web test case needs at least one step.
export function validateSteps(testCase) {
  if (!Array.isArray(testCase.steps) || testCase.steps.length === 0) return [`test case ${testCase.id} has no steps`];
  const problems = [];
  testCase.steps.forEach((step, i) => problems.push(...validateStep(step, `${testCase.id} step ${i + 1}`, testCase.layer)));
  return problems;
}
