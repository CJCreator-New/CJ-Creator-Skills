import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Blocked } from '../scripts/checks.mjs';
import { judgeLoad, loadRefusal, runLoad, validateLoadChecks } from '../scripts/load.mjs';

const LIMITS = { maxVirtualUsers: 4, maxDurationSeconds: 2, maxRequestsPerSecond: 50 };
const CHECK = {
  kind: 'load',
  as: 'manager',
  request: { method: 'GET', path: '/api/orders' },
  virtualUsers: 2,
  durationSeconds: 0.4,
  requestsPerSecond: 25,
  thresholds: { p95Ms: 300, maxErrorRate: 0.01 },
};
const perf = (checks, extra = {}) => ({ id: 'TC-PERF-01', layer: 'perf', mutates: false, checks, ...extra });

describe('validateLoadChecks', () => {
  test('a well-formed load check has no problems', () => {
    assert.deepEqual(validateLoadChecks(perf([CHECK])), []);
  });

  test('a perf test case is read-only, and its request is a GET', () => {
    assert.match(validateLoadChecks(perf([CHECK], { mutates: true }))[0], /must be read-only/);
    assert.match(validateLoadChecks(perf([{ ...CHECK, request: { method: 'POST', path: '/api/orders' } }]))[0], /must be a GET/);
  });

  test('the load and the thresholds are required', () => {
    const problems = validateLoadChecks(perf([{ kind: 'load', request: { method: 'GET', path: '/x' } }]));
    assert.ok(problems.some((p) => /virtualUsers/.test(p)));
    assert.ok(problems.some((p) => /durationSeconds/.test(p)));
    assert.ok(problems.some((p) => /requestsPerSecond/.test(p)));
    assert.ok(problems.some((p) => /p95Ms/.test(p)));
    assert.ok(problems.some((p) => /maxErrorRate/.test(p)));
  });
});

describe('loadRefusal', () => {
  test('refuses without loadLimits, and without the flag for this run', () => {
    assert.match(loadRefusal({}, { E2E_ALLOW_LOAD: '1' }), /config.loadLimits must set/);
    assert.match(loadRefusal({ loadLimits: { maxVirtualUsers: 4 } }, { E2E_ALLOW_LOAD: '1' }), /maxDurationSeconds/);
    assert.match(loadRefusal({ loadLimits: LIMITS }, {}), /set E2E_ALLOW_LOAD=1/);
    assert.equal(loadRefusal({ loadLimits: LIMITS }, { E2E_ALLOW_LOAD: '1' }), null);
  });
});

describe('runLoad', () => {
  test('stays within the rate, and measures latency and errors', async () => {
    let calls = 0;
    const send = async () => {
      calls += 1;
      return calls % 10 === 0 ? 500 : 200;
    };
    const measured = await runLoad(CHECK, { limits: LIMITS, send });
    // 25 per second for 0.4 seconds is 10 requests at most.
    assert.ok(measured.requests <= 10, `sent ${measured.requests}`);
    assert.ok(measured.requests >= 8, `sent ${measured.requests}`);
    assert.equal(measured.errors, 1);
    assert.equal(typeof measured.p95Ms, 'number');
  });

  test('a network error counts as an error, not a crash', async () => {
    const measured = await runLoad({ ...CHECK, durationSeconds: 0.1 }, { limits: LIMITS, send: async () => { throw new Error('refused'); } });
    assert.equal(measured.errorRate, 1);
  });

  test('a load over any config limit is blocked, and nothing is sent', async () => {
    let sent = 0;
    const send = async () => {
      sent += 1;
      return 200;
    };
    await assert.rejects(runLoad({ ...CHECK, virtualUsers: 5 }, { limits: LIMITS, send }), (e) => e instanceof Blocked && /virtualUsers 5 is over the config limit of 4/.test(e.message));
    await assert.rejects(runLoad({ ...CHECK, requestsPerSecond: 51 }, { limits: LIMITS, send }), /requestsPerSecond 51/);
    await assert.rejects(runLoad({ ...CHECK, durationSeconds: 3 }, { limits: LIMITS, send }), /durationSeconds 3/);
    assert.equal(sent, 0);
  });
});

describe('judgeLoad', () => {
  test('passes within the thresholds, and names each breach', () => {
    assert.equal(judgeLoad(CHECK, { requests: 10, p95Ms: 120, errorRate: 0 }).ok, true);
    const breach = judgeLoad(CHECK, { requests: 10, p95Ms: 450, errorRate: 0.1 });
    assert.equal(breach.ok, false);
    assert.match(breach.message, /p95 was 450 ms, over the threshold of 300 ms/);
    assert.match(breach.message, /error rate was 10.0%, over the threshold of 1.0%/);
  });
});
