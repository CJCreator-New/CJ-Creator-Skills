# End-to-end engineer skill: gap analysis and build plan

Date: 2026-10-22. Branch: `ccr-5aa52e04-myjgjf`.

**Status: ready for approval.** No plugin code exists yet. This version adds mobile verification, makes Figma an optional connector, and packages the work as one skill. The plan is not approved until you say so. When you approve, the approval is recorded with your name and the SHA-256 of this file at that commit, as decision D4 requires.

## 1. Reading of the request

- The deliverable is a **new skill, `e2e-engineer`**. It is packaged in its own plugin folder, `e2e-engineer/`, the same way `backend-engineer` packages its `backend-build` skill. Earlier drafts split the work into three skills. Those splits are now reference files inside one skill. If you meant a skill inside an existing plugin, say so and I will move it.
- The skill is for **end-to-end testing**. The user journey is the unit of verification. Each journey runs through the UI, through the API, into the database, and on every target in scope.
- **Mobile is in scope.** The skill verifies mobile web, native Android and native iOS. The tester supplies the devices or emulators that the environment does not provide.
- **Figma is an optional connector.** If the tester connects it, the skill reads designs from it. If not, the skill uses exported images and design tokens.
- RBAC is kept, as journey branches and as a role matrix. Load testing and standalone accessibility audits remain secondary lanes.
- Every decision has a default, listed in section 4. Open decisions do not block the work that does not depend on them.

## 2. What already exists

This repo has four plugins. Three overlap with the new skill.

| Prompt need | Existing in this repo | How the new skill relates |
| --- | --- | --- |
| Journey and requirement reconstruction | `backend-engineer`: `requirements-analyst`, `flow-intelligence` reference | Separate analysis, independent of the builder. The builder's output is read as a claim, never as evidence. |
| API, E2E and security verification | `backend-engineer`: `e2e-verifier`, `test-engineer`, `security-reviewer` | `api-runner`, `e2e-runner` and `rbac-analyst` verify the running system without trusting the builder's runs. `e2e-verifier` is the closest overlap, so the two are kept apart on purpose. |
| Visual QA at viewports | `frontend-engineer`: `visual-qa`, `design-analyst` | `ux-analyst` (static spec), `web-runner` and `mobile-runner` (runtime). The viewport convention is reused. |
| Evidence ledger that runs only declared commands | `backend-engineer/scripts/ledger.mjs` (980 lines) | The pattern is copied, not the file. See the constraint below. |
| Model routing and telemetry | `backend-engineer/scripts/route.mjs`, `telemetry.mjs` | Copied, with the same tier names. |
| Release status from evidence | `backend-engineer` `LEDGER release` | Replaced by the gate rules in G19. The master prompt needs them, and the backend status does not cover them. |

**Constraint: plugins cannot share code.** Each plugin is installed on its own, and no plugin in this repo refers to a path outside its own folder. The new skill copies the fingerprint and command-runner logic. A repo-level test in `tests/` asserts that the copies stay identical to their source.

## 3. Gap register

Each row names the prompt section, the gap, and how the plan resolves it. "Decision" marks the rows where your answer could change the plan.

### Oracles and requirements

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G1 | 5, 7 | The "intended behaviour" is inferred from the code under test. A test that checks code against itself passes a bug. | Every expected result carries an oracle source: `spec`, `design`, `contract`, `doc`, or `observed`. A PASS or FAIL against intended behaviour needs a `spec`, `design`, `contract` or `doc` oracle. An `observed` result is recorded as "behaviour needs confirmation", never as a defect. | Accepted by default. You can supply acceptance criteria to upgrade an observation. |
| G2 | 3 | Most repos have no requirement IDs. | Provisional IDs `REQ-<area>-NNN`, marked `derived`. A derived requirement cannot drive a FAIL until you confirm it. | No |
| G3 | 6, 3 | Design references are assumed, and this environment has no Figma connector. | Resolution order: a connected Figma connector, then exported images in the repo, then design-token JSON or CSS variables, then none. With none, visual parity is `not performed` and spec checks still run: contrast, token-based spacing, layout. | No (optional, see F1) |
| G4 | 5 | Runtime-only behaviour (feature flags, roles stored in the database, remote config) does not appear in the code alone. | Read permissions and flags from seed data and migrations as well as from code. Anything unresolved is listed as `runtime-only, unverified`. | No |

