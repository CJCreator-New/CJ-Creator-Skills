# Discovery and oracles

Discovery finds what the application does and what it must do. The two are different, and the plan keeps them apart.

## Order

1. **Repository map** (`repo-intel`): routes, handlers, the authorization checks, the schema, the mobile projects and manifests, and the existing tests.
2. **Journeys** (`flow-analyst`): each user action traced to the screens it uses, the operations it calls, the permissions it needs, and the branches it has.
3. **Roles and permissions** (`rbac-analyst`): every protected action, with an outcome for every role. The outcomes come from the code or the spec. Where the interface hides an action the server does not refuse, record it as `ui-only`.
4. **Screens and controls** (`ux-analyst`): every route and control, the states each screen can show, and the design reference for each screen.
5. **Test catalogue** (`test-strategist`): test cases traced to requirements, with oracles.

The analysts are read-only. The orchestrator saves their JSON to `.claude/e2e-engineer/drafts/` and adds each item with `ledger.mjs add`. The ledger checks the item's shape. The plan check (`validatePlan`) checks the whole plan before it can be frozen.

## Oracles

An oracle is what a test compares the behaviour against. The plan records one for every requirement and every test case.

| Oracle | What it is | Can it PASS or FAIL? |
| --- | --- | --- |
| `contract` | An API or schema statement, such as the OpenAPI document | Yes |
| `spec` | A written requirement or acceptance criterion | Yes |
| `design` | A design reference | Yes, when the reference is present |
| `doc` | A published standard, such as WCAG or a platform guideline | Yes |
| `observed` | Nothing states the behaviour; the test records what happens | No. It records behaviour that needs confirmation |

Rules that the plan enforces:

- A test case's oracle matches the oracle of every requirement it checks. A test case never gets a stronger oracle than its requirement.
- A test that checks an `observed` requirement has the `observed` oracle. It cannot PASS or FAIL, so the report lists it under "needs confirmation", not under defects.
- A derived requirement is one the analyst inferred. It stays `confirmed: false` until the user confirms it, and an unconfirmed derived requirement cannot drive a FAIL.
- The code is never an oracle. "The code does this" is an observation.

## Gaps and warnings

A **gap** is a finding about the plan: a control with no test, a requirement with no test, a permission with no denied role and no stated reason, a control with no label in the spec. Gaps do not stop the freeze. They are listed in the report under "unverified areas".

A **warning** is a risk the plan carries: a derived requirement not confirmed, an observed oracle, a role used by no journey.

An **error** stops the freeze. Errors are: a missing oracle, a P0 journey with no test or no failure branch, a test case with no requirement and a non-observed oracle, a reference to an ID the plan does not have, a permission with no allowing rule, and a missing design map.
