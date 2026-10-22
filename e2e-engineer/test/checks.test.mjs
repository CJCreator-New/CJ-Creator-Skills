import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import {
  assertJson,
  assertRows,
  Blocked,
  classify,
  getPath,
  Infrastructure,
  resolveValue,
  runSuite,
  runTestCase,
  validateChecks,
} from '../scripts/checks.mjs';

// A context whose requests return the given responses in order. It records each call.
function fakeContext({ responses = [], env = {}, probesAllowed = false, rows = [] } = {}) {
  const calls = [];
  let i = 0;
  return {
    calls,
    env,
    probesAllowed,
    async request(method, path, options) {
      calls.push({ method, path, options });
      const next = responses[Math.min(i, responses.length - 1)];
      i += 1;
      if (next instanceof Error) throw next;
      return next;
    },
    async sessionFor(role) {
      calls.push({ session: role });
      return `token-${role}`;
    },
    async query(sql) {
      calls.push({ query: sql });
      return rows;
    },
  };
}

const ok = (status, body) => ({ status, body });

describe('validateChecks', () => {
  test('accepts a well-formed http check', () => {
    const tc = { id: 'TC-1', checks: [{ kind: 'http', request: { method: 'GET', path: '/x' }, expect: { status: 200 } }] };
    assert.deepEqual(validateChecks(tc), []);
  });

  test('refuses a test case with no checks', () => {
    assert.deepEqual(validateChecks({ id: 'TC-1' }), ['test case TC-1 has no checks']);
  });

  test('refuses an unknown kind, a bad method, and a path without a slash', () => {
    const problems = validateChecks({
      id: 'TC-1',
      checks: [
        { kind: 'shell' },
        { kind: 'http', request: { method: 'FETCH', path: 'x' }, expect: { status: 200 } },
      ],
    });
    assert.ok(problems.some((p) => p.includes('needs a kind')));
    assert.ok(problems.some((p) => p.includes('request.method')));
    assert.ok(problems.some((p) => p.includes('request.path must start with /')));
  });

  test('refuses a SELECT with a second statement, and a concurrent check with fewer than two requests', () => {
    const problems = validateChecks({
      id: 'TC-1',
      checks: [
        { kind: 'db', query: 'SELECT 1; DROP TABLE users', expectRows: [] },
        { kind: 'concurrent', request: { method: 'POST', path: '/x' }, count: 1, expectStatuses: [200] },
      ],
    });
    assert.ok(problems.some((p) => p.includes('one SELECT statement')));
    assert.ok(problems.some((p) => p.includes('at least 2')));
  });

  test('refuses a json assertion with no comparison', () => {
    const problems = validateChecks({
      id: 'TC-1',
      checks: [{ kind: 'http', request: { method: 'GET', path: '/x' }, expect: { status: 200, json: [{ path: 'a' }] } }],
    });
    assert.ok(problems.some((p) => p.includes('needs exactly one of equals, type or absent')));
  });
});

describe('resolveValue', () => {
  test('replaces $env: strings from the environment, recursively', () => {
    assert.deepEqual(resolveValue({ username: '$env:U', nested: ['$env:U'] }, { U: 'manager' }), {
      username: 'manager',
      nested: ['manager'],
    });
  });

  test('blocks when the variable is not set', () => {
    assert.throws(() => resolveValue({ password: '$env:P' }, {}), (e) => e instanceof Blocked && /environment variable P is not set/.test(e.message));
  });
});

describe('assertions', () => {
  test('getPath reads dotted paths and returns undefined for a missing one', () => {
    assert.equal(getPath({ order: { total: 5 } }, 'order.total'), 5);
    assert.equal(getPath({ order: null }, 'order.total'), undefined);
  });

  test('assertJson checks equals, type and absent', () => {
    const body = { order: { total: '500' }, secret: 'x' };
    assert.deepEqual(assertJson(body, [{ path: 'order.total', type: 'number' }]), ['order.total is a string, expected a number']);
    assert.deepEqual(assertJson(body, [{ path: 'secret', absent: true }]), ['secret should be absent, but it is "x"']);
    assert.deepEqual(assertJson(body, [{ path: 'order.total', equals: '500' }]), []);
  });

  test('assertRows checks the count, then each expected key in order', () => {
    assert.deepEqual(assertRows([{ status: 'pending' }], []), ['returned 1 row(s), expected 0']);
    assert.deepEqual(assertRows([{ status: 'pending', approvals: 0 }], [{ status: 'approved', approvals: 1 }]), [
      'row 1 status is "pending", expected "approved"',
      'row 1 approvals is 0, expected 1',
    ]);
    assert.deepEqual(assertRows([{ status: 'approved', approvals: 1 }], [{ status: 'approved' }]), []);
  });
});

