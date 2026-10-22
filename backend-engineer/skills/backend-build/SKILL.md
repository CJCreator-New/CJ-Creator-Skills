---
name: backend-build
description: Build the backend a frontend application needs, from its user journeys. Reconstructs what each interaction must do, finds missing requirements and APIs early, designs contracts and schema, implements and connects the backend, and verifies complete journeys end to end with recorded evidence. Use on a repository with a frontend and an existing or partial backend.
argument-hint: '<feature, journey, or request, plus the requirement and spec paths if any>'
disable-model-invocation: true
---

# Backend build orchestrator

Request: $ARGUMENTS

You are the orchestrator. Subagents cannot spawn subagents, so you dispatch them with the Agent tool. You own the ledger. Agents return findings; you record them. An agent's claim that work is done is not evidence. Only recorded runs, current files and the release status are.

Read the reference files once, at the start of the phase that needs them, from this skill's `references/` folder:
- `flow-intelligence.md`: Phases 2 and 3. Interaction classification, the journey graph, the coverage matrix.
- `contracts-data-security.md`: Phases 4 to 6. Contracts, schema, transactions, security and integrations.
- `gaps-verification-release.md`: Phases 8 to 11. Checkpoints, the gap lifecycle, evidence, release status and the report.

In this skill, `LEDGER` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs"`. Every record, check result, review and end-of-run step goes through it.

Hard rules:
- Never record a check result by hand. `LEDGER run` executes the command and stores the result. `LEDGER review` records the reviewer's verdict.
- Never choose a business rule that the requirements do not settle. Record it as an unresolved decision that blocks the journeys it affects, and continue the work that does not depend on it.
- Never close a gap, mark a journey verified, or report a release status from an agent's claim. Use the commands, which check the evidence.
- Never write secrets, credentials or real `.env` values. Never read them either.
- Never edit a committed migration. Add a new one.
- Do not commit, push or open a PR unless the user asks.

## Modes

Pick the mode in Phase 0. It sets how much is verified, never whether the essentials run.

| Mode | When | What changes |
| --- | --- | --- |
| Fast | a small change to an existing journey, reusing the existing contract | a focused review of the flow and contract, targeted tests, the full E2E suite only when a shared module changed |
| Standard | a new feature or a new journey | the full flow analysis, contract-first implementation, unit, integration, contract and E2E tests, independent review of material changes |
| High-assurance | payments, permissions, personal data, compliance, or a shared transaction boundary | deeper threat and business-rule analysis, security review of every changed operation, concurrency and recovery tests, migration verification, and the review is required |

## Phase 0: Preflight

1. `git status --short` and `git branch --show-current`. Record existing uncommitted changes and never overwrite them. If on the default branch and the request changes code, ask which branch to use.
2. Read project instructions: root `CLAUDE.md`, `AGENTS.md`, and nested `CLAUDE.md` files in the directories the request touches.
3. `LEDGER init`. Then `LEDGER status` to confirm the ledger reads.
4. Dispatch **repo-intel** for the frontend and the backend. Record its commands, stack, and any unfinished work.
5. Probe capabilities and record each as available or unavailable. Never assume one:
   - a test database and the migration command,
   - a runnable backend and frontend (their dev commands),
   - a browser for E2E tests,
   - each external service, by name only. Record whether credentials are configured. Never read their values.
6. Choose the mode from the table above.

## Phase 1: Discover

Use repo-intel's output and the requirement documents the user supplied. Note the existing capabilities, the defects already visible, and the authorization model in use. Do not rebuild anything that repo-intel shows already works, until you know whether it can be reused.

## Phase 2: Understand user flows (Checkpoint A)

1. Dispatch **requirements-analyst** with the repository paths, the requirement documents and any design references. It is read-only and returns requirements, interactions, journeys, gaps and unresolved decisions.
2. Record its output in the ledger with `LEDGER add`:
   - each requirement with its source, priority and status,
   - each interaction, classified `local` (with a reason) or `backend` (with its journey),
   - each journey, with its requirement IDs, steps, success outcome, failure branches and the paths it depends on,
   - each gap, with its severity, category and the journey and requirement it affects,
   - each unresolved business rule as a decision, with the journeys it blocks.
3. Check the flow analysis against `flow-intelligence.md`. Every meaningful interaction is classified. Every high-priority requirement has a journey or an explicit reason.
4. Run `LEDGER validate`. Fix every error it reports.
5. Checkpoint A: if a decision blocks a critical journey, ask the user one structured question that includes what each answer would change. Continue the independent work while you wait. Do not guess.

## Phase 3: Triage and plan

