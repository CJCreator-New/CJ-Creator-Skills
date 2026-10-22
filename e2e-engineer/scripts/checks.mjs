// Executable checks for api and db test cases. A test case lists its checks; the runner runs them in
// order against a target and reports passed, failed, or blocked. A check that cannot run because a
// credential, a tool or an authorization is missing is blocked with the reason, never skipped.
//
// Check kinds:
//   http        one request, with the status and JSON assertions the response must meet
//   concurrent  the same request, sent `count` times at once; the statuses must equal expectStatuses,
//               and an optional `then` http check runs after, for the invariant
//   db          one read-only SELECT whose rows must equal expectRows
//   probe       an http check that needs a recorded authorization; refused without one
//
// Credentials and other values are never written in a plan. "$env:NAME" is replaced at run time with
// the environment variable NAME. A missing variable blocks the check.

export const CHECK_KINDS = ['http', 'concurrent', 'db', 'probe'];
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const TYPES = ['number', 'string', 'boolean', 'array', 'object'];

export class Blocked extends Error {}
export class Infrastructure extends Error {}

function validateRequest(request, at, problems) {
  if (!request || !METHODS.includes(request.method)) problems.push(`${at}: request.method must be one of ${METHODS.join(', ')}`);
  if (typeof request?.path !== 'string' || !request.path.startsWith('/')) problems.push(`${at}: request.path must start with /`);
}

function validateHttp(check, at, problems) {
  validateRequest(check.request, at, problems);
  if (!check.expect || !Number.isInteger(check.expect.status)) problems.push(`${at}: expect.status must be an integer`);
  for (const assertion of check.expect?.json || []) {
    if (typeof assertion.path !== 'string' || assertion.path === '') problems.push(`${at}: a json assertion needs a path`);
    const kinds = ['equals' in assertion, 'type' in assertion, assertion.absent === true].filter(Boolean);
    if (kinds.length !== 1) problems.push(`${at}: the json assertion on ${assertion.path} needs exactly one of equals, type or absent`);
    if (assertion.type !== undefined && !TYPES.includes(assertion.type)) problems.push(`${at}: type must be one of ${TYPES.join(', ')}`);
  }
}

// Returns the problems with a test case's checks. An empty list means the checks can run.
export function validateChecks(testCase) {
  const id = testCase.id;
  if (!Array.isArray(testCase.checks) || testCase.checks.length === 0) return [`test case ${id} has no checks`];
  const problems = [];
  testCase.checks.forEach((check, i) => {
    const at = `${id} check ${i + 1}`;
    if (!CHECK_KINDS.includes(check?.kind)) {
      problems.push(`${at} needs a kind: ${CHECK_KINDS.join(', ')}`);
      return;
    }
    if (check.as !== undefined && typeof check.as !== 'string') problems.push(`${at}: as must name a role`);
    if (check.kind === 'db') {
      if (typeof check.query !== 'string' || !/^\s*select\b/i.test(check.query) || check.query.includes(';')) {
        problems.push(`${at}: query must be one SELECT statement`);
      }
      if (!Array.isArray(check.expectRows)) problems.push(`${at}: expectRows must be a list`);
    } else if (check.kind === 'concurrent') {
      if (!Number.isInteger(check.count) || check.count < 2) problems.push(`${at}: count must be an integer of at least 2`);
      if (!Array.isArray(check.expectStatuses)) problems.push(`${at}: expectStatuses must be a list`);
      validateRequest(check.request, at, problems);
      if (check.then) validateHttp(check.then, `${at} then`, problems);
    } else {
      validateHttp(check, at, problems);
    }
  });
  return problems;
}

// Replaces "$env:NAME" strings, recursively, with the environment variable NAME.
export function resolveValue(value, env) {
  if (typeof value === 'string' && value.startsWith('$env:')) {
    const name = value.slice(5);
    if (env[name] === undefined || env[name] === '') throw new Blocked(`environment variable ${name} is not set`);
    return env[name];
  }
  if (Array.isArray(value)) return value.map((item) => resolveValue(item, env));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, resolveValue(item, env)]));
  }
  return value;
}

export function getPath(body, path) {
  return path.split('.').reduce((node, key) => (node === null || node === undefined ? undefined : node[key]), body);
}

function typeOf(value) {
  if (Array.isArray(value)) return 'array';
  if (value === null) return 'null';
  return typeof value;
}

export function assertJson(body, assertions = []) {
  const failures = [];
  for (const a of assertions) {
    const actual = getPath(body, a.path);
    if (a.absent === true) {
      if (actual !== undefined) failures.push(`${a.path} should be absent, but it is ${JSON.stringify(actual)}`);
    } else if ('equals' in a) {
      if (JSON.stringify(actual) !== JSON.stringify(a.equals)) {
        failures.push(`${a.path} is ${JSON.stringify(actual)}, expected ${JSON.stringify(a.equals)}`);
      }
    } else if (a.type !== undefined && typeOf(actual) !== a.type) {
      failures.push(`${a.path} is a ${typeOf(actual)}, expected a ${a.type}`);
    }
  }
  return failures;
}

// The rows must match the expected rows in order, and each expected key must equal the row's value.
export function assertRows(rows, expected) {
  if (rows.length !== expected.length) return [`returned ${rows.length} row(s), expected ${expected.length}`];
  const failures = [];
  expected.forEach((want, i) => {
    for (const [key, value] of Object.entries(want)) {
      if (rows[i][key] !== value) failures.push(`row ${i + 1} ${key} is ${JSON.stringify(rows[i][key])}, expected ${JSON.stringify(value)}`);
    }
  });
  return failures;
}