### Scope and architecture

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G5 | 1, 4, 19 | The scope is too large for one pass: 14 agent roles, 12 artifact files, and 24 numbered sections. | Phased delivery v0.1 to v1.0, each with exit criteria (section 7). | No |
| G6 | 4 | Subagents cannot spawn subagents, but section 4 reads as if agents spawn other agents. | The orchestrator is the main session. It dispatches every agent, as `backend-engineer` does. | No |
| G7 | 4, 17, 19 | Agent 14 assigns fixes, and section 17 lets the plugin assign them to development agents. That makes QA a source of code changes, which conflicts with independent verification. | The skill never edits application source. A hook enforces this. Fixes go out as handoff packets to `backend-engineer` or `frontend-engineer`. The skill then retests by test ID. | Your override is needed to change this |
| G8 | 4 | Agents 3, 5, 8 and 12 mix static analysis with runtime checks, so one agent is both read-only and driving a device. | Split. `ux-analyst` and `rbac-analyst` are read-only. `web-runner` and `mobile-runner` do the runtime work. Agent 12 folds into both runners. | No |
| G9 | 10, 19 | Two naming schemes: letters A to I in section 10, and numbered files 00 to 11 in section 19. Section 10 has no entry for the acceptance and regression plan. | Use the section 19 file names. Map A to I onto them. File 10 covers the acceptance and regression item that section 10 leaves out. | No |
| G10 | 1, 13 | "Devices" and "mobile" appear, but the prompt gives no native scope. | **Resolved: mobile is in scope.** Targets are declared per run: `web`, `mobile-web`, `android`, `ios`. Each target has its own journeys, tools and device matrix. See M1 to M10. | Resolved |
| G11 | 3, 23 | The prompt assumes the app can be started. It does not say how: start command, health check, or database access. | `qa.config.json` declares `start`, `healthUrl`, `services`, `db` and each target. If `start` is missing, the status is `BLOCKED`. The skill does not guess. | No |

### Safety and authorization

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G12 | 3, 11 | "Dedicated test environment" is not defined, so nothing can prove it. | A target allowlist in config: hosts, app bundle IDs or package names, and a database name pattern. Before any write, `env-data validate` checks the host, the database name and a run-marker row. Any mismatch stops the run. Production-looking hostnames are refused by default. | No |
| G13 | 8, 9 | Security probes (CSRF, injection, rate limit, session) need an authorization statement. | Config records `authorization: {scope, authorizedBy, date}`. Without it, `api-runner` runs static security checks only. Probes use non-destructive marker payloads, only against allowlisted hosts. Rate-limit tests stay within a declared limit. | D4 |
| G14 | 3, 11 | Destructive operations are allowed "with explicit authorization", but the prompt does not say who gives it. | `allowReset: false` by default. Seed and reset need `allowReset: true` and a passing target validation. | No |
| G15 | 3 | Test credentials are not addressed. | Config names environment variables. Generated test passwords go to a gitignored file and are never printed. Reports refer to accounts by role ID only. | No |
| G16 | 13, 15 | Traces, HAR files, screenshots and device logs capture cookies, tokens and personal data. | The evidence pipeline redacts auth headers, cookies, token-like values and device-log secrets before writing. Evidence has a retention cap. | No |
| G17 | 19 | The prompt says not to commit credentials, but its artifact tree sits inside the repo. | Evidence goes to `.claude/e2e-engineer/`. The skill adds that folder to the target's `.gitignore`, with consent. `qa-artifacts/` is written only on request, text only by default. | No |

### Approvals and gates

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G18 | 10, 18 | Who approves the baseline test plan and any accepted risk? "Authorized decision-maker" is undefined. | Approval is a named decision, recorded with the plan's hash. The skill cannot approve its own plan. Each accepted risk needs its own named decision. Without one, the status stays FAIL. | D4 |
| G19 | 18 | The five status options have no precedence rules. | In order: any failed mandatory gate gives FAIL. Else any mandatory gate that is blocked gives BLOCKED. Else any planned suite that did not run gives PARTIALLY TESTED. Else PASS, or PASS WITH ACCEPTED RISKS when accepted items exist. | No |
| G20 | 16 | "Essential journey" and "important workflow" are not separated, so a severity cannot be assigned consistently. | Journeys carry a priority: P0 (essential, release-blocking), P1 or P2. Severity follows the table in `backend-engineer`, plus rules for access control, cross-tenant exposure and mobile-specific data exposure. | No |
| G21 | 15 | No performance thresholds. Load tests need bounded limits. | Thresholds are labelled PROPOSED until approved. A load run needs `loadLimits` (maximum virtual users, duration and requests per second) and an environment flag. `perf-runner` refuses to run without both. Deferred to v0.6. | No |

