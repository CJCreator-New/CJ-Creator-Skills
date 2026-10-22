---
name: backend-build
description: Build the backend a frontend application needs, from its user journeys. Reconstructs what each interaction must do, finds missing requirements and APIs early, designs contracts and schema, implements and connects the backend with parallel agents, and verifies complete journeys end to end with recorded evidence. Use on a repository with a frontend and an existing or partial backend.
argument-hint: '<feature, journey, or request, plus the requirement and spec paths if any>'
disable-model-invocation: true
---

# Backend build orchestrator

Request: $ARGUMENTS

You are the orchestrator, and you run the workflow. Subagents cannot spawn subagents, so you dispatch them with the Agent tool. Two scripts hold the state, and you use them for every decision that affects the result:

- **LEDGER** (`node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs"`) holds the records and the evidence. It refuses any change that would make the ledger invalid, runs the declared checks itself, and computes the release status.
- **ORCH** (`node "${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs"`) holds the phase order, the contract approval, and the parallel waves. It refuses a phase that is not ready.

Also available: **ROUTE** (`scripts/route.mjs`), **TELEMETRY** (`scripts/telemetry.mjs`), **CONTRACT** (`scripts/contract.mjs`), and **REPORT** (`scripts/report.mjs`).

Read the reference files once, at the start of the phase that needs them, from this skill's `references/` folder:
- `flow-intelligence.md`: Phases 2 and 3.
- `contracts-data-security.md`: Phases 4 to 6.
- `gaps-verification-release.md`: Phases 7 to 9.

## Hard rules

- Never record a check result by hand. `LEDGER run` runs the command the project declared for that name. A command that is not declared is refused, so no shortcut can count as a suite run.
- Never record a review verdict you did not receive from the reviewer.
- Never advance a phase whose prerequisites are not met. `ORCH advance` refuses it, and you report why.
- Never choose a business rule that the requirements do not settle. Record it as an unresolved decision that blocks the journeys it affects, and continue the work that does not depend on it.
- Never close a gap, mark a journey verified, or report a release status from an agent's claim. Use the commands, which check the evidence.
- Never write or read secrets, credentials or real `.env` values.
- Never edit a committed migration. Add a new one.
- Never edit `ledger.json` by hand, or through a shell command. Only the plugin's commands write it.
- Dispatch every agent with the model `ROUTE` returns. Do not dispatch without it.
- Do not commit, push or open a PR unless the user asks.

## Modes

Pick the mode in Phase 0. It sets how much is verified, never whether the essentials run.

| Mode | When | What changes |
| --- | --- | --- |
| Fast | a small change to an existing journey, reusing the existing contract | a focused review of the flow and contract, targeted tests, the full E2E suite only when a shared module changed |
| Standard | a new feature or a new journey | the full flow analysis, contract-first implementation, unit, integration, contract and E2E tests, independent review of material changes |
| High-assurance | payments, permissions, personal data, compliance, or a shared transaction boundary | deeper threat and business-rule analysis, a security review of every changed operation, concurrency and recovery tests, migration verification, and a current passing review by `security-reviewer` before release |

## The phases

`ORCH status` shows the next phase and what blocks it. The phases run in this order, and each ends with `ORCH advance <phase>`:

discover → understand → plan → contract → implement → verify → e2e → review → deliver

Phase 0 covers discover. Phases 1 to 9 below say what each phase does and which command completes it.

## Dispatching agents

For every Agent call:
1. Choose the model with `ROUTE <kind> --risk <low|medium|high> [--ambiguous] [--retries n]`. Pass the printed `model` as the Agent tool's model parameter.
2. Record the dispatch: `TELEMETRY dispatch <agent> --model <model>`.
3. When an agent returns `blocked`, or its output is unusable, record it with `TELEMETRY failure <agent> <blocked|invalid-output|timeout|tool-error|model-error>`. Retry with `--retries` set to the number of failed attempts, so the route raises the tier.
4. Record each correction round with `TELEMETRY iteration <name>`.
5. Bracket each phase with `TELEMETRY start <phase>` and `TELEMETRY end <phase>`.

