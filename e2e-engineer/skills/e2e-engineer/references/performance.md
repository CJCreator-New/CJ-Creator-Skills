# Performance (perf-runner)

Load testing is opt-in (G21). It runs only when the user asks for it, against the test environment, within limits the config declares.

## Two locks

A load run refuses to start unless both are in place:

1. `loadLimits` in the config, with `maxVirtualUsers`, `maxDurationSeconds` and `maxRequestsPerSecond`.
2. `E2E_ALLOW_LOAD=1` in the environment of this run.

The allowlist and the production-name refusal from intake still apply. A load check that asks for more than any limit is blocked, not scaled down.

## The perf test case

A perf test case has the layer `perf`, is read-only (`mutates: false`), and lists load checks:

```json
{ "kind": "load", "as": "manager", "request": { "method": "GET", "path": "/api/orders" },
  "virtualUsers": 4, "durationSeconds": 10, "requestsPerSecond": 20, "expectStatus": 200,
  "thresholds": { "p95Ms": 300, "maxErrorRate": 0.01 } }
```

Each virtual user sends the request in a loop for the duration. A shared schedule spaces the requests so the total never exceeds `requestsPerSecond`. A response with a status other than `expectStatus`, or a network error, is an error. The run records requests, errors, error rate, p50, p95, p99, and the rate achieved.

Load sends only GET requests. Load on writes would change the test data under every other test; it is not supported.

## Thresholds

A threshold is a requirement, with its oracle. A threshold the team has not set is a derived requirement: it is PROPOSED, and a breach of it is `needs-confirmation`, not a defect. When the team confirms the requirement, a breach is a failure and opens a defect.

Measurements in a shared test environment are noisy. Keep thresholds coarse, and read a near-miss as a reason to look, not as a verdict.

## Running it

`E2E_ALLOW_LOAD=1 node "${CLAUDE_PLUGIN_ROOT}/scripts/run-perf.mjs" <ledger> <config> --root <repo> --base <url>`

Perf test cases run one at a time, so two loads never add up past the limits.

## What this version does not do

- Stress, soak and spike profiles.
- Load on writes.
- Server-side metrics (CPU, memory, database time). The measurements are client-side only.