### Execution

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G22 | 12 | Parallel tests on a shared database corrupt each other: unique emails, counters, global sessions. | Lanes. Read-only suites run in parallel. Mutating suites run in series, unless the app supports per-worker tenants. Test data uses a run-ID prefix. | No |
| G23 | 12 | Nothing separates infrastructure failures from defects, or flaky tests from real ones. | Infrastructure failure: the failure happens before the app's behaviour is exercised (startup, seed, health check, device not available, a timeout during setup). Retry once, for infrastructure only. A test that passes and fails on the same tree is `flaky`, never `passed`. | No |
| G24 | 12, 14 | Race-condition tests depend on timing. | Send N parallel requests behind a barrier. Assert invariants (one row, one charge, one approval), never timing. | No |
| G25 | 11, 14 | Third-party sandboxes may not exist. Live and double results must not be mixed. | Doubles by default. Each result is tagged `double` or `live`. The report never calls a double a live pass. Sandbox mode is opt-in, with the sandbox declared in config. | D5 |
| G26 | 13 | Browser and emulator availability varies. Installing them without asking is not acceptable. | Probes for the browser (honouring `PLAYWRIGHT_BROWSERS_PATH`), Android tools, and iOS tools. Installs run only with consent. A missing tool makes the affected tests `blocked`, never `skipped`. | No |
| G27 | 3, 23 | Test dependencies would be installed into the user's repo. | Use the repo's existing test runner. If there is none, propose the package and ask. Do not edit a lockfile without consent. | No |
| G28 | 3, 23 | Results depend on dates, time zones and random IDs. | Fixed clock through the browser clock API, or app config where the app supports it. Time zones are declared in config. Unsupported cases are recorded as limitations. | No |

### Mobile

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| M1 | 1, 13 | Which mobile surface: mobile web, native Android, native iOS? | All three are targets, declared per run. A target whose tools are missing is `blocked` with the reason. Mobile web runs in Chromium with device emulation, so it works in this cloud environment. Native targets need an emulator, simulator or device. | D6 |
| M2 | 3 | A commit SHA does not identify a native binary. Store builds, debug builds and rebuilt binaries differ. | Native build ID = commit SHA, plus the binary's SHA-256, version name and build number. The tested binary must match the build handover. A rebuilt binary makes runs stale. | No |
| M3 | 11 | Android emulators need hardware virtualization (KVM) on Linux. iOS simulators need macOS. This cloud container has Chromium only. | Capability probes: `adb devices`, `emulator`, `xcrun simctl`, the Appium server, the Maestro CLI. Native journeys without a probe result are `blocked`. Cloud device farms (BrowserStack, Sauce Labs, AWS Device Farm) are optional connectors, with credentials passed by environment-variable name. | D6 |
| M4 | 13 | The repo may use a mobile framework the prompt does not name. | Use the repo's own tool when present: Detox (React Native), XCUITest, Espresso, Flutter integration tests, Appium, or Maestro. If none exists, propose Maestro for flows (YAML, both platforms) and Appium for the wider device matrix, and ask before installing. | No |
| M5 | 15 | The prompt omits mobile behaviour: permission prompts, push notifications, deep and universal links, background and kill-relaunch, offline and throttled networks, biometric login, orientation, text scaling, dark mode, right-to-left layout, safe areas, keyboard overlap, touch target size. | A mobile matrix in `references/mobile-verification.md`. Each item is a test case with an oracle. Applicability is marked per app. "Not applicable" needs a stated reason. | No |
| M6 | 15 | Old installed apps talk to a new backend. Forced-update endpoints are untested. | A journey branch: install the previous release binary, run login and one core journey, then run the new binary against the same backend. Without the previous binary, the branch is `blocked`. | No |
| M7 | 13, 16 | Secure storage is unchecked: tokens in keychain or keystore rather than plain files, certificate pinning, debug endpoints in release builds. | Static, read-only checks on the tester's own manifests, configuration and binaries: hardcoded secrets (reported by location and type, never by value), debuggable flags, cleartext-traffic and backup settings. Dynamic checks run only on the test environment. | No |
| M8 | 9 | Accessibility on mobile is not covered by the web checks: TalkBack and VoiceOver labels, touch target sizes (44 points on iOS, 48 density-independent pixels on Android). | Checks use the platform accessibility tree, and sizes are measured from it. Judgement items go to the human list. | No |
| M9 | 20 | Device evidence (screenshots, video, logs) is large, and logs can contain personal data and tokens. | Redaction covers device logs. Evidence is kept per device and OS version. Video is off by default. | No |
| M10 | 22 | No emulator runs in CI, so mobile self-tests cannot run everywhere. | Mobile-web self-tests run in Chromium. Native self-tests run where an emulator or simulator exists. Static binary checks run everywhere, using a planted manifest. The report says which ran. | No |

