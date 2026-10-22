// Load checks for perf test cases. A load check sends one read-only request from a fixed number of
// virtual users for a fixed time, at no more than a fixed rate, then compares the latency and error
// rate with the thresholds the plan states. Every limit is bounded by the config's loadLimits, and a
// check that asks for more than the limits allow is blocked, not scaled down.
//
//   { "kind": "load", "as": "manager", "request": { "method": "GET", "path": "/api/orders" },
//     "virtualUsers": 4, "durationSeconds": 2, "requestsPerSecond": 20, "expectStatus": 200,
//     "thresholds": { "p95Ms": 300, "maxErrorRate": 0.01 } }
//
// Thresholds come from a requirement. A threshold the team has not set is a derived requirement, so a
// breach is needs-confirmation until the team confirms it (G21: thresholds are PROPOSED until approved).

import { Blocked } from './checks.mjs';

export const LOAD_LIMIT_KEYS = ['maxVirtualUsers', 'maxDurationSeconds', 'maxRequestsPerSecond'];
export const LOAD_FLAG = 'E2E_ALLOW_LOAD';

const positive = (value) => typeof value === 'number' && Number.isFinite(value) && value > 0;

// Returns the problems with a perf test case's checks. Load runs only read-only requests.
export function validateLoadChecks(testCase) {
  const id = testCase.id;
  if (testCase.mutates !== false) return [`test case ${id} is a perf test, so it must be read-only (mutates: false)`];
  if (!Array.isArray(testCase.checks) || testCase.checks.length === 0) return [`test case ${id} has no checks`];
  const problems = [];
  testCase.checks.forEach((check, i) => {
    const at = `${id} check ${i + 1}`;
    if (check?.kind !== 'load') {
      problems.push(`${at}: a perf test case uses kind load`);
      return;
    }
    if (check.request?.method !== 'GET') problems.push(`${at}: a load request must be a GET`);
    if (typeof check.request?.path !== 'string' || !check.request.path.startsWith('/')) problems.push(`${at}: request.path must start with /`);
    if (!Number.isInteger(check.virtualUsers) || check.virtualUsers < 1) problems.push(`${at}: virtualUsers must be a positive integer`);
    if (!positive(check.durationSeconds)) problems.push(`${at}: durationSeconds must be a positive number`);
    if (!positive(check.requestsPerSecond)) problems.push(`${at}: requestsPerSecond must be a positive number`);
    const t = check.thresholds || {};
    if (!positive(t.p95Ms)) problems.push(`${at}: thresholds.p95Ms must be a positive number`);
    if (typeof t.maxErrorRate !== 'number' || t.maxErrorRate < 0 || t.maxErrorRate > 1) problems.push(`${at}: thresholds.maxErrorRate must be between 0 and 1`);
  });
  return problems;
}

// Why a load run is refused, or null when it may run. It needs the limits in config and the flag set
// for this run, so a load test never starts by accident.
export function loadRefusal(config, env) {
  const limits = config.loadLimits;
  if (!limits || !LOAD_LIMIT_KEYS.every((key) => positive(limits[key]))) {
    return `config.loadLimits must set ${LOAD_LIMIT_KEYS.join(', ')}`;
  }
  if (env[LOAD_FLAG] !== '1') return `set ${LOAD_FLAG}=1 to allow a load run against this environment`;
  return null;
}

function percentile(sorted, p) {
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)];
}

// Sends the check's request from each virtual user until the time is up. A shared schedule spaces the
// requests so the rate never exceeds requestsPerSecond. Returns the measurements.
export async function runLoad(check, { limits, send, clock = () => performance.now(), sleep }) {
  for (const [value, limit, name] of [
    [check.virtualUsers, limits.maxVirtualUsers, 'virtualUsers'],
    [check.durationSeconds, limits.maxDurationSeconds, 'durationSeconds'],
    [check.requestsPerSecond, limits.maxRequestsPerSecond, 'requestsPerSecond'],
  ]) {
    if (value > limit) throw new Blocked(`${name} ${value} is over the config limit of ${limit}`);
  }
  const wait = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  const expectStatus = check.expectStatus ?? 200;
  const interval = 1000 / check.requestsPerSecond;
  const start = clock();
  const end = start + check.durationSeconds * 1000;
  let next = start;
  const latencies = [];
  let errors = 0;

  async function user() {
    for (;;) {
      const slot = next;
      next += interval;
      if (slot >= end) return;
      const now = clock();
      if (slot > now) await wait(slot - now);
      const sent = clock();
      let ok = false;
      try {
        ok = (await send()) === expectStatus;
      } catch {
        ok = false;
      }
      latencies.push(clock() - sent);
      if (!ok) errors += 1;
    }
  }
  await Promise.all(Array.from({ length: check.virtualUsers }, user));

  const sorted = [...latencies].sort((a, b) => a - b);
  const round = (ms) => (ms === null ? null : Math.round(ms * 10) / 10);
  const elapsed = Math.max(clock() - start, 1);
  return {
    requests: latencies.length,
    errors,
    errorRate: latencies.length === 0 ? 1 : errors / latencies.length,
    p50Ms: round(percentile(sorted, 50)),
    p95Ms: round(percentile(sorted, 95)),
    p99Ms: round(percentile(sorted, 99)),
    achievedRps: Math.round((latencies.length / elapsed) * 10000) / 10,
  };
}

// Compares measurements with the thresholds. Returns { ok, message }.
export function judgeLoad(check, measured) {
  const failures = [];
  if (measured.requests === 0) failures.push('no request completed');
  if (measured.p95Ms !== null && measured.p95Ms > check.thresholds.p95Ms) {
    failures.push(`p95 was ${measured.p95Ms} ms, over the threshold of ${check.thresholds.p95Ms} ms`);
  }
  if (measured.errorRate > check.thresholds.maxErrorRate) {
    failures.push(`error rate was ${(measured.errorRate * 100).toFixed(1)}%, over the threshold of ${(check.thresholds.maxErrorRate * 100).toFixed(1)}%`);
  }
  return { ok: failures.length === 0, message: failures.join('; ') };
}
