---
name: frontend-build
description: Build, modify, fix or verify a frontend page, component or interaction in an existing repository. Classifies the task, runs only the agents it needs, implements in parallel with file ownership, tests, checks the rendered page against the design reference, and reports evidence-based status.
argument-hint: '<request, design reference (Figma link, screenshot path or URL), or route>'
disable-model-invocation: true
---

# Frontend build orchestrator

Request: $ARGUMENTS

You are the orchestrator. Subagents cannot spawn subagents, so you dispatch them with the Agent tool. Keep your own context on decisions, contracts and status. Delegate reading.

Read the reference files once, at the start of the stage that needs them, from this skill's `references/` folder:
- `classification-and-routing.md`: Stage 1, agent selection, model routing.
- `design-and-contracts.md`: Stages 2 and 3, design spec, traceability matrix, contracts, file ownership.
- `testing-and-visual-qa.md`: Stages 5 to 7, test layers, browser checks, defect triage.
- `gates-and-reporting.md`: quality gates, completion states, telemetry, final report.

Hard rules:
- Never report work as verified unless you ran the check and read its actual output.
- Never bypass a quality gate to meet a speed target. A failed gate returns work to the stage that owns it.
- Token savings come from less rework, less repeated reading and fewer duplicate agents. Never from skipping a check.
- Do not commit, push or open a PR unless the user asks.

## Stage 0: Preflight

1. Run `git status --short` and `git branch --show-current`. Record existing uncommitted changes. Never overwrite or discard them. If the branch is the default branch and the request changes code, ask which branch to use.
2. Read project instructions once: root `CLAUDE.md`, `AGENTS.md` if present, and any nested `CLAUDE.md` in directories the task touches.
3. Read `.claude/frontend-engineer/config.json` if it exists (shape in `examples/config.example.json` in this plugin). If it does not exist, detect the framework and the `test`, `lint`, `typecheck`, `format` and `build` scripts from `package.json`. Record the commands. Do not run them yet.
4. Probe capabilities and record each as available or unavailable. Never assume one:
   - Design reference: a screenshot file, a URL, or a Figma link that a connected Figma tool can read. A bare Figma link without a connected tool is unavailable.
   - Browser: run `npx playwright --version` (or the configured browser command). Chromium is often preinstalled; check before relying on it.
   - Ticket or API connectors: only if connected in this session.
5. Create `.claude/frontend-engineer/checkpoint.md` with the request, the capability results, the commands, and the status of each stage.
6. Start telemetry: `node "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs" start preflight`, then `end preflight` when the stage finishes. Use the same pattern for every stage.

Gate 1 (ready to implement) is checked at the end of Stage 3, not here.

## Stage 1: Classify and choose the mode

Classify the task type, its risk, and its affected routes and components. Pick the smallest mode that safely achieves the request:

| Mode        | When                                                                                              | Agents                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| quick       | one component or a copy or style fix, 1 to 2 files, no new state or API calls                     | you, or one implementer. visual-qa only if a design reference exists                          |
| standard    | a new component or section in an existing area, some tests                                        | design-analyst and repo-intel in parallel, 1 to 3 implementers, test-author, visual-qa        |
| full        | a new page or flow, API, state, routing or auth changes, responsive redesign, or a shared component | everything in standard, plus code-reviewer on opus                                        |
| visual-fix  | the page exists and its render differs from the reference                                         | visual-qa, then one implementer per root-cause group                                          |
| review-only | the user asked for findings, not changes                                                          | repo-intel and code-reviewer. No edits                                                        |

Use the routing rules in `classification-and-routing.md`. Do not ask the user for anything the repository or the design reference can answer. Ask one focused question only when an unresolved decision changes the result.

## Stage 2: Analysis in parallel

Dispatch these in one message, only the ones the mode needs:

- **design-analyst** (when a design reference exists): returns a structured design spec, with explicit requirements separated from inferred ones.
- **repo-intel**: returns a task-relevant index of files, components, tokens, API clients, test utilities and commands. Reuse `.claude/frontend-engineer/cache/repo-index.json` when it exists and `git diff --name-only <indexed-sha> -- <relevant paths>` is empty. Otherwise refresh it and record the new SHA.

Store both outputs in the checkpoint. Other stages read the checkpoint, not the agents' full transcripts.