### Figma

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| F1 | 6, 3 | The Figma connector is not connected in this session. The skill cannot add it. | The tester connects Figma in their Claude settings. The skill checks for the connector at intake. Connected: it reads frames, variables and component specs. Not connected: exports and tokens are used, and visual parity is `not performed`. | No (optional) |
| F2 | 6 | Figma text (frame names, comments, layer text) is untrusted input and can contain instructions. | Figma content is read as data only, and the skill never follows instructions found in it. The skill never stores Figma credentials. | No |
| F3 | 6 | Mapping designs to screens and breakpoints is ambiguous. | A `design-map.json` is built during discovery and confirmed by the tester. Screens with no frame are listed as `no reference`. | No |

### Evidence and traceability

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G29 | 3, 10 | A commit SHA alone does not identify the build when the tree has uncommitted changes. | Build ID = commit SHA plus a fingerprint of the changed files, as `backend-engineer` does. Evidence is stale when the fingerprint changes. Native targets add M2. | No |
| G30 | 20 | Coverage percentages would present mapped scope as proof of quality. | Each state is reported separately: mapped, implemented, executed, passed. No single percentage. | No |
| G31 | 21 | Token use and cost are unbounded across waves. | Tier routing, telemetry, and a per-run budget in config. Token counts are recorded only when the harness reports them. | No |

### Plugin self-testing

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- | --- |
| G32 | 22 | There is no ground truth to measure the skill against, and no check for false positives. | `fixtures/planted-app`: a small Node and SQLite app with a responsive HTML front end and 13 planted defects, with a manifest. A clean-control copy has none. Score: recall on planted defects, and zero findings on the clean control. | No |
| G33 | 22 | Browser self-tests cannot run everywhere, including in CI. | Unit tests with `node:test` run everywhere. Browser self-tests run where Chromium exists. The report states which ones ran. | No |

### Naming and tooling

| # | § | Gap | Resolution | Decision |
| --- | --- | --- | --- |
| G34 | 11, 19 | The prompt names scripts `seed-test-data.*` without a language. | The skill's own tooling is Node ESM with no runtime dependencies, matching the sibling plugins. Scripts generated for the target repo use the target's language, chosen in discovery. | No |
| G35 | 4, 21 | The prompt asks for model selection without naming a routing mechanism. | Routing by tier through `route.mjs`, as in `backend-engineer`. Skill files name tiers, not model IDs, because IDs change. | No |

### Out of scope for this plan

- `install.ps1` installs only `forge` and `repo-orchestrator`. `install.sh` installs all four plugins. This drift predates this work. The fix is one line, left for a separate change.

## 4. Decisions

| ID | Question | Status and default |
| --- | --- | --- |
| D1 | Packaging: a new skill, or a skill inside an existing plugin? | **Resolved:** one new skill, `e2e-engineer`, in its own plugin folder, matching `backend-engineer`'s layout. Reversible if you meant an existing plugin. |
| D2 | Scope: mobile in or out? | **Resolved: in scope.** Mobile web, native Android and native iOS. |
| D3 | Figma: connect it or not? | **Resolved: optional.** The skill uses it if you connect it. Otherwise exports and tokens are used. |
| D4 | Who approves the plan, accepts risk, and authorizes security probes? | **Open.** Default: you, in the session. Each approval is recorded with your name and the plan's SHA-256. |
| D5 | Do third-party sandbox credentials exist? | **Open.** Default: none. Doubles only. Live integration tests run once credentials are supplied. |
| D6 | Which devices and emulators can you provide? | **Open.** Default: none beyond Chromium. Native journeys stay `blocked` until an Android emulator, an iOS simulator on macOS, a physical device, or a device farm connector is available. |

