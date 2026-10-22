# End-to-end engineer plugin: gap analysis and build plan

Date: 2026-10-22. Branch: `ccr-5aa52e04-myjgjf`.

This is a planning document. No plugin code exists yet. It reviews the master build prompt, lists the gaps in it, resolves each one, and sets the order in which the plugin is built.

## 1. Reading of the request

- The plugin is for end-to-end testing. It is a new, separate plugin in this marketplace, named `e2e-engineer`. It is not a skill inside `backend-engineer`.
- The master prompt describes the workflow: discover the app, plan, generate artifacts, run browser, API and RBAC tests in parallel, triage defects, retest fixes, and report a release status.
- Scope follows from the E2E focus. The user journey is the unit of verification. Each journey is run through the UI, through the API, and into the database. RBAC matters here as journey branches, so the role matrix stays. Load testing and standalone accessibility audits are secondary lanes, not the centre of v1.
- "Backend" appears in the plan only as the `e2e-backend` skill, which covers the API and data legs of each journey. It is not a separate backend plugin.
- Every decision below has a default. The defaults are listed in section 4 so you can reverse any of them. None of them blocks the plan.

## 2. What already exists

This repo has four plugins. Three of them overlap with the E2E plugin.

| Prompt need | Existing in this repo | How the E2E plugin relates |
| --- | --- | --- |
| Journey and requirement reconstruction | `backend-engineer`: `requirements-analyst`, `flow-intelligence` reference | Separate analysis, independent of the builder. The builder's output is read as a claim, never as evidence. |
| API, E2E and security verification | `backend-engineer`: `e2e-verifier`, `test-engineer`, `security-reviewer` | `e2e-backend`, `e2e-runner` and `rbac-analyst` verify the running system without trusting the builder's runs. `e2e-verifier` is the closest overlap, so the two are kept apart on purpose. |
| Visual QA at viewports | `frontend-engineer`: `visual-qa` | `ux-analyst` (static spec) and `ui-runner` (runtime). The viewport-list convention is reused. |
| Evidence ledger that runs only declared commands | `backend-engineer/scripts/ledger.mjs` (980 lines) | The pattern is copied, not the file. See the constraint below. |
| Model routing and telemetry | `backend-engineer/scripts/route.mjs`, `telemetry.mjs` | Copied, with the same tier names. |
| Release status from evidence | `backend-engineer` `LEDGER release` | Replaced by the QA gate rules in G19, which the master prompt needs and the backend status does not cover. |

**Constraint: plugins cannot share code.** Each plugin is installed on its own, and no plugin in this repo refers to a path outside its own folder. The E2E plugin therefore copies the fingerprint and command-runner logic. A repo-level test in `tests/` asserts that the copies stay identical to their source, so they cannot drift silently.

## 3. Gap register

Each row names the prompt section, the gap, and how the plan resolves it. "Decision" marks the rows where your answer could change the plan. The default is already in the plan.

### Oracles and requirements

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G1 | 5, 7 | The "intended behaviour" is inferred from the code under test. A test that checks code against itself passes a bug. | Every expected result carries an oracle source: `spec`, `design`, `contract`, `doc`, or `observed`. A PASS or FAIL against intended behaviour needs a `spec`, `design`, `contract` or `doc` oracle. An `observed` result is recorded as "behaviour needs confirmation", never as a defect. | Accepted by default. You can supply acceptance criteria to upgrade an observation. |
| G2 | 3 | Most repos have no requirement IDs. | Provisional IDs `REQ-<area>-NNN`, marked `derived`. A derived requirement cannot drive a FAIL until you confirm it. | No |
| G3 | 6, 3 | Figma and the design system are assumed. This environment has no Figma connector. | Adapters for exported images, design-token JSON and CSS variables. Figma only if you connect it. Without a reference, visual parity is `not performed`. Spec checks still run: contrast, token-based spacing, layout. | D3 |
| G4 | 5 | Runtime-only behaviour (feature flags, roles stored in the database, remote config) does not appear in the code alone. | Read permissions and flags from seed data and migrations as well as from code. Anything unresolved is listed as `runtime-only, unverified`. | No |

