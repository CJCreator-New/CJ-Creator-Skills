# Triage, handoff, retest and regression

The skill finds defects and proves fixes. It never writes the fix (G7). A defect goes to its owner as a handoff packet, the fix comes back as a new build, and the skill retests it by test ID. Only runs on the new build can close the defect.

## Defect states

`Detected`, `Confirmed`, `Triaged`, `Handed Off`, `Fix Claimed`, `Retest Passed`, `Regression Passed`, `Closed`.

| Move | Made by | Command |
| --- | --- | --- |
| Confirmed | a runner, when a confirmed requirement fails | `run-*.mjs` |
| Triaged | the orchestrator, from the `triage` agent's proposal | `ledger.mjs triage <ledger> DEF-001 --severity High --owner backend-engineer --root-cause "<one sentence>" --by <name> [--disposition test]` |
| Handed Off | the orchestrator | `ledger.mjs handoff <ledger> DEF-001` |
| Fix Claimed | the owner says the fix is in | `ledger.mjs claim <ledger> DEF-001 --by <owner> --note "<what changed>"` |
| Retest Passed, Regression Passed, Closed | the ledger, from the runs | after every run, or `ledger.mjs evaluate <ledger>` |

Every move is kept in the defect's `history`. `ledger.mjs defects <ledger>` lists each defect with the current state of its test cases.

## Triage

The `triage` agent proposes; the orchestrator records. Severity has a floor the ledger enforces: a defect on a requirement the plan tags with a `risk` (`tenant-isolation`, `auth-bypass`, `data-exposure`, `data-loss`, `payment`) is Critical; a defect on a P0 journey, or on an access-control case, is at least High. A Critical defect needs an independent second review, by someone other than the triager, before it can be handed off:

`ledger.mjs review <ledger> DEF-001 --by <reviewer> --verdict confirmed`, or `--verdict changed --severity High`.

Two defects with the same root cause merge into one: `ledger.mjs merge <ledger> DEF-002 DEF-001 --by <name>`. The duplicate closes as a duplicate, and its test cases move to the defect it merged into.

A `test` disposition means the test is wrong, not the app. Its fix is a plan change, and a changed plan needs a new approval.

## The handoff packet

`ledger.mjs handoff` writes `.claude/e2e-engineer/handoffs/HO-DEF-001-<n>.md` and keeps the packet in the ledger. It holds the requirement and its oracle, the test cases with their checks or steps, what was observed (already redacted), the acceptance criteria, the retest command, and the regression set. It holds no credential. Give the file to the owner: `backend-engineer`, `frontend-engineer`, or the team that owns the native app.

## Retest

`retest.mjs` runs test cases by ID through the runner for each layer:

- `retest.mjs <ledger> <config> --root <repo> --defect DEF-001` runs the defect's test cases.
- `--regression` runs its regression set instead.
- `--tests TC-1,TC-2` runs the named test cases.

Each runner also takes `--only TC-1,TC-2`. An ID that is not in the plan, is out of scope, or is not implemented is an error, so a retest never runs less than it was asked to.

## Closing a defect

- **A fix is a new build.** A pass on the build where the test failed is flaky, not a fix. The ledger binds every run to the build and to the test case's definition; a run from an earlier build or an earlier definition is stale.
- **Retest Passed:** every test case of the defect passes on the current build.
- **The regression set:** every in-scope, implemented test case on the defect's journeys and on the P0 journeys.
- **Regression Passed, then Closed:** every test case in the regression set has a current result that is a pass, or a failure another open defect already covers, where that defect was found on an earlier build. A failure first seen on the fixed build is a regression: the defect stays at Retest Passed, and the new failure gets its own defect.
- **Blocked, stale or not run** in the regression set keeps the regression incomplete. The defect does not close.
- **A failing retest** after a claim sends the defect back to Handed Off. Only runs recorded after the claim count.
- **A later failure** of a closed defect's test case opens a new defect, marked as a regression of the old one.

## Flaky test cases

A test case that passed and failed on the same build, under the same definition, is `flaky` (G23). It is never `passed`, and it opens no defect in the app on its own. An open defect on that test case is marked flaky for triage. Triage decides the cause: shared data, order or timing in the test (a `test` disposition), or a race in the app (a `product` disposition).

Planted defect 11 shows this: `fixtures/planted-app/flaky-cases.json` holds a test case marked read-only that approves an order, and a second test case that expects that order to be pending. Run on a shared database without a reset, the second passes, then fails after the first. The ledger reports it as flaky.

## The gate

An open Critical or High defect keeps the gate at `FAIL` until it closes, even when its test case has not run on the current build. Any other open defect keeps the gate from `PASS`. A flaky or stale test case keeps it at `PARTIALLY TESTED`.
