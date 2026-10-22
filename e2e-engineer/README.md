# e2e-engineer

End-to-end testing for an application, built from its user journeys. It discovers the screens, the API and the database, plans the journeys behind an approval gate, then verifies them through the browser, mobile web, native Android and iOS, the API and the data layer. It reports a release status from evidence, not from test counts.

**Version 1.1.** What it does:

- **Intake and safety.** The run is refused unless every target, host, package, bundle and database is on the config allowlist. Production-looking names are refused without an override. Security probes are refused unless authorization is recorded.
- **Build identity and tool readiness.** The commit and a fingerprint of the working tree. Native binaries, including simulator `.app` bundles, are identified by their SHA-256. A target whose tools are missing is `blocked` with the reason. Nothing is installed.
- **Target lifecycle (`target.mjs`).** Starts the app with the config's `start` command and waits for `healthUrl`, checks health, and stops it. Without `start` or `healthUrl`, a web target is blocked: the skill does not guess. It adds the state folder to the target's `.gitignore` only when the user agrees.
- **Stop conditions (`stops.mjs`).** A run stops, and the gate reads BLOCKED with the reason, when the environment fails its health check twice, over 30% of a lane fails on infrastructure, a device disconnects during a mutating journey, a security probe fails (mutating test cases stop), or the run budget in minutes, runs or reported tokens is spent.
- **Evidence retention (`evidence.mjs`).** After each run, the oldest evidence folders are removed beyond the cap, except what a current run or an open defect points to. Each removal is in the report.
- **Model routing and telemetry (`route.mjs`, `telemetry.mjs`).** Copies of backend-engineer's, checked for identity. The skill dispatches each agent with the tier `route.mjs` returns, and the run budget reads the telemetry.
- **Analysis and plan.** Read-only analysts, dispatched in order: `ux-analyst`, `flow-analyst`, `rbac-analyst`, `test-strategist`, each with the ids the earlier ones produced. A plan check, a freeze and an approval bound to the frozen digest. A change to any plan item makes the approval stale. The analysts were trialled on an unfamiliar copy of the fixture app; see `docs/e2e-engineer-analyst-trial.md`.
- **Artifact package.** Files 00 to 11 and five data files, rendered deterministically from the ledger. Coverage is reported as separate measures, with no combined percentage.
- **Test database control (`env.mjs`).** A test database is validated against its run marker before any write. It is seeded only when it has no tables, reset only when the config allows it, and refused when its marker names another database. Reset restores the seed and checks the row counts.
- **Executable checks (`checks.mjs`).** An api or db test case lists its checks: a request as a role, the status and the JSON it must return, concurrent requests with their invariant, or a read-only query. Credentials are environment-variable names, never values. A missing credential blocks; it does not fail.
- **Security probes.** Presets for a tampered session, a missing session, injection markers, rate limiting and CORS, non-destructive and bounded, only with a recorded authorization. A failed probe stops the mutating test cases that follow.
- **API runner (`run-api.mjs`).** Runs the implemented api and db test cases against a target. Each mutating case starts from a fresh seed. Each run is recorded against the current build, and each confirmed failure opens one defect. A derived, unconfirmed requirement's failure is `needs-confirmation`, not a defect.
- **Browser runner (`run-web.mjs`).** Drives the web and mobile-web test cases in Chromium, through the interface only: each control is found by its role, name or label, and the database is reset before each test case. Steps cover sign-in, fills, clicks, downloads, intercepted failures, viewport clipping, touch-target size, keyboard reach, the full axe-core scan (when the repository provides axe-core), and a pixel comparison with a design reference. Each test case runs on a fixed clock and time zone when the config sets them, and stores a screenshot and a redacted log.
- **Redaction (`redact.mjs`).** Every stored value is redacted before it is written: credential headers, credential keys at any depth, bearer and token-shaped strings, and every password value the run was given. Playwright traces are not stored, because they carry credentials that cannot be reliably removed.
- **Cross-layer runner (`run-e2e.mjs`, `e2e-runner` agent).** An e2e test case acts in the UI, waits for the request the UI sends and checks its status, then checks the API and the stored data in the same test case. The failing step names the layer that disagrees.
- **Mobile checks (`run-mobile.mjs`).** Static checks read the Android project's manifest and resources, with no device: a debuggable application or a hardcoded secret fails, and a secret is reported by its file and name, never by its value. Native Android and iOS cases run Maestro flows on every device in the device matrix, install the build (Android `adb`, iOS simulator `simctl`), run previous-version compatibility (the last release, then the new build over it), read the Android accessibility tree, and store a screenshot and a redacted log from each device. Each native run uses the binary recorded in the ledger, and that binary must match the build handover hash in the config. A missing device, tool, binary, flow or mismatch blocks the case, with the reason; a device lost mid-journey stops the run.
- **Triage and handoff (`remediation.mjs`, `triage` agent).** Each defect gets a severity, an owner, a root cause and a disposition (the app or the test). A defect on a requirement tagged with a risk (another tenant's data, an auth bypass, exposed or lost data, money) is Critical; one on a P0 journey or an access-control case is at least High; and a Critical defect needs an independent second review. Duplicates merge. A handoff packet gives the owner the requirement, the reproduction, what was observed, the acceptance criteria and the regression set, with no credential in it. The skill never writes the fix.
- **Retest and regression (`retest.mjs`).** Test cases run by ID, through the runner for each layer. A fix is a new build. A defect moves to Retest Passed when its own test cases pass on that build, and closes only after its regression set passes there too. A failure first seen on the fixed build is a regression and keeps the defect open; a failure that an earlier defect already covers does not.
- **Flaky and stale results.** A test case that passed and failed on the same build is `flaky`, never passed, and opens no defect on its own. A run from an earlier build, or from before the test case changed, is `stale`.
- **Load (`run-perf.mjs`, `perf-runner` agent).** Opt-in, read-only load with a fixed number of users, a fixed time and a capped rate. It refuses to start without `loadLimits` in the config and `E2E_ALLOW_LOAD=1` for the run. A threshold the team has not confirmed is proposed, so a breach of it is `needs-confirmation`.
- **Doubles and live integrations.** A test case that names integrations runs against doubles unless each is live in the config, with a sandbox on the allowlist. Each run records its mode, and a pass against a double is never reported as a live pass.
- **Scope.** A test case the plan takes out of scope (`outOfScope`, with the reason) is not run and does not count toward the gate. The status and the report list it with its reason.
- **Gate.** A P0 journey is verified only when every in-scope test case linked to it has a current pass. An open Critical or High defect is a FAIL until it closes, and any open defect keeps the gate from PASS. A named person can accept the risk of one open defect, with the reason; the gate then reads PASS WITH ACCEPTED RISKS. Precedence: FAIL, then BLOCKED, then PARTIALLY TESTED, then PASS WITH ACCEPTED RISKS or PASS.
- **Final report.** Files 00 to 11 and the data files, with a manifest of the ledger hash and each file's hash. `artifacts.mjs verify` renders the package again from the ledger and reports any difference.
- **Self-test (`self-test.mjs`).** Runs the plugin on its own fixture through the same intake, runners, ledger and report a real run uses. It scores recall on the 13 planted defects, requires no finding on the clean control, and says which suites ran.
- **Guard.** While a run is active, a write is allowed only under `.claude/e2e-engineer/`, by a file tool or a shell command (redirections, tee, in-place edits, file commands); git changes and package installs are denied; the ledger is never written by a tool; secret files are never written; and the analysts are read-only.
- **Planted-app fixture.** A small order-approval app on SQLite, with 11 switchable app-side defects, and a clean control (`PLANTED=none`). The worked plan has 17 requirements, 10 journeys and 26 test cases, all implemented, with security probes and a keyboard check; the two native cases are out of scope for this release. `flaky-cases.json` adds the two test cases that show planted defect 11. The manifest names the test cases that detect each planted defect.

The full plan is in `docs/e2e-engineer-plan.md`, and the approval of that plan is in `docs/e2e-engineer-approval.json`. The approvals of the fixture's test plan are in `docs/e2e-engineer-run-plan-approval.json`.

## Layout

```
.claude-plugin/plugin.json        manifest
hooks/
  hooks.json                      PreToolUse guard for Write, Edit, MultiEdit, NotebookEdit and Bash
  guard.mjs                       the guard: inert unless a run is active
skills/e2e-engineer/SKILL.md      the skill: the v1.0 steps
skills/e2e-engineer/references/   discovery and oracles, design references, strategy and approval,
                                  backend verification, web verification, mobile verification,
                                  triage and retest, performance, reporting and gates
agents/
  repo-intel.md                   maps the application (read-only)
  flow-analyst.md                 journeys, branches, requirements (read-only)
  rbac-analyst.md                 roles, permissions, outcomes per role (read-only)
  ux-analyst.md                   screens, controls, states, design references (read-only)
  test-strategist.md              test catalogue with oracles and checks (read-only)
  env-data.md                     prepares the test database (writes through env.mjs)
  api-runner.md                   runs the API and data checks (writes through run-api.mjs)
  web-runner.md                   drives the browser (writes through run-web.mjs)
  mobile-runner.md                runs the static and native mobile checks (writes through run-mobile.mjs)
  e2e-runner.md                   runs the cross-layer test cases (writes through run-e2e.mjs)
  perf-runner.md                  runs opt-in, bounded load (writes through run-perf.mjs)
  triage.md                       severity, owner, root cause, duplicates, flaky causes (read-only)
scripts/
  intake.mjs                      intake: safety, build identity, probes, ledger, active marker
  target.mjs                      start, health check and stop of the target; the consented .gitignore line
  stops.mjs                       stop conditions: health, infrastructure rate, lost device, failed probe, budget
  evidence.mjs                    evidence retention cap, keeping current and open-defect evidence
  route.mjs                       model tier per dispatch (copy of backend-engineer's)
  telemetry.mjs                   stage timings, dispatches and reported tokens (copy of backend-engineer's)
  safety.mjs                      target allowlist, production refusal, authorization, reset rules
  probe.mjs                       tool and device readiness, per target
  binary.mjs                      SHA-256 identity of APK, AAB and IPA files
  ledger.mjs                      run state, plan items, freeze, approval, runs, defects, triage, handoff,
                                  claim, gate status, finish
  results.mjs                     test case state from its runs: passed, failed, flaky, stale; selection by ID
  remediation.mjs                 defect lifecycle: triage, review, merge, handoff packet, claim, retest and
                                  regression evaluation
  retest.mjs                      runs test cases by ID, or a defect's retest or regression set
  run-e2e.mjs                     runs the cross-layer test cases in Chromium and records them
  run-perf.mjs                    runs the perf test cases and records the results
  self-test.mjs                   scores the plugin on its fixture: recall, clean control, flaky, report
  load.mjs                        load checks: validation, the two locks, the rate-capped load, thresholds
  plan.mjs                        plan digest, item checks, freeze, approval
  traceability.mjs                plan check: errors, gaps, warnings, coverage
  checks.mjs                      check kinds, their validation, and the runner
  env.mjs                         validate, seed and reset the test database
  run-api.mjs                     runs the api and db test cases and records the results
  run-web.mjs                     drives the web and mobile-web test cases in Chromium and records them
  run-mobile.mjs                  runs the static and native mobile test cases and records them
  native.mjs                      static checks on the Android project, and Maestro flow checks with the build-handover check
  web-steps.mjs                   the step vocabulary for browser test cases, checked at plan time
  browser.mjs                     finds Playwright in the repository, or at the configured path; never installs it
  redact.mjs                      redaction of credentials, tokens and cookies from stored values
  design.mjs                      design source resolution and the design map
  artifacts.mjs                   renders files 00 to 11, data/*.json and the report manifest; verify
  fingerprint.mjs                 copy of backend-engineer's, checked for identity
  validate.mjs                    structure check for the plugin, its hooks, its marketplace entry and the fixture plan
templates/qa.config.example.json
fixtures/planted-app/             server.mjs (SQLite), schema.sql, seed.json, public/index.html,
                                  openapi.json, manifest.json (the defect list), plan.json (the worked plan),
                                  flaky-cases.json (planted defect 11)
fixtures/planted-android-config/  planted static-check defect (13)
fixtures/clean-android-config/    its clean control
test/                             node:test suites
```

## Run

No dependencies are installed. Node 22.13 or later is needed, because the database uses the built-in `node:sqlite`, which prints an experimental warning.

```bash
# Intake for a repository, using its qa.config.json
node e2e-engineer/scripts/intake.mjs qa.config.json --root .

# Plan: load it, freeze it, then approve it once the user has approved it
node e2e-engineer/scripts/ledger.mjs load    .claude/e2e-engineer/ledger.json plan.json
node e2e-engineer/scripts/ledger.mjs freeze  .claude/e2e-engineer/ledger.json
node e2e-engineer/scripts/ledger.mjs approve .claude/e2e-engineer/ledger.json --approver <name>

# Test database: validate, seed (once), and reset (between runs)
node e2e-engineer/scripts/env.mjs validate qa.config.json --root .
node e2e-engineer/scripts/env.mjs seed     qa.config.json --root .

# Mobile: static checks on the Android project, and native flows on a device or simulator
node e2e-engineer/scripts/run-mobile.mjs .claude/e2e-engineer/ledger.json qa.config.json --root .

# Run the API and data checks against a running target
node e2e-engineer/scripts/run-api.mjs .claude/e2e-engineer/ledger.json qa.config.json --root . --base http://127.0.0.1:4173

# Remediation: triage, hand off, record the claim; after the fixed build is deployed and intake has
# run again, retest the defect, then run its regression set
node e2e-engineer/scripts/ledger.mjs triage  .claude/e2e-engineer/ledger.json DEF-001 --severity High --owner backend-engineer --root-cause "<one sentence>" --by <name>
node e2e-engineer/scripts/ledger.mjs handoff .claude/e2e-engineer/ledger.json DEF-001
node e2e-engineer/scripts/ledger.mjs claim   .claude/e2e-engineer/ledger.json DEF-001 --by backend-engineer
node e2e-engineer/scripts/retest.mjs .claude/e2e-engineer/ledger.json qa.config.json --root . --defect DEF-001
node e2e-engineer/scripts/retest.mjs .claude/e2e-engineer/ledger.json qa.config.json --root . --defect DEF-001 --regression
node e2e-engineer/scripts/ledger.mjs defects .claude/e2e-engineer/ledger.json

# Opt-in load, within config.loadLimits
E2E_ALLOW_LOAD=1 node e2e-engineer/scripts/run-perf.mjs .claude/e2e-engineer/ledger.json qa.config.json --root . --base http://127.0.0.1:4173

# Cross-layer test cases: act in the UI, then check the API and the data
node e2e-engineer/scripts/run-e2e.mjs .claude/e2e-engineer/ledger.json qa.config.json --root .

# Release with an open defect only on a named person's decision
node e2e-engineer/scripts/ledger.mjs accept .claude/e2e-engineer/ledger.json DEF-001 --by <name> --reason "<why>"

# Final report, and the check that it reproduces from the ledger
node e2e-engineer/scripts/artifacts.mjs        .claude/e2e-engineer/ledger.json qa-artifacts
node e2e-engineer/scripts/artifacts.mjs verify .claude/e2e-engineer/ledger.json qa-artifacts

# Gate status, then finish the run (removes the active marker)
node e2e-engineer/scripts/ledger.mjs status .claude/e2e-engineer/ledger.json
node e2e-engineer/scripts/ledger.mjs finish .claude/e2e-engineer/ledger.json

# The fixture, with its planted defects or as the clean control
DB_FILE=<seeded.sqlite> PLANTED=all  node e2e-engineer/fixtures/planted-app/server.mjs
DB_FILE=<seeded.sqlite> PLANTED=none node e2e-engineer/fixtures/planted-app/server.mjs

# Tests, structure check, and the self-test (add --isolate to switch on each defect alone)
node --test e2e-engineer/test/*.test.mjs tests/e2e-engineer-identity.test.mjs
node e2e-engineer/scripts/validate.mjs
node e2e-engineer/scripts/self-test.mjs --playwright <path to the playwright module>
```

The run state lives in `.claude/e2e-engineer/` in the target repository. The plugin adds that folder to the target's `.gitignore` only with consent.

## What the fixture shows

Measured with the command-line sequence above, on the fixture plan at digest `8af7a30e`, with the probes authorized against the fixture server:

- **Clean control** (`PLANTED=none`, `clean-android-config`): API 12 of 12 (including the two security probe cases), browser 9 of 9, cross-layer 2 of 2, static 1 of 1. No defect is opened. The gate reads **PASS**, with TC-AND-01 and TC-IOS-01 listed as out of scope.
- **Planted build** (`PLANTED=all`, `planted-android-config`): 14 defects are opened, and the gate reads FAIL. The API suite finds planted defects 2, 3, 4, 5, 6 and 7; the browser suite finds 1, 8, 9, 10 and 12 (TC-UI-08 also fails, on defects 2 and 10); the cross-layer TC-E2E-01 finds 5 through the UI, at the request the page sends (`200, expected 403`); the static check finds 13. The report renders and verifies against the ledger.
- **Self-test** (`self-test.mjs` with Chromium): verdict **pass**, 13 of 13 planted defects, no finding on the clean control, no unexplained failure on the planted build, defect 11 classified flaky, and the report reproduces. With `--isolate`, each defect switched on alone fails exactly the test cases the manifest names. Without Chromium, the verdict is `incomplete`: 8 of 13, with the browser suites named as not run.
- **Remediation** (v0.6, measured then): DEF-006, the cross-tenant read, was triaged High (Medium is refused on a P0 journey), handed off, claimed, retested on a new build, and closed by its regression run. Results from the earlier build were reported as stale.

## Gate status

The five statuses follow the precedence in the plan (G19).

- `FAIL` when an in-scope test case's current run failed, or a Critical or High defect is open.
- `BLOCKED` until intake is allowed, the plan is frozen and approved, the approval matches the current plan, every target in scope is ready, and no P0 test case is blocked.
- `PARTIALLY TESTED` until every in-scope test case has a current pass and no defect is open. Flaky, stale, not-run and needs-confirmation results keep it here.
- `PASS WITH ACCEPTED RISKS` when the only open defects have a named risk acceptance, each with its person and reason.
- `PASS` otherwise.

## Limits in v1.0

- The analysts are prompts. In a trial on an unfamiliar copy of the fixture app (`docs/e2e-engineer-analyst-trial.md`), they reported all 12 app-side planted defects, and in order their output loaded with 3 plan-check errors; the last prompt changes from that trial are not re-trialled. The worked plan is still hand-written in the shape they return.
- No emulator or simulator runs in this environment, so the device matrix, compatibility, device evidence and the Android accessibility tree are tested with a stand-in command runner, not on a device. The iOS accessibility tree needs XCUITest and is not checked.
- The fixture is a web app, so it has no native build. The native flow in the fixture is an example of the shape, and it cannot run here. The plan takes the native cases out of scope for this release (the user's decision, with D6 open), and the device path is covered by tests that inject a fake command runner.
- Playwright is not installed by the plugin. It comes from the target repository, or from `browser.playwrightModule` in the config. Without it, the web targets are blocked, with the reason.
- The full accessibility scan needs axe-core in the target repository, or `browser.axeModule`. Without it, the built-in rules (form-field names, button names) and the keyboard check still run.
- The design comparison is pixel by pixel. It needs the same viewport, data and clock as the reference.
- The guard is a workflow guard, not a sandbox. It reads shell commands as text, so a program that writes files itself (a script, `node -e`) is not seen.
- Triage is a prompt. The severity floor, the second review for Critical and the state rules are enforced by the ledger; the judgement inside them is the agent's and the user's.
- A fix must arrive as a new build. A fix made only in the environment, on the same tree, shows as flaky and does not close the defect.
- The regression set is the defect's journeys plus the P0 journeys. Test cases elsewhere are not rerun before a defect closes.
- Load is client-side, read-only and small: no stress, soak or spike profiles, no load on writes, and no server-side metrics.
- The self-test approves the fixture plan in its own scenario ledgers, as `e2e-engineer self-test (fixture plan)`. That approval covers the fixture only, never a user's repository.
- Native self-tests do not run here: no emulator or simulator exists in this environment (M10). The static check runs everywhere.
- Security probes are gated by the recorded authorization. A config without one, such as the example, refuses them. The self-test authorizes probes against the fixture server it starts itself.
- Approval records the approver as the name or identifier the user gives. The plan does not verify who they are.