### Scope and architecture

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G5 | 1, 4, 19 | The scope is too large for one pass: 14 agent roles, 12 artifact files, and 24 numbered sections. | Phased delivery v0.1 to v1.0, each with exit criteria (section 7). | No |
| G6 | 4 | Subagents cannot spawn subagents, but section 4 reads as if agents spawn other agents. | The orchestrator is the main session. It dispatches every agent, as `backend-engineer` does. | No |
| G7 | 4, 17, 19 | Agent 14 assigns fixes, and section 17 lets the plugin assign them to development agents. That makes QA a source of code changes, which conflicts with independent verification. | QA never edits application source. A hook enforces this. Fixes go out as handoff packets to `backend-engineer` or `frontend-engineer`. QA then retests by test ID. | Your override is needed to change this |
| G8 | 4 | Agents 3, 5 and 12 mix static analysis with runtime checks, so one agent is both read-only and browser-driving. | Split: `ux-analyst` and `rbac-analyst` are read-only. `ui-runner` and `api-runner` do runtime work. Agent 12 folds into `ui-runner`. | No |
| G9 | 10, 19 | Two naming schemes: letters A to I in section 10, and numbered files 00 to 11 in section 19. Section 10 has no entry for the acceptance and regression plan. | Use the section 19 file names. Map A to I onto them. File 10 covers the acceptance and regression item that section 10 leaves out. | No |
| G10 | 1, 13 | "Devices" and "mobile" appear, but the prompt defines no native app scope. | v1 covers a web app in browsers and responsive viewports. Native mobile, desktop apps and CLIs are exclusions. | D2 |
| G11 | 3, 23 | The prompt assumes the app can be started. It does not say how: start command, health check, or database access. | `qa.config.json` declares `start`, `healthUrl`, `services` and `db`. If `start` is missing, the status is `BLOCKED`. The plugin does not guess. | No |

### Safety and authorization

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G12 | 3, 11 | "Dedicated test environment" is not defined, so nothing can prove it. | A target allowlist in config: hosts and a database name pattern. Before any write, `env-data validate` checks the host, the database name and a run-marker row. Any mismatch stops the run. Production-looking hostnames are refused by default. | No |
| G13 | 8, 9 | Security probes (CSRF, injection, rate limit, session) need an authorization statement. | Config records `authorization: {scope, authorizedBy, date}`. Without it, `e2e-backend` runs static security checks only. Probes use non-destructive marker payloads, only against allowlisted hosts. Rate-limit tests stay within a declared limit. | D4 |
| G14 | 3, 11 | Destructive operations are allowed "with explicit authorization", but the prompt does not say who gives it. | `allowReset: false` by default. Seed and reset need `allowReset: true` and a passing target validation. | No |
| G15 | 3 | Test credentials are not addressed. | Config names environment variables. Generated test passwords go to a gitignored file and are never printed. Reports refer to accounts by role ID only. | No |
| G16 | 13, 15 | Traces, HAR files and screenshots capture cookies, tokens and personal data. | The evidence pipeline redacts auth headers, cookies and token-like values before writing. Evidence has a retention cap. | No |
| G17 | 19 | The prompt says not to commit credentials, but its artifact tree sits inside the repo. | Evidence goes to `.claude/e2e-engineer/`. The plugin adds that folder to the target's `.gitignore`, with consent. `qa-artifacts/` is written only on request, text only by default. | No |

### Approvals and gates

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G18 | 10, 18 | Who approves the baseline test plan and any accepted risk? "Authorized decision-maker" is undefined. | Approval is a named decision, recorded with the plan's hash. QA cannot approve its own plan. Each accepted risk needs its own named decision. Without one, the status stays FAIL. | D4 |
| G19 | 18 | The five status options have no precedence rules. | In order: any failed mandatory gate gives FAIL. Else any mandatory gate that is blocked gives BLOCKED. Else any planned suite that did not run gives PARTIALLY TESTED. Else PASS, or PASS WITH ACCEPTED RISKS when accepted items exist. | No |
| G20 | 16 | "Essential journey" and "important workflow" are not separated, so a severity cannot be assigned consistently. | Journeys carry a priority: P0 (essential, release-blocking), P1 or P2. Severity follows the table in `backend-engineer`, plus rules for access control and cross-tenant exposure. | No |
| G21 | 15 | No performance thresholds. Load tests need bounded limits. | Thresholds are labelled PROPOSED until approved. A load run needs `loadLimits` (maximum virtual users, duration and requests per second) and an environment flag. `perf-runner` refuses to run without both. Deferred to v0.5. | No |

