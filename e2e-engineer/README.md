# e2e-engineer

End-to-end testing for an application, built from its user journeys. It discovers the screens, the API and the database, plans the journeys behind an approval gate, then verifies them through the browser, mobile web, native Android and iOS, the API and the data layer. It reports a release status from evidence, not from test counts.

**Version 0.5 (mobile checks).** Builds on v0.1 to v0.4:

- **Intake and safety.** The run is refused unless every target, host, package, bundle and database is on the config allowlist. Production-looking names are refused without an override. Security probes are refused unless authorization is recorded.
- **Build identity and tool readiness.** The commit and a fingerprint of the working tree. Native binaries are identified by their SHA-256. A target whose tools are missing is `blocked` with the reason. Nothing is installed.
- **Analysis and plan.** Four read-only analysts (`flow-analyst`, `rbac-analyst`, `ux-analyst`, `test-strategist`). A plan check, a freeze and an approval bound to the frozen digest. A change to any plan item makes the approval stale.
- **Artifact package.** Files 00 to 11 and five data files, rendered deterministically from the ledger. Coverage is reported as separate measures, with no combined percentage.
- **Test database control (`env.mjs`).** A test database is validated against its run marker before any write. It is seeded only when it has no tables, reset only when the config allows it, and refused when its marker names another database. Reset restores the seed and checks the row counts.
- **Executable checks (`checks.mjs`).** An api or db test case lists its checks: a request as a role, the status and the JSON it must return, concurrent requests with their invariant, or a read-only query. Credentials are environment-variable names, never values. A missing credential blocks; it does not fail.
- **API runner (`run-api.mjs`).** Runs the implemented api and db test cases against a target. Each mutating case starts from a fresh seed. Each run is recorded against the current build, and each confirmed failure opens one defect. A derived, unconfirmed requirement's failure is `needs-confirmation`, not a defect.
- **Browser runner (`run-web.mjs`).** Drives the web and mobile-web test cases in Chromium, through the interface only: each control is found by its role, name or label, and the database is reset before each test case. Steps cover sign-in, fills, clicks, downloads, intercepted failures, viewport clipping, touch-target size and a built-in accessibility scan. Each test case stores a screenshot and a redacted log.
- **Redaction (`redact.mjs`).** Every stored value is redacted before it is written: credential headers, credential keys at any depth, bearer and token-shaped strings, and every password value the run was given. Playwright traces are not stored, because they carry credentials that cannot be reliably removed.
- **Mobile checks (`run-mobile.mjs`).** Static checks read the Android project's manifest and resources, with no device: a debuggable application or a hardcoded secret fails, and a secret is reported by its file and name, never by its value. Native Android and iOS cases run Maestro flows on an attached device or simulator. Each native run uses the binary recorded in the ledger, and that binary must match the build handover hash in the config. A missing device, tool, binary, flow or mismatch blocks the case, with the reason.
- **Gate.** A P0 journey is verified only when every test case linked to it has a current pass. A run from an earlier build is stale. Precedence: FAIL, then BLOCKED, then PARTIALLY TESTED, then PASS.
- **Guard.** While a run is active, a write is allowed only under `.claude/e2e-engineer/`, the ledger is never written by a tool, secret files are never written, and the analysts are read-only.
- **Planted-app fixture.** A small order-approval app on SQLite, with 11 switchable app-side defects, and a clean control (`PLANTED=none`). The worked plan has 15 requirements, 9 journeys and 18 test cases, of which 10 are implemented as executable checks.

It does not yet drive a browser or a device, run static checks, or triage defects. Those come in later versions. The full plan is in `docs/e2e-engineer-plan.md`, and the approval of that plan is in `docs/e2e-engineer-approval.json`.

## Layout

