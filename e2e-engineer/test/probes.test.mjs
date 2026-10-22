// The security probe presets, against a stand-in server, so each can be seen to fail as well as pass.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { Blocked, INJECTION_MARKERS, runCheck, validateChecks } from '../scripts/checks.mjs';

// A stand-in context. `answer(method, path, options)` returns { status, body, headers }.
function ctx(answer, extra = {}) {
  const calls = [];
  return {
    calls,
    probesAllowed: true,
    probeLimit: 20,
    env: {},
    sessionFor: async () => 'token-123',
    request: async (method, path, options) => {
      calls.push({ method, path, options });
      return answer(method, path, options);
    },
    ...extra,
  };
}
const get = { method: 'GET', path: '/api/orders' };

describe('probe presets', () => {
  test('need a recorded authorization', async () => {
    await assert.rejects(runCheck({ kind: 'probe', probe: 'no-session', request: get }, ctx(() => ({ status: 401 }), { probesAllowed: false })), (e) => e instanceof Blocked);
  });

  test('session-tamper sends the role token with characters added, and fails when it is accepted', async () => {
    const accepted = ctx(() => ({ status: 200 }));
    const outcome = await runCheck({ kind: 'probe', probe: 'session-tamper', as: 'manager', request: get }, accepted);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /status was 200 with a tampered session, expected 401/);
    assert.equal(accepted.calls[0].options.headers.authorization, 'Bearer token-123e2e-tampered');
    assert.equal((await runCheck({ kind: 'probe', probe: 'session-tamper', as: 'manager', request: get }, ctx(() => ({ status: 401 })))).ok, true);
  });

  test('no-session sends no token', async () => {
    const c = ctx(() => ({ status: 401 }));
    assert.equal((await runCheck({ kind: 'probe', probe: 'no-session', request: get }, c)).ok, true);
    assert.equal(c.calls[0].options.headers.authorization, undefined);
  });

  test('injection sends each marker in the field, and fails on a server error or an unexpected status', async () => {
    const check = { kind: 'probe', probe: 'injection', as: 'staff', field: 'item', request: { method: 'POST', path: '/api/orders', body: { item: 'x', total: 10 } }, expect: { statuses: [201, 422] } };
    const c = ctx((m, p, o) => ({ status: JSON.parse(o.body).item.includes('DROP') ? 500 : 201 }));
    const outcome = await runCheck(check, c);
    assert.equal(c.calls.length, INJECTION_MARKERS.length);
    assert.equal(outcome.ok, false);
    assert.match(outcome.message, /DROP TABLE e2e_probe.* gave 500/);
    assert.equal((await runCheck(check, ctx(() => ({ status: 422 })))).ok, true);
    assert.match((await runCheck(check, ctx(() => ({ status: 200 })))).message, /gave 200, expected one of 201, 422/);
  });

  test('rate-limit stops at the first 429, and never sends more than the authorization allows', async () => {
    let n = 0;
    const limited = ctx(() => ({ status: (n += 1) >= 5 ? 429 : 200 }));
    assert.equal((await runCheck({ kind: 'probe', probe: 'rate-limit', request: get, count: 50 }, limited)).ok, true);
    assert.equal(limited.calls.length, 5);
    const open = ctx(() => ({ status: 200 }), { probeLimit: 7 });
    const outcome = await runCheck({ kind: 'probe', probe: 'rate-limit', request: get, count: 50 }, open);
    assert.equal(open.calls.length, 7);
    assert.match(outcome.message, /no 429 after 7 requests/);
  });

  test('cors fails when a foreign origin is allowed with credentials', async () => {
    const open = ctx(() => ({ status: 200, headers: { 'access-control-allow-origin': 'https://e2e-probe.invalid', 'access-control-allow-credentials': 'true' } }));
    assert.match((await runCheck({ kind: 'probe', probe: 'cors', request: get }, open)).message, /is allowed with credentials/);
    assert.equal((await runCheck({ kind: 'probe', probe: 'cors', request: get }, ctx(() => ({ status: 200, headers: {} })))).ok, true);
  });

  test('are checked at plan time', () => {
    assert.match(validateChecks({ id: 'T', checks: [{ kind: 'probe', probe: 'ddos', request: get }] })[0], /probe must be one of/);
    assert.match(validateChecks({ id: 'T', checks: [{ kind: 'probe', probe: 'session-tamper', request: get }] })[0], /needs as/);
    assert.match(validateChecks({ id: 'T', checks: [{ kind: 'probe', probe: 'injection', request: get }] })[0], /needs field/);
  });
});