### Execution

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G22 | 12 | Parallel tests on a shared database corrupt each other: unique emails, counters, global sessions. | Lanes. Read-only suites run in parallel. Mutating suites run in series, unless the app supports per-worker tenants. Test data uses a run-ID prefix. | No |
| G23 | 12 | Nothing separates infrastructure failures from defects, or flaky tests from real ones. | Infrastructure failure: the failure happens before the app's behaviour is exercised (startup, seed, health check, a timeout during setup). Retry once, for infrastructure only. A test that passes and fails on the same tree is `flaky`, never `passed`. | No |
| G24 | 12, 14 | Race-condition tests depend on timing. | Send N parallel requests behind a barrier. Assert invariants (one row, one charge, one approval), never timing. | No |
| G25 | 11, 14 | Third-party sandboxes may not exist. Live and double results must not be mixed. | Doubles by default. Each result is tagged `double` or `live`. The report never calls a double a live pass. Sandbox mode is opt-in, with the sandbox declared in config. | D5 |
| G26 | 13 | Browser availability varies. Installing browsers without asking is not acceptable. | Browser probe, honouring `PLAYWRIGHT_BROWSERS_PATH`. `playwright install` runs only with consent. A missing browser makes the UI tests `blocked`, never `skipped`. | No |
| G27 | 3, 23 | Test dependencies would be installed into the user's repo. | Use the repo's existing test runner. If there is none, propose the package and ask. Do not edit a lockfile without consent. | No |
| G28 | 3, 23 | Results depend on dates, time zones and random IDs. | Fixed clock through the browser clock API, or app config where the app supports it. Time zones are declared in config. Unsupported cases are recorded as limitations. | No |

### Evidence and traceability

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G29 | 3, 10 | A commit SHA alone does not identify the build when the tree has uncommitted changes. | Build ID = commit SHA plus a fingerprint of the changed files, as `backend-engineer` does. Evidence is stale when the fingerprint changes. | No |
| G30 | 20 | Coverage percentages would present mapped scope as proof of quality. | Each state is reported separately: mapped, implemented, executed, passed. No single percentage. | No |
| G31 | 21 | Token use and cost are unbounded across waves. | Tier routing, telemetry, and a per-run budget in config. Token counts are recorded only when the harness reports them. | No |

### Plugin self-testing

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G32 | 22 | There is no ground truth to measure the plugin against, and no check for false positives. | `fixtures/planted-app`: a small Node and SQLite app with 11 planted defects and a manifest. A clean-control copy has none. Score: recall on planted defects, and zero findings on the clean control. | No |
| G33 | 22 | Browser self-tests cannot run everywhere, including in CI. | Unit tests with `node:test` run everywhere. Browser self-tests run where Chromium exists. The report states which ones ran. | No |

### Naming and tooling

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G34 | 11, 19 | The prompt names scripts `seed-test-data.*` without a language. | The plugin's own tooling is Node ESM with no runtime dependencies, matching the sibling plugins. Scripts generated for the target repo use the target's language, chosen in discovery. | No |
| G35 | 4, 21 | The prompt asks for model selection without naming a routing mechanism. | Routing by tier through `route.mjs`, as in `backend-engineer`. Plugin files name tiers, not model IDs, because IDs change. | No |

### Out of scope for this plan

- `install.ps1` installs only `forge` and `repo-orchestrator`. `install.sh` installs all four plugins. This drift predates this work. The fix is one line, and it is left for a separate change so this one stays a plan.

## 4. Decisions with defaults

These are the choices that need your confirmation. The plan proceeds on the defaults.

| ID | Question | Default used |
| --- | --- | --- |
| D1 | New plugin `e2e-engineer`, or a skill inside `backend-engineer`? | **Resolved: a separate new plugin, confirmed by the user.** Its API and data skill is `e2e-backend`. |
| D2 | Is native mobile or desktop in scope? | No. Web app in browsers and responsive viewports only. |
| D3 | Will you connect Figma? | No. Design references come from exports and tokens. Visual parity is `not performed` without them. |
| D4 | Who approves the test plan, accepts risk, and authorizes security probes? | You, in the session. Each approval is recorded with your name and the plan's hash. |
| D5 | Do third-party sandbox credentials exist? | No. Doubles only. Live integration tests run once credentials are supplied. |

## 5. Architecture

### Layout

```
e2e-engineer/
  .claude-plugin/plugin.json
  README.md
  skills/
    e2e-campaign/  orchestrator: the full lifecycle, user-invoked
    e2e-backend/   API, data, RBAC runtime, concurrency, security probes for each journey
    e2e-ui/        browser journeys, responsive viewports, accessibility, console and network capture
  agents/          repo-intel, flow-analyst, ux-analyst, rbac-analyst, test-strategist,
                   env-data, ui-runner, api-runner, e2e-runner, perf-runner, triage
  hooks/           guard.mjs: denies writes to application source; denies writes to a target not validated
  scripts/         ledger.mjs, safety.mjs (allowlist and probes), fingerprint.mjs, route.mjs,
                   telemetry.mjs, redact.mjs, report.mjs, validate.mjs
  templates/       qa.config.example.json
  fixtures/        planted-app/ and planted-app-clean/ with manifest.json
  test/            node:test suites
```

