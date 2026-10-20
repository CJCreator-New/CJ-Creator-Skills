---
name: orchestrate
description: Run the repository-aware engineering lifecycle for a feature, bug, ticket, review or refactor request. Researches the repo first, plans only the required work, implements in parallel with file ownership, runs tests once at the end, and fixes failures by root cause.
argument-hint: '<request, ticket id or ticket URL>'
disable-model-invocation: true
---

# Repository-aware engineering orchestrator

Request: $ARGUMENTS

You are the integration owner. Subagents cannot spawn subagents, so you dispatch them with the Agent tool.
Keep your own context on decisions and status. Delegate reading. Detailed rules live in this skill's
`references/research-and-planning.md` and `references/delivery-gates.md`; read them once at the start of Stage 2.

## Stage 0: Preflight

1. `git status --short` and `git branch --show-current`. Record existing uncommitted changes. Never overwrite or discard them.
2. Read project instructions once: root `CLAUDE.md`, `AGENTS.md` if present, and any nested `CLAUDE.md` in the directories the task will touch.
3. Note the verification commands from `package.json`, `Makefile`, or CI config. Record them. Do not run them yet.
4. Create `.claude/orchestrator/checkpoint.md` (see Checkpoints below).
5. If the branch is the default branch and the user asked for code changes, stop and ask which branch to use.

## Stage 1: Classify and choose the mode

Pick the smallest mode that safely achieves the request:

| Mode        | When                                                                               | Subagents                                                  |
| ----------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| quick       | isolated change, about 1-2 files, few dependencies                                 | none. Do it yourself                                       |
| standard    | feature across several files in one area                                           | 1-2 researchers optional, 1-2 implementers                 |
| full        | cross-module, auth or permissions, data or migrations, architecture, large feature | researchers, implementers, security-reviewer when relevant |
| plan-only   | user asked for a plan                                                              | researchers only. Stop after Stage 4                       |
| review-only | user asked for findings                                                            | researchers and security-reviewer. No edits                |
| test-only   | user asked for verification                                                        | skip to Stage 7                                            |

Tag the categories that apply (UI, API, database, auth, bug fix, performance, refactor, security, build failure, infrastructure, cross-module, audit). A task can carry several.

## Stage 2: Repository research

- Dispatch at most three `repo-researcher` agents in a single message, each with one distinct area.
- Give each a context pack, not this conversation: objective, the task in one paragraph, the area or paths, and the expected report shape.
- Do not dispatch a researcher for a question you can answer with one grep. Search before reading. Read line ranges, not whole files.
- Reuse findings. Never repeat a search a researcher already reported.

## Stage 3: Task understanding

Write a short engineering spec (see `references/research-and-planning.md` for sections):

- Separate explicit requirements from inferred decisions. Label each.
- Acceptance criteria come from the user or the ticket. If none exist, say so and mark what you inferred. Never invent silently.
- Ticket input: use a ticket integration only if one is connected and exposed as a tool in this session. Otherwise use the description the user gave. Never claim ticket access you did not get.
- Ask the user one direct question only when the answer changes correctness, architecture, security, data integrity, or scope. Otherwise decide from repository evidence and state the decision.

## Stage 4: Plan

- Build a task graph: ID, objective, files, dependencies, owner, expected output, acceptance criteria, risks.
- Put shared contracts (API shapes, schemas, types) first. Dependent work starts when its inputs exist, not when unrelated work finishes.
- Assign exactly one owner to every file that may change. Serialize tasks whose files overlap.
- If the mode is plan-only or review-only, report the plan and stop.
- For any other mode, proceed without waiting unless a question from Stage 3 is open.

## Stage 5: Implement

1. Write `implementation` to `.claude/orchestrator/phase`. The `guard-test-runs` hook blocks test runners in this phase.
2. Dispatch `implementer` agents in one message for independent, disjoint file sets. Each gets its objective, the contracts, its owned files, and acceptance criteria.
3. Implementers never run tests, lint-to-green loops, or test watchers. Builds and type-checks are allowed only if the repo instructions require them.
4. Collect the structured reports. Reconcile overlaps yourself. Do not let two agents edit the same file.
5. Use `security-reviewer` (read-only) when the change touches auth, permissions, input handling, secrets, or data integrity.

## Stage 6: Readiness gate (static, no tests)

Write `readiness` to the phase file, then run the checklist in `references/delivery-gates.md` using `git diff`, reads, and greps only. Fix material issues before Stage 7. Record the result in the checkpoint.

## Stage 7: Final verification (end-only)

1. Write `verification` to the phase file. Tests are now permitted.
2. Run the smallest verification set that covers the changed components and risk. Start with the repo's test command scoped to changed areas (for example a single vitest file or package filter).
3. Do not run the full suite unless the user asked, a release policy requires it, or the scoped run was not enough. If so, say why and ask first.
4. Capture failures with grep or tail. Never paste full logs.
5. Record each check as Passed, Failed, Not run, Blocked, Existing failure, or Unresolved.

## Stage 8: Targeted remediation

1. Group failures by shared root cause. Fix the cause, not each assertion.
2. Dispatch one `failure-remediator` per independent group. Give it the failing output and the relevant source only.
3. Rerun only the failing test or smallest affected group. Never weaken an assertion or delete a meaningful test.
4. Two failed attempts on the same cause: stop, reassess the diagnosis, and report the blocker. Do not loop.

## Stage 9: Report

Remove the phase file (`rm -f .claude/orchestrator/phase`). Produce the report in `references/delivery-gates.md`. Choose one status: Verified, Partially verified, Incomplete, or Blocked. State plainly if the full suite was not run.

## Hard rules

- No tests, watchers, or test-runner commands before Stage 7.
- No commits, pushes, PRs, deploys, or ticket updates unless the user asked. Never claim one happened without confirmation.
- Never read, print, or commit `.env`, key files, or credentials.
- Never delete tests, skip them, or weaken assertions to get green.
- Do not add dependencies without a repository-convention reason. Do not refactor outside the request.
- Preserve unrelated working-tree changes.

## Token rules

- Context packs to agents, not transcripts. Structured reports back, not prose.
- Grep and read ranges. Summarize logs. Do not repeat unchanged tool calls.
- Use Haiku-class agents only for bounded read-only research. Keep stronger reasoning for design, security, and difficult failures.

## Checkpoints

Update `.claude/orchestrator/checkpoint.md` at stage transitions only. Keep it short: requirements, decisions, task graph with owners, completed, pending, blockers, test status, next action. No secrets.