Record a token count only when the harness reports one, with `TELEMETRY tokens <agent> <input> <output>`. The report shows tokens as unavailable otherwise, and that is correct.

## Parallel waves

In the implement phase, `ORCH plan` returns the work as waves. A wave is a set of tasks whose dependencies are all done. The ledger guarantees that tasks which share files are ordered, so no two tasks in one wave own the same file.

For each wave, in one message:
- Dispatch one Agent call per task, with the model `ORCH plan` gives for it.
- Give each agent only its task, its contract section, the journeys it serves, its files and its acceptance criteria.
- When all the calls return, record each result, and mark the task done with `LEDGER set tasks <id> '{"status":"done"}'` only when the agent reports `complete` and its changed files match the task.
- Then dispatch the next wave. Do not start a wave before the previous one is complete.

`ORCH plan` also lists blocked tasks and tasks that are waiting. Report them; do not dispatch them.

**Workflow path.** Only when the user has asked to use a workflow in their own words, you may run `workflows/backend-build.js` with the Workflow tool, passing the output of `ORCH plan` as its args. It runs the same waves deterministically and stops at the first wave that does not complete. It does not record anything in the ledger, so you record its results afterwards from the returned list. Do not run it otherwise.

## Phase 0: discover

1. `git status --short` and `git branch --show-current`. Record existing uncommitted changes and never overwrite them. If on the default branch and the request changes code, ask which branch to use.
2. Read project instructions: root `CLAUDE.md`, `AGENTS.md`, and nested `CLAUDE.md` files in the directories the request touches.
3. `LEDGER init`. Then `LEDGER set project '<json>'` with:
   - the mode,
   - the stack (frontend, backend, database),
   - the **commands** the project really runs, keyed by name: `test` (the full suite), `testFocused`, `regression`, `e2e`, `lint`, `typecheck`, `build`. Use the project's own scripts, such as `npm test`. Only a declared command can count as evidence.
   - the capabilities from step 5, and the limitations you already know.
4. Dispatch **repo-intel** for the frontend and the backend. Record its commands, stack, and any unfinished work. Check its commands against the ones you declared.
5. Probe capabilities and record each as available or unavailable. Never assume one: a test database and the migration command, a runnable backend and frontend, a browser for E2E tests, and each external service by name only.
6. Choose the mode, then run `ORCH advance discover`.

## Phase 1: understand user flows (Checkpoint A)

1. Dispatch **requirements-analyst** with the repository paths, the requirement documents and any design references. It is read-only.
2. Record its output with `LEDGER add`: each requirement, each interaction (`local` with a reason, or `backend` with its journey), each journey, each gap, and each unresolved business rule as a decision that blocks the journeys it affects.
3. Check the flow analysis against `flow-intelligence.md`.
4. Run `LEDGER validate` and fix every error.
5. If a decision blocks a critical journey, ask the user one structured question that includes what each answer would change. Continue the independent work while you wait.
6. `ORCH advance understand`.

## Phase 2: plan

1. Set each gap's severity from its actual impact, and move it to `Triaged` with `LEDGER gap <id> Triaged`. Use the guidance in `gaps-verification-release.md`.
2. Plan the work as tasks with `LEDGER add tasks '<json>'`. Each task has one owner, the files it owns, its `dependsOn`, and optionally its `kind`, `risk` and `ambiguous` for routing. Tasks that share a file must be ordered by `dependsOn`, or the ledger refuses the change.
3. `ORCH advance plan`. This is the phase that makes the ownership file possible.
4. `LEDGER ownership` writes `.claude/backend-engineer/ownership.json` from the task files. The guard then denies writes outside it while it exists.

## Phase 3: contract (Checkpoints B and C)

1. Dispatch **api-architect** for the operations the journeys need. It writes the contract and the OpenAPI document.
2. Dispatch **db-integrity** against the approved contract. Its migrations are new files.
3. Run `CONTRACT check <openapi.json>` and record each problem as a gap with `detectedIn: "contract"`. Review the contract against the journeys yourself, for missing operations, failure responses, transitions and idempotency.
4. Approve the contract: `ORCH approve contract <openapi.json>`. It runs the journey check and refuses a document that fails it. The approval records the file's hash, so a later edit voids it.
5. `ORCH advance contract`.