### Agents

| Prompt agent | Plan role | Tier | Writes | Status |
| --- | --- | --- | --- | --- |
| 1 QA Orchestrator | `e2e-campaign` skill (the main session) | strong | ledger only | Kept (G6) |
| 2 Repository intelligence | `repo-intel` | efficient | nothing | Kept |
| 3 UI/UX and visual | `ux-analyst` (static) + `ui-runner` (runtime) | strong / efficient | nothing / evidence | Split (G8) |
| 4 User flow and business logic | `flow-analyst` | strong | nothing | Kept |
| 5 RBAC and security | `rbac-analyst` (static) + `api-runner` (runtime probes) | strong | nothing / evidence | Split (G8) |
| 6 Strategy and documentation | `test-strategist` | strong | `qa-artifacts/` drafts | Kept |
| 7 Mock data and environment | `env-data` | efficient | QA-owned scripts and fixtures | Kept |
| 8 UI automation | `ui-runner` | efficient | tests it owns, evidence | Kept |
| 9 API, backend and data | `api-runner` | efficient | tests it owns, evidence | Kept |
| 10 Integration and E2E | `e2e-runner` | efficient | tests it owns, evidence | Kept, serial |
| 11 Performance and reliability | `perf-runner` | efficient | evidence | Deferred to v0.5, opt-in (G21) |
| 12 Accessibility and compatibility | folded into `ui-runner`, separate lane | efficient | evidence | Folded (G8) |
| 13 Defect triage | `triage` | strong | defect register | Kept, read-only on code |
| 14 Remediation and regression | not an agent: handoff packets and the orchestrator's `retest` action | n/a | handoff packets | Changed (G7) |

Strong-tier agents do analysis that decides outcomes: flows, RBAC, strategy, triage. Efficient-tier agents do repetitive work under a fixed plan. Any finding rated Critical gets an independent second review before it is reported.

### Ledger entities

- `requirements`: ID, text, source, `derived` flag, status.
- `journeys`: ID, priority P0, P1 or P2, steps, branches, roles, oracle references.
- `expectations`: each expected result, with its oracle source.
- `testCases`: ID, suite, journey and requirement links, lane, data it needs, oracle, automation status.
- `runs`: test case ID, build ID, result, `double` or `live`, evidence paths, redaction check.
- `defects`: `DEF-###`, with the test cases that reproduce it. Duplicates merge on root cause.
- `decisions`: plan approval, accepted risks, authorization, each with the approver's name and a hash.
- `handoffs`: defect ID, owner (`backend-engineer` or `frontend-engineer`), acceptance criteria, retest test IDs.

Result states: `passed`, `failed`, `blocked`, `skipped`, `not-run`, `stale`, `flaky`. These are kept apart. A test that was implemented but not executed is `not-run`, not `passed`.

Defect states: `Detected`, `Confirmed`, `Triaged`, `Handed Off`, `Fix Claimed`, `Retest Passed`, `Regression Passed`, `Closed`. A developer's "fixed" moves a defect to `Fix Claimed` only. QA closes a defect only after the retest and the regression run pass on the current build.

### Gates

A release gate is mandatory when it covers one of these:

- every P0 journey is `passed` on the current build,
- every critical RBAC and cross-tenant case is `passed`,
- no open Critical or High defect,
- security probes ran, or the status says they did not run,
- the plan was approved, and the approval hash matches the plan.

Gate status follows the precedence in G19.

### Phases and checkpoints

0. Intake and safety: read `qa.config.json`, check the target allowlist, probe the environment and the browser, record the build ID. Checkpoint: safety passes, or the run stops.
1. Repository reconnaissance (`repo-intel`).
2. Flow and oracle discovery (`flow-analyst`, `ux-analyst`, `rbac-analyst`, in parallel).
3. Risk analysis and strategy (`test-strategist`).
4. **Checkpoint: plan approval.** The plan is frozen with a hash. Execution cannot start until the decision is recorded.
5. Environment preparation (`env-data`), in series.
6. Execution in waves. Read-only lanes run in parallel: `api-runner` reads, `ui-runner` views, accessibility scans. Mutating lanes run in series: `api-runner` writes, `e2e-runner`.
7. Triage (`triage`): deduplicate, confirm, rank, write reproduction steps.
8. Handoff and retest: packets go to the builder agents. QA retests by test ID and runs regression.
9. Final report and gate evaluation.