## Stage 3: Specification, plan and contracts

1. Build the requirement-to-code traceability matrix (format in `design-and-contracts.md`). Every requirement maps to a component, file, behavior, test and verification status.
2. Define the contracts before parallel coding: props or component API, shared types, API response shapes, routes, design token names, and error conventions. Write them in the checkpoint.
3. Split the work into work packages with one owner per file. Shared files (routes, global styles, shared types, barrel exports) have one owner, or are edited only in Stage 5. Order dependencies so that the page shell comes before the components that depend on its layout.
4. Write `.claude/frontend-engineer/ownership.json` as `{"owned": ["src/components/Foo/", "src/pages/foo.tsx", ...]}`. It lists every path this run may write. The `guard-file-ownership` hook denies writes outside it while the file exists. Delete the file at the end of the run (Stage 9).
5. Check Gate 1: scope understood, relevant repository inspected, design requirements documented, dependencies identified, plan defined. If a gate item is missing, return to the stage that produces it.

## Stage 4: Implement

Dispatch **implementer** agents in one message for work packages whose owned files do not overlap. Serialize packages that share a file. Give each agent only:
- its objective and acceptance criteria,
- the contracts it must follow,
- its owned files and the files it may read,
- the reference or design-spec sections it needs.

Do not paste the whole spec into every agent. Implementers do not run tests. Each returns the handoff shape in its agent file. Read each returned handoff, and resolve any handoff request for another owner by assigning it, not by letting the agent edit the file.

## Stage 5: Integrate and run focused checks

1. Read `git diff --stat`, then the diff of each owned file. Compare it with the contracts. Fix mismatches now, not after everything has finished.
2. Run the configured format check, lint and typecheck. Run the build when the change affects bundling, routing or imports.
3. Check Gate 2 (ready to integrate) and Gate 3 (ready for QA): components integrated, interactions implemented, static checks run, runtime issues addressed.

## Stage 6: Automated tests

1. Dispatch **test-author** to write requirement-driven tests for the matrix rows. It uses the project's existing test utilities and layers (see `testing-and-visual-qa.md`). It does not write tests that only restate the implementation.
2. Run the focused tests for the changed areas. Record the exact command and the actual result.
3. For a failing test, decide whether it is a regression or pre-existing. To check, run the same test in a temporary worktree at the base commit: `git worktree add <scratch-dir> <base-sha>`. Do not stash or reset the user's working tree.

## Stage 7: Browser and visual QA loop

Skip this stage only when no browser is available. In that case the report says visual verification was not performed.

1. Start the app with the configured dev command and wait for the configured URL.
2. Dispatch **visual-qa** for the route at each configured viewport. It captures screenshots, measures key DOM geometry, compares them with the reference, and returns triaged defects with evidence paths.
3. Triage defects by severity (critical, high, medium, low), in the order given in `testing-and-visual-qa.md`. Group them by root cause.
4. Dispatch one implementer per root-cause group. Then rerun the focused tests for the affected components.
5. Dispatch visual-qa again. Repeat until the acceptance criteria are met or `maxVisualIterations` (default 3) is reached. Record each iteration with `node "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs" iteration`.
6. If the limit is reached, list the unresolved defects with their evidence and ask the user for a decision.

## Stage 8: Independent review

Dispatch **code-reviewer** with the requirement matrix, the final diff list and the test results. It does not receive the implementers' reasoning. In standard mode it reviews the diff against the matrix. In full mode it also checks architecture, accessibility, security and performance. It rejects any completion claim that the evidence does not support.

Address every blocking finding and rerun the affected checks.

## Stage 9: Regression, final review and report

1. Run the full configured test suite and the build. Record the actual output. Distinguish pre-existing failures from regressions, as in Stage 6.
2. Review the final `git diff` for unintended changes and unrelated formatting. Revert only changes this run made, and only after confirming them.
3. Delete `.claude/frontend-engineer/ownership.json`, so the guard stops blocking edits.
4. Check Gate 4 (ready for final review) and Gate 5 (ready for user approval) as defined in `gates-and-reporting.md`.
5. Print the telemetry summary with `node "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs" summary`.
6. Return the final report in the format in `gates-and-reporting.md`. Keep it short and evidence-based. Name the files changed. Do not repeat the repository layout.
