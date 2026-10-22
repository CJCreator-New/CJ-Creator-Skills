# frontend-engineer

A Claude Code plugin for frontend work in an existing repository: build a page, component or interaction; turn a design reference into code; fix a visual or functional defect; or refactor for accessibility and performance. It classifies the task, runs only the agents the task needs, implements in parallel with file ownership, writes and runs tests, checks the running page against the design reference, and reports status with evidence.

Quality gates are not optional. Token savings come from better planning, selective context and fewer duplicate agents. They never come from skipping a check.

## Install

Installed with the rest of this repo by the root installer. To install only this plugin:

```
/plugin marketplace add CJCreator-New/CJ-Creator-Skills
/plugin install frontend-engineer@forge-marketplace
```

For local development, load the folder from a checkout:

```
claude --plugin-dir ./frontend-engineer
```

## Use

The skill is invoked explicitly, because a full run dispatches several agents:

```
/frontend-engineer:frontend-build Build the dashboard page from docs/design/dashboard.png
/frontend-engineer:frontend-build Add a status filter to the orders table, match the existing filter bar
/frontend-engineer:frontend-build Fix the header overflow on mobile (visual-fix, reference: docs/design/header.png)
/frontend-engineer:frontend-build Review the checkout form for accessibility (review only)
```

Optional project settings go in `.claude/frontend-engineer/config.json`. Start from `examples/config.example.json`: dev server command and URL, the project's check commands, viewports, the visual iteration limit, and the design reference. Anything missing is detected from `package.json`, or reported as unavailable.

## Modes

| Mode        | When                                                       | What runs                                                   |
| ----------- | ---------------------------------------------------------- | ----------------------------------------------------------- |
| quick       | one component, a copy or style fix                         | the orchestrator, or one implementer                        |
| standard    | a new component or section                                 | design-analyst and repo-intel, implementers, tests, visual QA |
| full        | a new page or flow, API, state, routing, auth, redesign    | standard, plus code-reviewer on opus                        |
| visual-fix  | the page exists but differs from its reference             | visual QA, then implementers per root cause                 |
| review-only | findings only                                              | repo-intel and code-reviewer; no edits                      |

## Stages

0 Preflight (git state, project instructions, commands, capability probe) → 1 Classify → 2 Design analysis and repo index, in parallel → 3 Spec, traceability matrix, contracts, file ownership (Gate 1) → 4 Implement → 5 Integrate and focused checks (Gates 2 and 3) → 6 Automated tests → 7 Browser and visual QA loop → 8 Independent review → 9 Full regression, diff review, report (Gates 4 and 5).

## Components

```
frontend-engineer/
├── .claude-plugin/plugin.json
├── skills/frontend-build/
│   ├── SKILL.md                              entry point and stage order
│   └── references/
│       ├── classification-and-routing.md     task types, agent selection, model routing
│       ├── design-and-contracts.md           design spec, traceability matrix, contracts, ownership
│       ├── testing-and-visual-qa.md          test layers, visual checklist, defect severity, correction loop
│       └── gates-and-reporting.md            gates, completion states, telemetry, report format
├── skills/accessibility-audit/
│   ├── SKILL.md                              read-only WCAG 2.2 AA audit, stage order
│   └── references/criteria.md                static checks mapped to WCAG, manual checks, severity, report
├── agents/
│   ├── design-analyst.md    sonnet, read-only, reads the reference image
│   ├── repo-intel.md        haiku, read-only, task-scoped repository index
│   ├── implementer.md       sonnet, edits owned files, never runs tests
│   ├── test-author.md       sonnet, writes tests, does not run the suite
│   ├── visual-qa.md         sonnet, browser captures and comparison, read-only
│   ├── code-reviewer.md     opus, read-only independent review
│   ├── a11y-static-reviewer.md   sonnet, read-only, WCAG review of code and token contrast
│   └── a11y-runtime-auditor.md   sonnet, read-only, axe, focus order and reflow on the rendered page
├── hooks/
│   ├── hooks.json           PreToolUse on Write, Edit, MultiEdit and Bash
│   └── guard-file-ownership.mjs
├── scripts/
│   ├── gates.mjs            gate checks, recorded check runs, iteration limit, finish and abort
│   ├── ownership.mjs        path rules shared by the guard and the gate checks
│   ├── telemetry.mjs        stage timings, reported tokens, defects, iterations, summary
│   ├── contrast.mjs         WCAG contrast ratio for two colours, with the normal, large and non-text thresholds
│   ├── axe-scan.mjs         axe-core, focus order and 320px reflow on a URL, via the project's Playwright
│   └── validate.mjs         structure checks for the plugin and its marketplace entry
├── examples/config.example.json
└── test/                    guard, gates, telemetry, accessibility and structure tests
```

