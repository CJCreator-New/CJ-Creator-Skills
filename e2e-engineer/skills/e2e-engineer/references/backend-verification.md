# Backend verification (e2e-backend)

The API and data legs of each journey are verified with executable checks. A test case with the `api` or `db` layer, and the `implemented` automation status, lists its checks. The runner runs them against the target. A test case that describes a check in prose and has no checks cannot be marked implemented; the plan check refuses it.

## Check kinds

| Kind | What it does | Passes when |
| --- | --- | --- |
| `http` | One request, optionally as a role | The status is as expected, and each JSON assertion holds |
| `concurrent` | The same request, `count` times at once | The statuses, sorted, equal `expectStatuses`. An optional `then` check runs after and must pass |
| `db` | One read-only `SELECT` | The rows match `expectRows` in order, for each expected key |
| `probe` | An `http` check that needs a recorded authorization | As `http`, but refused, and blocked, without an authorization |

A JSON assertion is one of `equals`, `type` (`number`, `string`, `boolean`, `array`, `object`) or `absent`. Paths are dotted, such as `order.total`.

Example, from the fixture plan:

```json
{
  "kind": "concurrent",
  "as": "manager",
  "request": { "method": "POST", "path": "/api/orders/o-1/approve" },
  "count": 2,
  "expectStatuses": [200, 409],
  "then": {
    "as": "manager",
    "request": { "method": "GET", "path": "/api/orders/o-1" },
    "expect": { "status": 200, "json": [{ "path": "order.approvals", "equals": 1 }] }
  }
}
```

## Credentials

A plan never holds a credential value. A role names two environment variables, for its username and its password. A check that needs a session signs in with `as`. A request body can use `"$env:NAME"` for a value the environment supplies. A missing variable blocks the check and says which one.

## Isolation and reset

Each mutating test case runs on a fresh database: the runner resets it before the test. This removes any dependency on the order of tests. Read-only test cases run together on one fresh database. Without `allowReset`, mutating test cases are `blocked`, because the next one would read the state the last one left.

The database is written only when it passes validation: its run marker must name the configured database. A database this tool did not seed is never written. Seeding refuses a database that already has tables.

## Invariants, not timing

A race is tested by sending the requests at once and asserting the outcome: one success and one conflict, and a stored count of one. The check never waits a set time and hopes the race happens. A check that passes once does not prove the race is absent; the concurrency test is what gives that evidence, and it is re-run after each fix.

## Security probes

A probe is refused unless the run's configuration records an authorization: scope, who authorized it, and when. A refused probe is reported as refused, and the static checks still run. Probes use marker values that show whether input was stored or executed, and they never send a payload that is destructive.

The authorization is recorded in the config, by the person who gives it: `"authorization": { "scope": "...", "authorizedBy": "<name>", "date": "<YYYY-MM-DD>", "maxRequests": 20 }`. The example config leaves it `null`, so probes are refused until someone records it.

A probe check names a preset with `probe`. The expectation comes from the plan; each preset has a default.

| Preset | Sends | Passes when |
| --- | --- | --- |
| `session-tamper` | the role's token with characters added (`as` names the role) | the status is `expect.status`, 401 by default |
| `no-session` | no token | the status is `expect.status`, 401 by default |
| `injection` | each marker in turn in the body `field`: SQL, script, template, path traversal | no answer is 5xx, and each is one of `expect.statuses` when given |
| `rate-limit` | up to `count` requests, never more than `authorization.maxRequests` (20 by default) | one of them gets `expect.status`, 429 by default |
| `cors` | a request from a foreign `Origin` | the response does not allow that origin, or every origin, with credentials |

A failed probe stops the mutating test cases that follow it on that host (see the stop conditions in `SKILL.md`), and the finding is reported at once.

## What a result means

- `passed`: every check in the test case held on the current build.
- `failed`: a check did not hold. The first failure is recorded, and a defect is opened for the test case, unless the failing requirements are derived and unconfirmed. Then the result is `needs-confirmation`, and no defect is opened.
- `blocked`: a check could not run. Blocked is never a pass, and a blocked P0 test case keeps the gate at BLOCKED.
- `stale`: the run was for an earlier build. It does not count.

A test case counts toward its P0 journey only when every test case linked to the journey passed on the current build.
