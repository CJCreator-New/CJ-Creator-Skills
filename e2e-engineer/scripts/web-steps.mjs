// The step vocabulary for web and mobile-web test cases. A test case lists its steps in order. Each step
// names one user action or one check, and it finds its control the way a user does: by its accessible
// role and name, or by its label. The plan check validates the steps with this module, without a
// browser, so a step that cannot run is refused when the plan is frozen.

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
];

export const ROLES = ['button', 'link', 'textbox', 'table', 'heading', 'status', 'alert'];
export const A11Y_RULES = ['input-label', 'button-name'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];

function need(step, fields, at, problems) {
  for (const field of fields) {
    if (step[field] === undefined || step[field] === null || step[field] === '') {
      problems.push(`${at}: ${step.act} needs ${field}`);
    }
  }
}

// Returns the problems with one step. The check is on shape only; whether a control exists is a run-time
// question, answered by the browser.
export function validateStep(step, at) {
  const problems = [];
  if (!step || !ACTS.includes(step.act)) return [`${at}: act must be one of ${ACTS.join(', ')}`];
  switch (step.act) {
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
  testCase.steps.forEach((step, i) => problems.push(...validateStep(step, `${testCase.id} step ${i + 1}`)));
  return problems;
}
