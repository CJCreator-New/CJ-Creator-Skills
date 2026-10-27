# Delivery gates reference

Loaded by `orchestrate` at Stage 6. Defines the readiness gate, the end-only testing policy, remediation, and the report.

## Readiness gate (static only)

Run with `git diff`, file reads, and greps. Do not run tests, test suites, watch modes, or preliminary test commands.

- [ ] Every implementation task is complete or explicitly blocked.
- [ ] Changes from parallel agents are reconciled. No conflict markers (`grep -rn '^<<<<<<<\|^>>>>>>>'` on changed files).
- [ ] Shared interfaces and contracts match at every call site (grep the symbol).
- [ ] Database changes and application code agree (migration, model, query).
- [ ] Authorization checks on the changed path are still present and not reordered after the data access.
- [ ] Expected files exist. Nothing unrelated is in the diff (`git diff --stat`).
- [ ] No agent is still editing.
- [ ] Environment and dependency assumptions are written in the checkpoint or report.

Fix material issues now, then rerun the affected checklist items.

## End-only testing policy

1. Identify the repo's verification commands (recorded in Stage 0).
2. Choose the smallest set that covers changed components and risk: scoped test files or package filters first.
3. Run it. Capture failing output with grep or tail: test name, message, `file:line`.
4. Record every check and its status.
5. Build the remediation queue.

Full-suite runs are an exception. Allowed only when the user asks, a release or compliance rule requires it, a material risk needs broader coverage, or the scoped run was insufficient. Explain the reason and ask first.

Never claim the application is regression-free unless the full suite ran and passed.

## Failure classification

For each failure, decide with evidence:

- Production defect
- Incorrect test expectation (the test is wrong about the specified behavior)
- Interface or contract mismatch
- Environment or dependency problem
- Pre-existing failure (reproduce on the base branch by reading the code path, or by a check the user approved)
- Regression caused by a remediation
- Unrelated failure

Do not assume the current change caused every failure.

## Grouping and remediation

- Group failures that share a cause. Several API tests failing from one response shape is one defect: fix the shape.
- Fix the underlying defect. Do not weaken assertions, skip tests, or delete them.
- An incorrect test expectation may be corrected only if the spec says the test is wrong. Say so in the report.
- Independent groups go to separate `failure-remediator` agents in one message. Each owns its files.
- After each fix, rerun the failing test or smallest affected group only.
- Add related failures to the queue if the output shows a shared regression.
- Two failed attempts on the same cause: stop and report the blocker with the diagnosis you ruled out.

## Verification statuses

- Passed: executed and passed
- Failed: executed and failed
- Not run: not executed
- Blocked: could not execute (environment, permission, infrastructure)
- Existing failure: evidence it predates the change
- Unresolved: still failing after remediation

## Delivery status

Choose exactly one:

- Verified: required checks passed within the declared scope
- Partially verified: implementation complete, some checks not run or blocked
- Incomplete: material work or remediation unresolved
- Blocked: a dependency, permission, or external condition prevents completion

## Completion report template

```
Task: <original request or ticket id>
Interpretation: <2-3 lines; explicit vs inferred noted>
Acceptance criteria: <addressed / not addressed, one line each>

Repository research
- Components: <paths>
- Dependencies and decisions: <short list>

Implementation
- Changed: <files, grouped by owner>
- Interfaces affected: <contracts changed>
- Design decisions: <short list>

Parallel execution
- Agents: <roles and count>
- Conflicts and resolution: <or "none">

Final verification
- Commands run: <exact commands>
- Results: <status per check>
- Failures and root causes: <grouped>
- Remediation: <what changed, what reran>
- Not run: <checks and why>; full suite run: yes/no

Delivery status: <Verified | Partially verified | Incomplete | Blocked>
Remaining blockers and risks: <list>
External actions: none unless listed here with confirmation
```