## 5. Architecture

### Layout

```
e2e-engineer/                      plugin folder, packaged like backend-engineer
  .claude-plugin/plugin.json
  README.md
  skills/e2e-engineer/
    SKILL.md                       orchestrator: lifecycle, dispatch rules, hard rules
    references/
      intake-and-safety.md          config, target allowlist, probes, authorization, credentials
      discovery-and-oracles.md      repo, flows, oracles, runtime-only behaviour
      design-references.md          exports, tokens, optional Figma connector, design map
      strategy-and-approval.md      strategy, test catalog, plan hash, approval
      backend-verification.md       API, data, RBAC, concurrency, security probes
      web-verification.md           browser journeys, viewports, accessibility, network
      mobile-verification.md        mobile web, Android, iOS, matrix, binaries, store builds
      triage-and-retest.md          triage, handoff, retest, stale evidence
      reporting-and-gates.md        status precedence, gates, final report
  agents/          repo-intel, flow-analyst, ux-analyst, rbac-analyst, test-strategist,
                   env-data, web-runner, mobile-runner, api-runner, e2e-runner, perf-runner, triage
  hooks/           guard.mjs: denies writes to application source and to targets not validated
  scripts/         ledger.mjs, safety.mjs, fingerprint.mjs, route.mjs, telemetry.mjs,
                   redact.mjs, binary.mjs (native build identity), report.mjs, validate.mjs
  templates/       qa.config.example.json
  fixtures/        planted-app/ and planted-app-clean/ with manifest.json,
                   planted-android-config/ (manifest and config only, for static checks)
  test/            node:test suites
```

### Agents

| Prompt agent | Plan role | Tier | Writes | Status |
| --- | --- | --- | --- | --- |
| 1 QA Orchestrator | the `e2e-engineer` skill (the main session) | strong | ledger only | Kept (G6) |
| 2 Repository intelligence | `repo-intel` | efficient | nothing | Kept |
| 3 UI/UX and visual | `ux-analyst` (static) and `web-runner` or `mobile-runner` (runtime) | strong / efficient | nothing / evidence | Split (G8) |
| 4 User flow and business logic | `flow-analyst` | strong | nothing | Kept |
| 5 RBAC and security | `rbac-analyst` (static) and `api-runner` (runtime probes) | strong | nothing / evidence | Split (G8) |
| 6 Strategy and documentation | `test-strategist` | strong | `qa-artifacts/` drafts | Kept |
| 7 Mock data and environment | `env-data` | efficient | QA-owned scripts and fixtures | Kept |
| 8 UI automation | `web-runner` (browser) and `mobile-runner` (mobile web and native) | efficient | tests it owns, evidence | Split by target |
| 9 API, backend and data | `api-runner` | efficient | tests it owns, evidence | Kept |
| 10 Integration and E2E | `e2e-runner` | efficient | tests it owns, evidence | Kept, serial |
| 11 Performance and reliability | `perf-runner` | efficient | evidence | Deferred to v0.6, opt-in (G21) |
| 12 Accessibility and compatibility | folded into `web-runner` and `mobile-runner` | efficient | evidence | Folded (G8) |
| 13 Defect triage | `triage` | strong | defect register | Kept, read-only on code |
| 14 Remediation and regression | not an agent: handoff packets and the orchestrator's `retest` action | n/a | handoff packets | Changed (G7) |

Strong-tier agents make the decisions that set outcomes: flows, RBAC, strategy, triage. Efficient-tier agents do repetitive work under a fixed plan. Any finding rated Critical gets an independent second review before it is reported.

### Ledger entities

- `requirements`: ID, text, source, `derived` flag, status.
- `journeys`: ID, priority P0, P1 or P2, steps, branches, roles, targets, oracle references.
- `expectations`: each expected result, with its oracle source.
- `targets`: `web`, `mobile-web`, `android`, `ios`, each with its tools, devices and probe result.
- `binaries`: native build records with version, build number and SHA-256 (M2).
- `testCases`: ID, suite, journey and requirement links, target, lane, data it needs, oracle, automation status.
- `runs`: test case ID, build ID, target, device, result, `double` or `live`, evidence paths, redaction check.
- `defects`: `DEF-###`, with the test cases that reproduce it. Duplicates merge on root cause.
- `decisions`: plan approval, accepted risks, authorization, each with the approver's name and a hash.
- `handoffs`: defect ID, owner (`backend-engineer` or `frontend-engineer`), acceptance criteria, retest test IDs.