describe('classify', () => {
  const reqs = new Map([
    ['REQ-A', { id: 'REQ-A', derived: true, confirmed: false }],
    ['REQ-B', { id: 'REQ-B', derived: false }],
  ]);

  test('a failure from only derived, unconfirmed requirements is needs-confirmation, not failed', () => {
    assert.equal(classify('failed', { requirements: ['REQ-A'] }, reqs), 'needs-confirmation');
  });

  test('a failure from a confirmed requirement stays failed', () => {
    assert.equal(classify('failed', { requirements: ['REQ-B'] }, reqs), 'failed');
    assert.equal(classify('failed', { requirements: ['REQ-A', 'REQ-B'] }, reqs), 'failed');
  });

  test('a pass is never reclassified', () => {
    assert.equal(classify('passed', { requirements: ['REQ-A'] }, reqs), 'passed');
  });
});

describe('runTestCase', () => {
  const login = { kind: 'http', request: { method: 'GET', path: '/a' }, expect: { status: 200 } };
  const second = { kind: 'http', request: { method: 'GET', path: '/b' }, expect: { status: 200 } };

  test('passes when every check holds', async () => {
    const ctx = fakeContext({ responses: [ok(200, {}), ok(200, {})] });
    const result = await runTestCase({ testCase: { id: 'TC-1', checks: [login, second] }, ctx });
    assert.equal(result.result, 'passed');
    assert.equal(ctx.calls.filter((c) => c.path).length, 2);
  });

  test('fails at the first failing check, and does not run the checks after it', async () => {
    const ctx = fakeContext({ responses: [ok(500, {}), ok(200, {})] });
    const result = await runTestCase({ testCase: { id: 'TC-1', checks: [login, second] }, ctx });
    assert.equal(result.result, 'failed');
    assert.equal(result.failures[0].check, 'check 1 (http)');
    assert.equal(result.failures[0].message, 'status is 500, expected 200');
    assert.equal(ctx.calls.filter((c) => c.path).length, 1);
  });

  test('blocks, and does not fail, when a credential is missing', async () => {
    const testCase = {
      id: 'TC-1',
      checks: [{ kind: 'http', request: { method: 'POST', path: '/a', body: { password: '$env:P' } }, expect: { status: 200 } }],
    };
    const result = await runTestCase({ testCase, ctx: fakeContext({ responses: [ok(200, {})] }) });
    assert.equal(result.result, 'blocked');
    assert.match(result.reasons[0], /environment variable P is not set/);
  });

  test('blocks, and does not fail, when the network fails twice', async () => {
    const result = await runTestCase({
      testCase: { id: 'TC-1', checks: [login] },
      ctx: fakeContext({ responses: [new Infrastructure('connection refused')] }),
    });
    assert.equal(result.result, 'blocked');
    assert.match(result.reasons[0], /infrastructure: connection refused/);
  });

  test('a probe is refused without an authorization, and is blocked', async () => {
    const probe = { kind: 'probe', request: { method: 'GET', path: '/a' }, expect: { status: 200 } };
    const ctx = fakeContext({ responses: [ok(200, {})], probesAllowed: false });
    const result = await runTestCase({ testCase: { id: 'TC-1', checks: [probe] }, ctx });
    assert.equal(result.result, 'blocked');
    assert.match(result.reasons[0], /security probes are refused/);
    assert.equal(ctx.calls.length, 0, 'no request is sent for a refused probe');
  });

  test('a probe runs when the authorization is recorded', async () => {
    const probe = { kind: 'probe', request: { method: 'GET', path: '/a' }, expect: { status: 200 } };
    const result = await runTestCase({
      testCase: { id: 'TC-1', checks: [probe] },
      ctx: fakeContext({ responses: [ok(200, {})], probesAllowed: true }),
    });
    assert.equal(result.result, 'passed');
  });

  test('a concurrent check passes when the statuses match, and runs its then check', async () => {
    const check = {
      kind: 'concurrent',
      request: { method: 'POST', path: '/a' },
      count: 2,
      expectStatuses: [200, 409],
      then: { kind: 'http', request: { method: 'GET', path: '/b' }, expect: { status: 200, json: [{ path: 'n', equals: 1 }] } },
    };
    const ctx = fakeContext({ responses: [ok(200, {}), ok(409, {}), ok(200, { n: 1 })] });
    const result = await runTestCase({ testCase: { id: 'TC-1', checks: [check] }, ctx });
    assert.equal(result.result, 'passed');
  });

  test('a concurrent check fails when both requests succeed', async () => {
    const check = { kind: 'concurrent', request: { method: 'POST', path: '/a' }, count: 2, expectStatuses: [200, 409] };
    const result = await runTestCase({ testCase: { id: 'TC-1', checks: [check] }, ctx: fakeContext({ responses: [ok(200, {})] }) });
    assert.equal(result.result, 'failed');
    assert.equal(result.failures[0].message, 'statuses were 200, 200, expected 200, 409');
  });

  test('a db check reads the rows through the context', async () => {
    const check = { kind: 'db', query: 'SELECT n FROM t', expectRows: [{ n: 1 }] };
    const ctx = fakeContext({ rows: [{ n: 1 }] });
    assert.equal((await runTestCase({ testCase: { id: 'TC-1', checks: [check] }, ctx })).result, 'passed');
    assert.deepEqual(ctx.calls[0], { query: 'SELECT n FROM t' });
  });

  test('an invalid plan is blocked, not run', async () => {
    const result = await runTestCase({ testCase: { id: 'TC-1', checks: [] }, ctx: fakeContext() });
    assert.equal(result.result, 'blocked');
  });
});