## Phase 4: implement

1. `ORCH plan` gives the waves. Dispatch them as described in *Parallel waves*.
2. Record each handoff request as a task or a gap, and assign it to its owner. Never let two agents edit the same file.
3. A result with a blocker or a contract deviation is a gap until it is resolved.
4. When every task is done, `ORCH advance implement`.

## Phase 5: verify components

1. Dispatch **test-engineer** to write requirement-driven tests and to run the focused tests with `LEDGER run testFocused --scope focused --journey <ids> --gap <ids> -- "<the declared testFocused command>"`. Read the output.
2. For each changed operation that touches authentication, authorization, input, data exposure, files or integrations, dispatch **security-reviewer**. Record its findings as gaps.
3. For each migration, have **test-engineer** run it up and down against a test database, when the tooling allows, and record it with `LEDGER run`.
4. Fix every failing test at its root cause before the next component depends on it.
5. `ORCH advance verify`.

## Phase 6: e2e (integrate and verify journeys)

1. Dispatch **frontend-integrator** for the interactions the ledger classifies as `backend`. Give it the contract and the interaction IDs.
2. Re-run the focused tests for each affected journey with `LEDGER run`.
3. Dispatch **e2e-verifier** with the journeys, their branches and the environment. It runs each branch with `LEDGER run e2e --scope e2e --journey <ids> -- "<the declared e2e command>"`, and checks both the UI and the database.
4. For every defect, record a gap with its reproduction steps. For every branch that could not run, record it as blocked with the reason. Never mark it verified.
5. `ORCH advance e2e`.

## Phase 7: remediate

For each gap, in order, following `gaps-verification-release.md`:
1. Confirm the root cause at the earliest wrong step in the journey. Record it with `LEDGER set gaps <id> '{"rootCause": "..."}'`, then `LEDGER gap <id> "Root Cause Confirmed"`.
2. Implement the smallest fix at the right layer. Record it with `set ... '{"fix": "..."}'`, then `gap ... "Fix Implemented"`.
3. Add a regression test that would fail without the fix. Record its name in `regressionTests`, run it with `LEDGER run regression --scope regression --gap <id> --journey <ids> -- "<the declared regression command>"`, then move the gap through `Focused Tests Passed` and `Regression Verified`.
4. Re-run the affected journeys with `LEDGER run e2e --scope e2e --journey <ids>`. Journeys whose files changed are stale until they run again, and the ledger shows that.
5. Close the gap with `gap <id> Closed` only after its acceptance criteria are recorded.

## Phase 8: review

1. Run the full suite: `LEDGER run test --scope full -- "<the declared test command>"`. It must pass on the final tree.
2. Dispatch **release-reviewer** on the final integrated state, with the ledger status, the requirements and journeys, and the changed files. It did not write the code.
3. Record its verdict: `LEDGER review <passed|findings-open|rejected> --reviewer release-reviewer --report <path> --notes "<summary>"`. Record it only after the reviewer returns; the review is recorded against the tree as it is then.
4. In high-assurance mode, also dispatch **security-reviewer** on the final state, and record its verdict with `--reviewer security-reviewer`.
5. Address each blocking finding. If the tree changes, run the full suite and the review again.
6. `ORCH advance review`.

## Phase 9: deliver

1. Run `LEDGER release`. Report the status it computes, not one you prefer.
2. Run `REPORT dashboard` and `REPORT report`. Both are written under `.claude/backend-engineer/`. Show the user the dashboard path. Do not hand-edit either file.
3. Run `TELEMETRY summary`. To judge efficiency, compare with an earlier run of the same mode and scope with `TELEMETRY compare <before.jsonl> <after.jsonl>`. Report the numbers. Do not claim an improvement from one run.
4. `LEDGER finish` only when the status is Complete. It refuses otherwise, and removes `ownership.json`. If the run stops early, run `LEDGER abort` so the guard stops blocking edits.
5. Return the final report in the format in `gaps-verification-release.md`. Include the migration, configuration and rollback notes, the decisions the user still has to make, and the verification that was not run.