Result states: `passed`, `failed`, `blocked`, `skipped`, `not-run`, `stale`, `flaky`. These are kept apart. A test that was implemented but not executed is `not-run`, not `passed`.

Defect states: `Detected`, `Confirmed`, `Triaged`, `Handed Off`, `Fix Claimed`, `Retest Passed`, `Regression Passed`, `Closed`. A developer's "fixed" moves a defect to `Fix Claimed` only. The skill closes a defect only after the retest and the regression run pass on the current build.

### Gates

A release gate is mandatory when it covers one of these:

- every P0 journey is `passed` on the current build, on every target in scope,
- every critical RBAC and cross-tenant case is `passed`,
- no open Critical or High defect,
- every native target in scope ran on a binary that matches the build handover, or is reported `blocked`,
- security probes ran, or the status says they did not run,
- the plan was approved, and the approval hash matches the plan.

Gate status follows the precedence in G19.

### Phases and checkpoints

0. Intake and safety: read `qa.config.json`, check the target allowlist, probe the environment, the browser, the Android and iOS tools, and the Figma connector. Record the build ID and binary identities. Checkpoint: safety passes, or the run stops.
1. Repository reconnaissance (`repo-intel`).
2. Flow, oracle and design discovery (`flow-analyst`, `ux-analyst`, `rbac-analyst`, in parallel). Design references come from the connector or exports, and `design-map.json` is confirmed with the tester.
3. Risk analysis, strategy and the mobile matrix (`test-strategist`).
4. **Checkpoint: plan approval.** The plan is frozen with a hash. Execution cannot start until the decision is recorded.
5. Environment preparation (`env-data`), in series: database, test accounts, devices and emulators, installed binaries.
6. Execution in waves. Read-only lanes run in parallel: `api-runner` reads, `web-runner` views, `mobile-runner` checks static binary data, accessibility scans. Mutating lanes run in series: `api-runner` writes, `e2e-runner`, and device journeys that change data.
7. Triage (`triage`): deduplicate, confirm, rank, write reproduction steps.
8. Handoff and retest: packets go to the builder agents. The skill retests by test ID and runs regression.
9. Final report and gate evaluation.

Critical findings are written to the defect register as soon as they are confirmed. They are not held for the end of the run.

### Stop conditions

- A safety check fails, or a target is outside the allowlist.
- The environment fails its health check twice.
- A lane's infrastructure failures exceed 30 percent (a default, configurable).
- A device or emulator disconnects during a mutating journey. The journey is stopped and recorded as infrastructure failure.
- A security probe finds a Critical issue. Mutating tests against that host stop, and the finding is reported.
- The run budget is exceeded.

## 6. How the fixtures test the skill

`fixtures/planted-app` is a small app: Node, SQLite, and a responsive HTML front end. `planted-android-config` holds only a manifest and configuration, so the static checks can run without building an APK. Each planted defect has an expected detector.

| # | Planted defect | Expected detector | Expected result |
| --- | --- | --- | --- |
| 1 | Button with no working handler | `web-runner` | Dead control defect |
| 2 | Form missing server-side validation | `api-runner` against the contract | Validation defect |
| 3 | Permission enforced only in the UI | `rbac-analyst` (hidden, not denied) and `api-runner` (direct call succeeds) | Authorization defect |
| 4 | Role reads another user's record | `api-runner` (object-level probe) | Critical access defect |
| 5 | Incomplete approval workflow | `flow-analyst` gap, then `e2e-runner` | Workflow defect |
| 6 | Transaction or concurrency defect | `api-runner` barrier test | Invariant violated |
| 7 | Response contract broken | `api-runner` against the OpenAPI document | Contract defect |
| 8 | Network failure with bad recovery | `web-runner` with request interception | Recovery defect |
| 9 | Responsive layout defect | `web-runner` and `mobile-runner` (mobile web) at each viewport | Layout defect |
| 10 | Form control with no accessible name | `web-runner` (axe and keyboard) | Accessibility defect |
| 11 | Flaky test from shared mutable data | Orchestrator flake rule (G23) | Classified `flaky`, not `passed` |
| 12 | Touch target below minimum size on mobile web | `mobile-runner` (mobile web) | Accessibility defect |
| 13 | Android manifest with `debuggable` set and cleartext traffic allowed | `mobile-runner` static check (M7) | Security defect |