```
.claude-plugin/plugin.json        manifest
hooks/
  hooks.json                      PreToolUse guard for Write, Edit, MultiEdit, NotebookEdit
  guard.mjs                       the guard: inert unless a run is active
skills/e2e-engineer/SKILL.md      the skill: the v0.3 steps
skills/e2e-engineer/references/   discovery and oracles, design references, strategy and approval,
                                  backend verification, web verification, mobile verification, reporting and gates
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
scripts/
  intake.mjs                      intake: safety, build identity, probes, ledger, active marker
  safety.mjs                      target allowlist, production refusal, authorization, reset rules
  probe.mjs                       tool and device readiness, per target
  binary.mjs                      SHA-256 identity of APK, AAB and IPA files
  ledger.mjs                      run state, plan items, freeze, approval, runs, defects, gate status, finish
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
  artifacts.mjs                   renders files 00 to 11 and data/*.json
  fingerprint.mjs                 copy of backend-engineer's, checked for identity
  validate.mjs                    structure check for the plugin, its hooks, its marketplace entry and the fixture plan
templates/qa.config.example.json
fixtures/planted-app/             server.mjs (SQLite), schema.sql, seed.json, public/index.html,
                                  openapi.json, manifest.json (the defect list), plan.json (the worked plan)
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

# Gate status, then finish the run (removes the active marker)
node e2e-engineer/scripts/ledger.mjs status .claude/e2e-engineer/ledger.json
node e2e-engineer/scripts/ledger.mjs finish .claude/e2e-engineer/ledger.json

# The fixture, with its planted defects or as the clean control
DB_FILE=<seeded.sqlite> PLANTED=all  node e2e-engineer/fixtures/planted-app/server.mjs
DB_FILE=<seeded.sqlite> PLANTED=none node e2e-engineer/fixtures/planted-app/server.mjs

# Tests and structure check
node --test e2e-engineer/test/*.test.mjs tests/e2e-engineer-identity.test.mjs
node e2e-engineer/scripts/validate.mjs
```

The run state lives in `.claude/e2e-engineer/` in the target repository. The plugin adds that folder to the target's `.gitignore` only with consent.

## What the fixture shows

Run against the clean control, the API suite passes 10 of 10 and the browser suite passes 8 of 8, with no defects. Run against the planted build, the browser suite finds planted defects 1, 8, 9 and 10 (the dead Export button, the failed approval shown as a success, the clipped table, and the unlabelled Total field). The API suite finds 2, 3, 4, 5, 6 and 7. Defect 12 is seen but is not a defect while REQ-UI-004 is unconfirmed. On the clean control every implemented test passes, and the gate reads PARTIALLY TESTED with one reason, `TC-SEC-01 not run`: the static check is still planned for v0.5. The gate reads PASS only once every planned test case has a current pass.

## Gate status

`BLOCKED`, `PARTIALLY TESTED`, `FAIL` and `PASS` follow the precedence in the plan (G19). `PASS WITH ACCEPTED RISKS` needs a named decision for each accepted item, and it arrives in a later version.

- `FAIL` when a test case's current run failed.
- `BLOCKED` until intake is allowed, the plan is frozen and approved, the approval matches the current plan, every target in scope is ready, and no P0 test case is blocked.
- `PARTIALLY TESTED` until every test case of every P0 journey has a current pass.
- `PASS` otherwise.

## Limits in v0.5

- The analysts are prompts. Their output on a real repository has not been run here. The worked plan is hand-written in the shape they return.
- Previous-version compatibility, the platform accessibility tree, and the device matrix are not run yet. They need more devices and tools than this version uses.
- iOS flows run only on a simulator where the app is already installed. The runner installs Android binaries only.
- The fixture is a web app, so it has no native build. The native flow in the fixture is an example of the shape, and it cannot run here. Native cases on the fixture are blocked, with the reason, and the device path is covered by tests that inject a fake command runner.
- Playwright is not installed by the plugin. It comes from the target repository, or from `browser.playwrightModule` in the config. Without it, the web targets are blocked, with the reason.
- The built-in accessibility rules are limited to form-field names and button names. A fuller scan is a later addition.
- The guard is a workflow guard, not a sandbox. It checks tool writes, not shell commands, so a shell redirection can still write a file it does not name.
- A failure is not yet triaged. Every defect is `unassigned` until the triage phase (v0.6).
- Test 11 in the fixture is a property of a sample test suite, which is added in v0.6.
- Flakiness is not measured. A test that passes and fails on the same tree is not yet classified as `flaky`.
- Security probes are gated by the recorded authorization. The fixture has none, so its probes are refused. No probe is in the worked plan yet.
- Approval records the approver as the name or identifier the user gives. The plan does not verify who they are.
