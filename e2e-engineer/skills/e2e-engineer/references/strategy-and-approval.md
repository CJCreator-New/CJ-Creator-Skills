# Strategy and approval

The plan is what the user approves before any test runs. It is frozen, so a later change is visible, and the approval belongs to the frozen version.

## Freeze

`ledger.mjs freeze` runs the plan check and refuses a plan with errors. A frozen plan records:

- the digest: a SHA-256 over every plan item, with the keys and the items in a fixed order, so the digest does not depend on how the items were written,
- when it was frozen,
- the number of warnings and gaps, and the coverage measures at that time.

## Approve

`ledger.mjs approve --approver <name or identifier>` records the approval against the frozen digest. Only the user approves. The skill does not approve its own plan, and it does not approve on the user's behalf. The skill runs the command only after the user has approved the plan in this session.

Approval refuses a plan that changed after it was frozen, so the frozen version is the one approved.

## Staleness

`status` compares the approval's digest with the current plan's digest. A change to any item, even a single test case's expected result, changes the digest. The approval then no longer counts, and the gate status is `BLOCKED` with the reason "the plan changed after it was approved". The fix is to freeze and approve the new version. This is how the plan hash changes when the plan changes.

## What the user is asked to approve

The executive summary (file 00) lists, in one place:

- the requirements with an unconfirmed derived or observed oracle, which the user must confirm or change,
- the gaps, which the user can accept or ask the analysts to close,
- the targets and their readiness, including any blocked target,
- the security probe decision (allowed, or refused with its reason).

The approval is not a sign-off that the application works. It approves the test plan: what will be tested, against what oracles, on which targets.