## Quality gates

`scripts/gates.mjs` enforces the five gates. The orchestrator runs `gates.mjs check <n>` before it advances, and the check lists every failure. Check results come only from `gates.mjs run <name> -- <command>`, which executes the command and stores its exit code and output. A recorded result counts only while the working tree still matches what it ran against. A result typed into the state file does not count.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/gates.mjs" init
node "${CLAUDE_PLUGIN_ROOT}/scripts/gates.mjs" package p1 src/features/orders/
node "${CLAUDE_PLUGIN_ROOT}/scripts/gates.mjs" ownership
node "${CLAUDE_PLUGIN_ROOT}/scripts/gates.mjs" check 1
node "${CLAUDE_PLUGIN_ROOT}/scripts/gates.mjs" run lint -- "npm run lint"
node "${CLAUDE_PLUGIN_ROOT}/scripts/gates.mjs" run test --scope full -- "npm test"
node "${CLAUDE_PLUGIN_ROOT}/scripts/gates.mjs" iterate
node "${CLAUDE_PLUGIN_ROOT}/scripts/gates.mjs" finish
```

The script decides what it can check: ownership overlaps, the matrix's file coverage, handoffs, check results and their currency, visual status against remaining defects, the iteration limit, and the review verdict. It does not decide whether a test is meaningful, whether the design matches, or whether the review is sound. Those remain judgment.

## Parallel execution and file ownership

The plan gives each work package one owner per file. Shared files (routes, global styles, barrel exports, shared types) have one owner, or change only in the integration stage. `gates.mjs ownership` writes the files the run may touch to `.claude/frontend-engineer/ownership.json`, generated from the packages. The `guard-file-ownership` hook then enforces that list:

- **Subagents may not write through the shell during a run.** Redirects (`>`, `>>`), `tee`, `cp`, `mv`, `rm`, `sed -i`, `perl -i`, `git checkout`, `git restore` and similar are denied. `2>&1` and `>/dev/null` are allowed. They must use Edit or Write, which the guard checks against the list.
- **Subagent writes outside the list are denied,** including writes to `.claude/frontend-engineer/`, which only the orchestrator writes.
- **The orchestrator's writes outside the list are denied** during a run, except under `.claude/frontend-engineer/`.
- **Read-only agents (`design-analyst`, `repo-intel`, `visual-qa`, `code-reviewer`, `a11y-static-reviewer`, `a11y-runtime-auditor`) cannot write** with a tool or through the shell, whether or not a run is active. The validator also rejects a read-only agent that lists a write tool.

The run ends with `gates.mjs finish`, which removes the ownership file only after gates 4 and 5 pass. `gates.mjs abort` removes it without checks.

The hook cannot tell which of several implementers is writing, so the split between them inside the list is enforced by the plan.

## Accessibility audit

`/frontend-engineer:accessibility-audit <route, component path, or "all routes">` audits against WCAG 2.2 AA. It is read-only and does not run the build flow.

- **Static review** (`a11y-static-reviewer`) reads the code: semantics, names and labels, keyboard handlers, focus handling, ARIA, headings, motion, and the contrast of the token pairs the code uses (`scripts/contrast.mjs`).
- **Runtime check** (`a11y-runtime-auditor`) runs `scripts/axe-scan.mjs` on the running page at each viewport. It reports axe-core violations, the first Tab stops with their focus visibility, and horizontal overflow at 320 CSS px. It presses Tab only.
- **Report** goes to `.claude/frontend-engineer/accessibility/report.md`, with each source's coverage, the manual checks still outstanding, and the criteria used.

The runtime check needs Playwright and axe-core in the project (`npm i -D playwright axe-core`), a browser, and the app running at `devServer.url`. Without them the check is reported as `not performed` with the reason, and the audit never describes the page from code alone. Routes behind a login are not reached.

Fixes are not made by the audit. Pass its report to `/frontend-engineer:frontend-build`.

## Telemetry

`scripts/telemetry.mjs` writes `.claude/frontend-engineer/telemetry.jsonl`:

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs" start implement
node "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs" end implement
node "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs" defect high --fixed
node "${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs" summary
```