Critical findings are written to the defect register as soon as they are confirmed. They are not held for the end of the run.

### Stop conditions

- A safety check fails, or the target is outside the allowlist.
- The environment fails its health check twice.
- A lane's infrastructure failures exceed 30 percent (a default, configurable).
- A security probe finds a Critical issue. Mutating tests against that host stop, and the finding is reported.
- The run budget is exceeded.

## 6. How the fixtures test the plugin

`fixtures/planted-app` is a small app: Node, SQLite, and a plain HTML front end. Each planted defect has an expected detector.

| # | Planted defect (§22) | Expected detector | Expected result |
| --- | --- | --- | --- |
| 1 | Button with no working handler | `ui-runner` | Dead control defect |
| 2 | Form missing server-side validation | `api-runner` against the contract | Validation defect |
| 3 | Permission enforced only in the UI | `rbac-analyst` (hidden, not denied) and `api-runner` (direct call succeeds) | Authorization defect |
| 4 | Role reads another user's record | `api-runner` (object-level probe) | Critical access defect |
| 5 | Incomplete approval workflow | `flow-analyst` gap, then `e2e-runner` | Workflow defect |
| 6 | Transaction or concurrency defect | `api-runner` barrier test | Invariant violated |
| 7 | Response contract broken | `api-runner` against the OpenAPI document | Contract defect |
| 8 | Network failure with bad recovery | `ui-runner` with request interception | Recovery defect |
| 9 | Responsive layout defect | `ui-runner` at each viewport | Layout defect |
| 10 | Form control with no accessible name | `ui-runner` (axe and keyboard) | Accessibility defect |
| 11 | Flaky test from shared mutable data | Orchestrator flake rule (G23) | Classified `flaky`, not `passed` |

The clean control runs the same suite. It must produce zero defects. A finding on the clean control is a false positive, and it blocks the release of the plugin.

## 7. Build phases

| Version | Scope | Exit criteria |
| --- | --- | --- |
| v0.1 Foundation | Plugin skeleton. Config and target allowlist. Ledger. Build ID. Intake and capability probe. `repo-intel`. Planted-app fixture and clean control. Marketplace entry added once it validates. | Safety refusals are tested: wrong host, wrong database, missing authorization, production-like name. The planted app is mapped. |
| v0.2 Documentation | `flow-analyst`, `ux-analyst`, `rbac-analyst`, `test-strategist`. Artifact files 00 to 11. Plan approval with hash. | Every test case has an oracle. Requirement traceability validates. The plan hash changes when the plan changes. |
| v0.3 Backend execution | `env-data` (seed, reset, validate). `api-runner` and `e2e-backend`. Runtime RBAC probes. Concurrency lane. | Planted defects 2, 3, 4, 6 and 7 are reproduced. The clean control has zero findings. |
| v0.4 Browser execution | `ui-runner` and `e2e-ui`. Golden paths. Responsive viewports. Accessibility scan. Redacted traces. | Planted defects 1, 8, 9 and 10 are found. A redaction test shows no cookies or tokens in stored evidence. |
| v0.5 Remediation loop | `triage`, handoff packets, retest by test ID, regression and stale-evidence tracking. `perf-runner`, opt-in with limits. | A fix is retested, and the defect closes only after the regression run passes. A stale run is reported as stale. |
| v1.0 Release | `e2e-runner` (cross-layer), final report, gate evaluation, self-test suite, README, install scripts updated. | All 11 planted defects found, the clean control clean, and the self-tests pass. The report reproduces from the ledger. |

## 8. Risks

- **Scope creep.** The prompt asks for more than any single phase can deliver. Each phase has exit criteria, and v1.0 is not claimed until all of them hold.
- **Shared-state flakiness.** Parallel mutating runs will corrupt data if the lane rules are relaxed. The serial default protects against this.
- **Duplicate logic.** The copied ledger and fingerprint code can drift. The repo-level identity test catches it.
- **Oracle gaps.** Where a project has no requirements, most results will be `observed`, not PASS or FAIL. The report says so. It does not fill the gap with assumptions.
- **Security probes against live systems.** Even on a test host, probes can trip lockouts or alerts. Probes stay non-destructive, bounded, and limited to the allowlist.

## 9. Next steps

1. D1 is settled: a separate plugin. Confirm or reverse D2 to D5. If you change none, v0.1 starts on those defaults.
2. Build v0.1, including the planted-app fixture and the safety tests, before any agent prompts are written.
3. Add `e2e-engineer` to the marketplace and the installers once v0.1 validates.
4. Fix the `install.ps1` drift separately.