The clean control runs the same suite. It must produce zero defects. A finding on the clean control is a false positive, and it blocks the release of the skill.

## 7. Build phases

| Version | Scope | Exit criteria |
| --- | --- | --- |
| v0.1 Foundation | Plugin skeleton and `SKILL.md` shell. Config and target allowlist. Ledger. Build ID, including binary identity. Intake and capability probes for web, Android, iOS and the Figma connector. `repo-intel`. Planted-app fixture and clean control. Marketplace entry added once it validates. | Safety refusals are tested: wrong host, wrong database, wrong bundle ID, missing authorization, production-like name. The planted app is mapped. |
| v0.2 Documentation and approval | `flow-analyst`, `ux-analyst`, `rbac-analyst`, `test-strategist`. Artifact files 00 to 11. Design references, with the Figma adapter when connected, and `design-map.json`. Plan approval with hash. | Every test case has an oracle. Requirement traceability validates. The plan hash changes when the plan changes. |
| v0.3 Backend execution | `env-data` (seed, reset, validate). `api-runner` and its security probes. Runtime RBAC probes. Concurrency lane. | Planted defects 2, 3, 4, 6 and 7 are reproduced. The clean control has zero findings. |
| v0.4 Web execution | `web-runner`. Golden paths. Responsive viewports. Accessibility scan. Redacted traces. | Planted defects 1, 8, 9 and 10 are found. A redaction test shows no cookies or tokens in stored evidence. |
| v0.5 Mobile execution | `mobile-runner`. Mobile web through device emulation in Chromium. Android and iOS through the tools the probes find. Native build identity. Mobile matrix. Previous-version compatibility. Static binary and configuration checks. | Planted defects 9 and 12 are found on mobile web, and 13 on the static check. Each native target either runs on an available device or is reported `blocked` with the reason. No native run passes against a binary that does not match the build handover. |
| v0.6 Remediation and performance | `triage`, handoff packets, retest by test ID, regression and stale-evidence tracking. `perf-runner`, opt-in with limits. | A fix is retested, and the defect closes only after the regression run passes. A stale run is reported as stale. |
| v1.0 Release | `e2e-runner` (cross-layer), final report, gate evaluation, self-test suite, README, marketplace entry, install scripts updated. | All 13 planted defects found, the clean control clean, and the self-tests pass. The report reproduces from the ledger. |

## 8. Risks

- **Scope creep.** The prompt asks for more than any single phase can deliver. Each phase has exit criteria, and v1.0 is not claimed until all of them hold.
- **Mobile coverage depends on the tester's devices.** This cloud environment can run mobile web, but not Android emulators or iOS simulators. Native results will show as `blocked` here, and that is the correct result, not a gap to hide.
- **Shared-state flakiness.** Parallel mutating runs will corrupt data if the lane rules are relaxed. The serial default protects against this.
- **Duplicate logic.** The copied ledger and fingerprint code can drift. The repo-level identity test catches it.
- **Oracle gaps.** Where a project has no requirements, most results will be `observed`, not PASS or FAIL. The report says so. It does not fill the gap with assumptions.
- **Untrusted design content.** Figma text and comments are read as data (F2). A malicious design file must not change the skill's behaviour.
- **Security probes against live systems.** Even on a test host, probes can trip lockouts or alerts. Probes stay non-destructive, bounded, and limited to the allowlist.

## 9. Next steps

1. **Approve the plan.** Reply "approve" to record the approval with your name and the plan's SHA-256. Until then, v0.1 does not start.
2. Decide D4 to D6. D4 is the approval itself. D5 and D6 change what can run, so they can be answered later, but the answers should be known before v0.3 and v0.5.
3. Build v0.1, including the planted-app fixture and the safety tests, before any agent prompts are written.
4. Add `e2e-engineer` to the marketplace and the installers once v0.1 validates.
5. Fix the `install.ps1` drift separately.