Token usage is recorded only with `tokens <agent> <input> <output>`, and only when the harness reports it for that agent. Otherwise the summary says `unavailable`. Nothing is estimated.

## Capabilities and what they depend on

| Capability                    | Provided by                                              | If missing                                           |
| ----------------------------- | -------------------------------------------------------- | ---------------------------------------------------- |
| Design reference from an image or file | the Read tool, which reads images                 | use a URL or ask for an export                       |
| Design reference from a Figma link | a Figma connector connected to the session. **Not bundled with this plugin.** | the run uses an exported image instead |
| Browser for visual QA         | Playwright with Chromium, or the configured browser command | visual verification is reported as not performed |
| Project checks and tests      | the project's own scripts                                | the run reports each check as not run                |
| Ticket or API connectors      | connected in the session                                 | the run uses the request text and says so            |

Nothing in this plugin calls an external service directly.

## Example run

Illustrative only. This is the shape of a standard run, not a recorded result.

Request: `Add a status filter to the orders table, match docs/design/orders-filter.png`.

1. Preflight: branch `feature/orders-filter` is clean. `package.json` gives `npm run lint`, `npm run typecheck`, `npm test`. Playwright is available.
2. Classify: standard mode, risk raised for one change to a shared table component.
3. Stage 2 runs design-analyst on the screenshot and repo-intel on the orders feature, in parallel.
4. Stage 3: matrix rows R-01 (filter narrows rows), R-02 (filter state survives navigation), R-03 (empty state text). Contract: `StatusFilter` props `{ value, options, onChange }`. Ownership: `src/features/orders/StatusFilter.tsx`, `src/features/orders/OrdersTable.tsx`, `src/features/orders/OrdersTable.test.tsx`.
5. Stage 4: one implementer. Stage 5: lint and typecheck run, and both pass.
6. Stage 6: test-author adds tests for R-01 to R-03. The orchestrator runs `npx vitest run src/features/orders`. Result: 6 passed.
7. Stage 7: visual-qa at desktop and mobile. One medium defect: the filter wraps onto two lines below 390px. Implementer fixes it. Second pass: passing.
8. Stage 8: code-reviewer finds one blocking issue, a stale-response race in the filter request. Fixed, reviewed again.
9. Stage 9: full suite, build, diff review. The ownership file is deleted. The report lists each completion state separately, and user approval is pending.

## Limitations

- The hooks and scripts are tested. The agent and skill prompts depend on the Claude Code version and the harness. Confirm them on a real run before relying on the results.
- The guard identifies subagents by `agent_id` and read-only agents by `agent_type` in the hook input. Neither field is confirmed for `PreToolUse` in the Claude Code version this plugin targets. If the harness omits them, subagent rules fall back to the orchestrator's rules, and read-only agents are not restricted. Check this on a real run first.
- Shell-write detection matches common patterns. An interpreter such as `node -e`, `python -c`, or a script that writes files can still write outside the list.
- The guard cannot tell which of several implementers is writing, so the split between them is enforced by the plan.
- Gate checks cannot judge whether a test is meaningful, whether the design matches, or whether a review is sound. The `allowedFailures` check confirms that a reason is given, not that the test fails at the base commit.
- Visual QA needs a browser. Without one, the run says so and does not claim visual verification.
- Token metrics need harness support. Without it they are reported as unavailable.
- Model routing is set in each agent's `model:` line. The plugin cannot change the session's model.

## Troubleshooting

- **An edit is denied with "not in this frontend-engineer run's file list".** The run is active and the file is not in `ownership.json`. Add it to the plan with `gates.mjs package` and run `gates.mjs ownership`, or report it as a handoff.
- **A subagent's shell command is denied with "Shell writes are blocked".** Subagents write with Edit or Write during a run. Redirect output to `/dev/null` or use `2>&1` for logs.
- **Edits are still blocked after a run ends.** Run `gates.mjs abort`, or delete `.claude/frontend-engineer/ownership.json`.
- **`gates.mjs check` fails on "passed, but the changes were modified after it ran".** Run the check again after the last edit.
- **Visual verification says "not performed".** Install Playwright and Chromium, or set the browser command in `config.json`.
- **`validate.mjs` fails.** The message names the file and the rule.

## Development

```
node --test frontend-engineer/test/*.test.mjs
node frontend-engineer/scripts/validate.mjs
```

On Node 22, `node --test <directory>` does not find the tests, so list the files, as above.
