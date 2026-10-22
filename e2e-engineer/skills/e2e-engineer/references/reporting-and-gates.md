# Reporting and gates

The artifact package is rendered from the ledger by `scripts/artifacts.mjs`. It is the same every time for the same ledger and the same time.

## Files

| File | Content |
| --- | --- |
| `00_QA_EXECUTIVE_SUMMARY.md` | Gate status and its reasons, build, plan state, approval, scope, counts, plan check results |
| `01_APPLICATION_AND_ARCHITECTURE_INVENTORY.md` | Targets and readiness, operations, roles, routes |
| `02_SCREEN_AND_UI_INTERACTION_INVENTORY.md` | Each screen: its route, roles, controls with their tests, states, design status |
| `03_USER_FLOW_AND_GOLDEN_PATHS.md` | Each journey: priority, roles, branches, the tests that cover it |
| `04_RBAC_AND_PERMISSION_TEST_MATRIX.md` | The role-permission matrix, and each permission's denial or reason |
| `05_MASTER_QA_STRATEGY.md` | Scope, exclusions, oracle policy, priorities, layers, entry and exit |
| `06_TEST_CASE_CATALOG.md` | Every test case with its layer, oracle, requirements, journeys and first expected result |
| `07_TEST_EXECUTION_PLAN.md` | Read-only lane in parallel, mutating lane in series, stop conditions, retest |
| `08_MOCK_DATA_AND_ENVIRONMENT_GUIDE.md` | Fixtures and accounts by role, with environment-variable names only |
| `09_DEFECT_AND_REMEDIATION_REGISTER.md` | Defects with severity, status, owner and the current state of their test cases; handoff, claim, retest and regression for each |
| `10_ACCEPTANCE_CRITERIA_AND_REGRESSION_PLAN.md` | Each requirement with its oracle, confirmation and tests; the regression rule |
| `11_FINAL_QA_REPORT.md` | Gate status, coverage as separate measures, test cases by state, defects by severity, security, unverified areas (blocked, gaps, unconfirmed, flaky, stale, out of scope), recommendation |
| `data/*.json` | Traceability, flow coverage, the role-permission matrix, the test catalogue and the defect register |

## Coverage

Coverage is reported as separate measures, never as one percentage: requirements with test cases, P0 journeys with test cases, screens in journeys, controls mapped to test cases, permissions with test cases, operations with test cases, and test cases by automation status (planned, implemented, executed). A mapped test is not an implemented test, and an implemented test is not an executed test. Each is counted on its own.

## Gate status

The gate status is computed by `status()` in the ledger, with this precedence:

1. Any in-scope test case whose current state is failed, or any open Critical or High defect, gives `FAIL`.
2. Otherwise, intake not run, a refused run, an unapproved plan, a plan changed after approval, a blocked target in scope, or a blocked test case on a P0 journey gives `BLOCKED`, with the reason.
3. Otherwise, no journeys, a P0 journey without a current pass on each of its test cases, any other in-scope test case without a current pass (not run, stale, flaky, needs-confirmation), or any open defect gives `PARTIALLY TESTED`.
4. Otherwise `PASS`.

A test case's state is read from its runs on the current build, under its current definition. A run from an earlier build, or from before the test case changed, is `stale`. A test case that passed and failed on the same build is `flaky`. Test cases the plan takes out of scope (`outOfScope`, with the reason) are not run, do not count, and are listed with the status.

`PASS WITH ACCEPTED RISKS` needs a named decision for each accepted item, and it is not produced in this version. The artifacts do not change the status. A report that disagrees with the status states the disagreement as a decision for the user.

## Blocked is not skipped

A test whose target has no tools is `blocked`, with the reason, in the report. It is never `skipped`. A blocked target in scope keeps the gate at `BLOCKED`, so an absent device cannot pass as a clean run.
