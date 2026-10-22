# Gaps, verification and release

## Checkpoints

Gaps are looked for throughout the work, not only at the end.

**A. Requirements and journeys, before implementation.** Ambiguous or contradictory rules, missing roles, incomplete journeys, unspecified outcomes, missing acceptance criteria, unclear data ownership, controls with no defined behaviour, and requirements that cannot be verified. Critical journeys and material rules must be defined before dependent work starts.

**B. Contracts, before parallel implementation.** Missing operations, incompatible shapes, missing validation, unclear errors, missing pagination, filtering or sorting, missing authorization, unspecified transitions, conflicting responsibilities, and missing idempotency for sensitive operations.

**C. Schema, before migrations.** Missing entities or relationships, wrong cardinality, missing uniqueness or referential constraints, duplicate sources of truth, unsafe nullability, missing indexes, transaction and concurrency risks, retention and audit gaps, and migration rollback risks.

**D. Parallel development.** Conflicting edits to one file, two versions of one contract, duplicated business logic, missing dependencies, inconsistent validation or authorization, uncoordinated schema changes, and assumptions treated as facts.

**E. Frontend and backend integration.** Wrong paths or methods, request and response mismatches, authentication problems, missing loading and error states, wrong persistence, stale data, broken navigation after a mutation, duplicate requests, lost validation messages, and mishandled timeouts.

**F. End-to-end and release.** Broken critical journeys, unreachable states, missing permission checks, wrong business outcomes, data leaking across users or tenants, duplicate side effects, race conditions, regressions from fixes, unresolved high-severity findings, and claims with no evidence.

Do not recommend release while a mandatory checkpoint is unsatisfied.

## Severity

- **Critical**: data compromise, unauthorized access to sensitive data, severe data corruption, an unsafe financial or regulated operation, or a blocker in a critical workflow.
- **High**: a major workflow failure, a serious authorization or integrity weakness, or a material feature that cannot work.
- **Medium**: limited functionality or reliability with a reasonable workaround.
- **Low**: a minor defect, a documentation issue, or a non-critical improvement.

Severity reflects impact and exposure. It does not reflect how many lines the fix changes.

## Autonomous remediation

Fix a gap without asking when all of these hold: the intended behaviour is supported by the requirements or the project's conventions, the root cause is understood, the fix is within the assigned scope, the change can be tested safely, and no business decision or destructive action is needed.

Ask when a business rule is unresolved, or when the decision changes security, money, compliance or the business outcome. While waiting, record the blocked tasks and continue the rest.

## Gap lifecycle

`Detected → Triaged → Assigned → Root Cause Confirmed → Fix Implemented → Focused Tests Passed → Regression Verified → Closed`

The ledger moves a gap one step at a time, and each step needs what the previous steps produced:

| Step | Needs |
| --- | --- |
| Triaged | title, severity, category |
| Assigned | owner |
| Root Cause Confirmed | rootCause |
| Fix Implemented | fix |
| Focused Tests Passed | a current passing run linked to the gap |
| Regression Verified | regressionTests, and a current passing run with scope `regression` linked to the gap |
| Closed | acceptance criteria |

A gap is never closed because code changed. Its acceptance criteria and its verification must pass.

## Root cause

1. Reproduce the issue, or establish reliable evidence of it.
2. Find the earliest step in the journey that is wrong, missing or contradictory.
3. Trace it through the requirement, the frontend, the contract, authorization, the domain logic, persistence and the integration.
4. Confirm the cause rather than the symptom.
5. Fix it at the right layer, with the smallest coherent change.
6. Add a regression test that fails without the fix.
7. Run the focused tests, then the affected journeys, then check for regressions.
8. Update the ledger.

Never hide an error to make a test pass. Never weaken validation or permissions to get past a blocker. Never add a second source of truth. Never replace real behaviour with a mock and call it complete.

## Evidence states

Each journey is in one state, computed by the ledger:

- **verified**: the latest current run linked to it passed.
- **failed**: the latest current run linked to it failed.
- **stale**: runs exist, but the files the journey depends on have changed since they ran.
- **blocked**: an open decision blocks the journey.
- **implemented**: the journey is marked implemented but has no run.
- **planned**: neither.

A run is current when the files it depends on still match their fingerprint from when it ran. Without git, nothing is current, and the ledger says so by reporting the journeys as stale.

Report each state separately. Do not report "passing" for a stale journey.

## Release status

`LEDGER release` computes the status:

- **Blocked** when an open decision blocks a journey.
- **Not Release Ready** when any of these hold: an open Critical or High gap, a high-priority journey that is not verified, a failed journey, a high-priority requirement with no journey or marked not implemented, no current passing full suite run, a failing current regression or end-to-end run, or no current passing independent review. It also applies when the ledger has no requirements or no journeys.
- **Partially Complete** when only lower-priority items remain open.
- **Complete** when none of the above applies.

The status is what the evidence supports. A reviewer or user may disagree, and then the disagreement is recorded as a decision, not as a changed status.

## Ledger review

`LEDGER review` records the reviewer's verdict against the tree as it is at that time. The review is current only while the tree is unchanged. A change after the review makes it stale, and release then requires a new review.

## Final report

Keep it short and evidence-based.

```
A. Execution summary
   Scope, mode, what was implemented, overall status (from LEDGER release).

B. User-flow coverage
   Interactions: <total>; classified backend <n>; classified local <n>; unclassified <n>
   Journeys: identified <n>; implemented <n>; verified <n>; failed <n>; blocked <n>; stale <n>
   Requirements: traced to a verified journey <n>; explicitly not implemented <n> (with reasons)

C. Implementation
   APIs and operations added or changed.
   Migrations (in order), with the rollback step for each.
   Business rules enforced, and where.
   Security and integration changes.
   Frontend connections made.

D. Gaps
   Detected <n>; closed <n>; open by severity: Critical <n>, High <n>, Medium <n>, Low <n>.
   Each open Critical or High gap, with its status and what closes it.
   Decisions the user must make.

E. Verification evidence
   Each recorded run: command, scope, result ID, exit code.
   Tests not run, and why.
   Environment limitations, including live integrations that were not exercised.

F. Release readiness
   Status from LEDGER release, with the blockers, not-ready items and partial items it lists.
   Residual risks.
   Migration and deployment notes.

G. Next steps
   Only actions the ledger and the evidence support.
```