1. Set each gap's severity from its actual impact and exposure, using the guidance in `gaps-verification-release.md`. Move each gap to `Triaged` with `LEDGER gap <id> Triaged`.
2. Decide which gaps you resolve autonomously. Use the criteria in `gaps-verification-release.md`. Ask about the rest.
3. Plan the work as tasks with `LEDGER add tasks '<json>'`. Each task has one owner agent, the files it owns, and its dependencies. Give each file one owner. Serialize tasks that share a file.
4. `LEDGER ownership` writes `.claude/backend-engineer/ownership.json` from the task files. The guard then denies writes outside it while it exists.

## Phase 4: Design contracts (Checkpoints B and C)

1. Dispatch **api-architect** for the operations the journeys need. It writes the contract files. Its output also goes into the flow matrix: each operation names its journey.
2. Dispatch **db-integrity** after the contract is approved. Its schema must support the contract's queries, transitions and constraints. Its migrations are new files.
3. Review each contract against its journeys. Look for a missing operation, a missing failure response, a transition with no operation, an authorization gap, or an operation with no idempotency where a repeat would cause harm. Record each as a gap.
4. Checkpoint B and C: approve the contract and schema only when the gaps are recorded and the critical ones are resolved. Dependent implementation does not start before this.

## Phase 5: Implement in parallel where safe

1. Dispatch **backend-implementer** and **integration-engineer** in one message for tasks whose files do not overlap. Give each agent only its task, its contract section, its schema section, the journeys it serves, its files and its acceptance criteria.
2. Record each handoff request as a task or a gap. Assign it to its owner. Never let two agents edit the same file.
3. Record each agent's result. A result with a blocker or a contract deviation is a gap until it is resolved.

## Phase 6: Verify components

1. Dispatch **test-engineer** to write requirement-driven tests and run the focused tests through `LEDGER run test --scope focused --journey <ids> --gap <ids> -- "<command>"`. Read the output.
2. For each changed operation that touches authentication, authorization, input, data exposure, files or integrations, dispatch **security-reviewer**. Record its findings as gaps.
3. For each migration, have **test-engineer** run it up and down against a test database, when the tooling allows. Record the result with `LEDGER run`.
4. Fix every failing test at its root cause before the next component depends on it.

## Phase 7: Integrate frontend and backend

1. Dispatch **frontend-integrator** for the interactions the ledger classifies as `backend`. Give it the contract and the interaction IDs.
2. Re-run the focused tests for each affected journey with `LEDGER run`.
3. Check the frontend against the journey's states: loading, success, empty, validation error, authorization error, service failure and recovery.

## Phase 8: End-to-end verification

1. Dispatch **e2e-verifier** with the journeys, their branches and the environment. It runs each branch through `LEDGER run e2e --scope e2e --journey <ids>`, and checks both the UI and the database.
2. For every defect found, record a gap with its reproduction steps, then move it through the lifecycle in Phase 9.
3. For every branch that could not run, record it as blocked with the reason. Never mark it verified.

## Phase 9: Remediate and revalidate

For each gap, in order, following `gaps-verification-release.md`:
1. Confirm the root cause at the earliest wrong step in the journey, not the visible symptom. Record it with `LEDGER set gaps <id> '{"rootCause": "..."}'`, then `LEDGER gap <id> "Root Cause Confirmed"`.
2. Implement the smallest fix at the right layer. Record it with `set ... '{"fix": "..."}'`, then `gap ... "Fix Implemented"`.
3. Add a regression test that would fail without the fix. Record it in `regressionTests`, and run it with `LEDGER run test --scope regression --gap <id> --journey <ids>`. Then `gap ... "Focused Tests Passed"` and `gap ... "Regression Verified"`.
4. Re-run the affected journeys with `LEDGER run e2e --scope e2e --journey <ids>`. Journeys whose files changed are stale until they run again, and the ledger shows that.
5. Close the gap with `gap <id> Closed` only after its acceptance criteria are recorded.

## Phase 10: Independent review

1. Dispatch **release-reviewer** on the final integrated state, with the ledger status, the requirements and journeys, and the changed files. It did not write the code.
2. Record its verdict with `LEDGER review <passed|findings-open|rejected> --report <path> --notes "<summary>"`. Run `LEDGER review` only after the reviewer returns; the review is recorded against the tree as it is at that time.
3. Address each blocking finding, then run the review again if the tree changed.

## Phase 11: Deliver

1. Run `LEDGER release`. Its status is computed from the evidence. Report that status, not a status you prefer.
2. Run `LEDGER finish` only when the status is Complete. It refuses otherwise, and it removes `ownership.json`. If the run stops early, run `LEDGER abort` so the guard stops blocking edits.
3. Return the final report in the format in `gaps-verification-release.md`. Include the migration, configuration and rollback notes, the decisions the user still has to make, and the verification that was not run.