describe('runSuite', () => {
  const ledger = { requirements: [] };
  const read = (id) => ({ id, layer: 'api', mutates: false, checks: [{ kind: 'http', request: { method: 'GET', path: '/r' }, expect: { status: 200 } }] });
  const write = (id) => ({ id, layer: 'api', mutates: true, checks: [{ kind: 'http', request: { method: 'POST', path: '/w' }, expect: { status: 201 } }] });

  test('resets the database before each mutating test, so each starts from the seed', async () => {
    const order = [];
    const ctx = fakeContext({ responses: [ok(200, {}), ok(201, {}), ok(201, {})] });
    const originalRequest = ctx.request;
    ctx.request = async (method, path, options) => {
      order.push(`${method} ${path}`);
      return originalRequest(method, path, options);
    };
    const reset = async () => order.push('reset');
    await runSuite({ testCases: [write('TC-W1'), write('TC-W2')], ledger, ctx, reset });
    assert.deepEqual(order, ['reset', 'reset', 'POST /w', 'reset', 'POST /w']);
  });

  test('blocks mutating tests when no reset is allowed, and still runs the read-only ones', async () => {
    const results = await runSuite({ testCases: [read('TC-R1'), write('TC-W1')], ledger, ctx: fakeContext({ responses: [ok(200, {})] }), reset: null });
    const byId = Object.fromEntries(results.map((r) => [r.id, r]));
    assert.equal(byId['TC-R1'].result, 'passed');
    assert.equal(byId['TC-W1'].result, 'blocked');
    assert.match(byId['TC-W1'].reasons[0], /reset is not allowed/);
  });

  test('returns the results sorted by test case ID', async () => {
    const results = await runSuite({ testCases: [read('TC-B'), read('TC-A')], ledger, ctx: fakeContext({ responses: [ok(200, {})] }), reset: null });
    assert.deepEqual(results.map((r) => r.id), ['TC-A', 'TC-B']);
  });
});