// A failure that comes only from derived, unconfirmed requirements is not a FAIL. The plan says such a
// requirement cannot drive one, so the result is needs-confirmation instead.
export function classify(result, testCase, requirementsById) {
  if (result !== 'failed') return result;
  const reqs = (testCase.requirements || []).map((id) => requirementsById.get(id)).filter(Boolean);
  if (reqs.length > 0 && reqs.every((req) => req.derived === true && req.confirmed !== true)) return 'needs-confirmation';
  return 'failed';
}

// Runs one check. Returns { ok, message }. Throws Blocked when the check cannot run here.
async function runHttp(check, ctx, { probe = false } = {}) {
  if (probe && !ctx.probesAllowed) {
    throw new Blocked('security probes are refused: no authorization is recorded for this run');
  }
  const headers = { 'content-type': 'application/json' };
  if (check.as) headers.authorization = `Bearer ${await ctx.sessionFor(check.as)}`;
  const body = check.request.body === undefined ? undefined : JSON.stringify(resolveValue(check.request.body, ctx.env));
  const response = await ctx.request(check.request.method, check.request.path, { headers, body });
  const failures = [];
  if (response.status !== check.expect.status) failures.push(`status is ${response.status}, expected ${check.expect.status}`);
  failures.push(...assertJson(response.body, check.expect.json));
  return { ok: failures.length === 0, message: failures.join('; '), status: response.status, body: response.body };
}

async function runCheck(check, ctx) {
  if (check.kind === 'db') {
    const rows = await ctx.query(check.query);
    const failures = assertRows(rows, check.expectRows);
    return { ok: failures.length === 0, message: failures.join('; '), rows };
  }
  if (check.kind === 'concurrent') {
    const headers = { 'content-type': 'application/json' };
    if (check.as) headers.authorization = `Bearer ${await ctx.sessionFor(check.as)}`;
    const body = check.request.body === undefined ? undefined : JSON.stringify(resolveValue(check.request.body, ctx.env));
    const responses = await Promise.all(
      Array.from({ length: check.count }, () => ctx.request(check.request.method, check.request.path, { headers, body })),
    );
    const statuses = responses.map((r) => r.status).sort((a, b) => a - b);
    const expected = [...check.expectStatuses].sort((a, b) => a - b);
    if (JSON.stringify(statuses) !== JSON.stringify(expected)) {
      return { ok: false, message: `statuses were ${statuses.join(', ')}, expected ${expected.join(', ')}` };
    }
    if (check.then) return runCheck({ kind: 'http', ...check.then }, ctx);
    return { ok: true, message: '' };
  }
  return runHttp(check, ctx, { probe: check.kind === 'probe' });
}

// Runs one test case. Stops at the first failing check, so a later check never runs on a state the
// failure has already changed. Returns { result, failures, reasons, evidence }.
export async function runTestCase({ testCase, ctx }) {
  const problems = validateChecks(testCase);
  if (problems.length > 0) return { result: 'blocked', failures: [], reasons: problems, evidence: [] };
  const evidence = [];
  for (const [i, check] of testCase.checks.entries()) {
    const label = `check ${i + 1} (${check.kind})`;
    let outcome;
    try {
      outcome = await runCheck(check, ctx);
    } catch (error) {
      if (error instanceof Blocked) return { result: 'blocked', failures: [], reasons: [`${label}: ${error.message}`], evidence };
      if (error instanceof Infrastructure) return { result: 'blocked', failures: [], reasons: [`${label}: infrastructure: ${error.message}`], evidence };
      throw error;
    }
    evidence.push({ check: label, ok: outcome.ok, message: outcome.message });
    if (!outcome.ok) return { result: 'failed', failures: [{ check: label, message: outcome.message }], reasons: [], evidence };
  }
  return { result: 'passed', failures: [], reasons: [], evidence };
}

// Runs the given test cases. Read-only cases run together, on a fresh database when reset is given.
// Mutating cases run one at a time, each on a fresh database. Without reset they are blocked, since a
// mutating case would change the state the next one reads.
export async function runSuite({ testCases, ledger, ctx, reset }) {
  const requirementsById = new Map((ledger.requirements || []).map((r) => [r.id, r]));
  const finish = (testCase, outcome) => ({
    id: testCase.id,
    layer: testCase.layer,
    mutates: testCase.mutates,
    journeys: testCase.journeys || [],
    requirements: testCase.requirements || [],
    result: classify(outcome.result, testCase, requirementsById),
    failures: outcome.failures,
    reasons: outcome.reasons,
    evidence: outcome.evidence,
  });

  if (reset) await reset();
  const readOnly = testCases.filter((t) => !t.mutates);
  const mutating = testCases.filter((t) => t.mutates);
  const results = await Promise.all(readOnly.map(async (t) => finish(t, await runTestCase({ testCase: t, ctx }))));
  for (const testCase of mutating) {
    if (!reset) {
      results.push(finish(testCase, { result: 'blocked', failures: [], reasons: ['a fresh database is needed before a mutating test, and reset is not allowed'], evidence: [] }));
      continue;
    }
    await reset();
    results.push(finish(testCase, await runTestCase({ testCase, ctx })));
  }
  return results.sort((a, b) => (a.id < b.id ? -1 : 1));
}
