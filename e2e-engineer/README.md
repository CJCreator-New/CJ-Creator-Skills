# e2e-engineer

End-to-end testing for an application, built from its user journeys. It discovers the screens, the API and the database, plans the journeys behind an approval gate, then verifies them through the browser, mobile web, native Android and iOS, the API and the data layer. It reports a release status from evidence, not from test counts.

**Version 0.3 (API and data checks).** Builds on v0.1 and v0.2:

- **Intake and safety.** The run is refused unless every target, host, package, bundle and database is on the config allowlist. Production-looking names are refused without an override. Security probes are refused unless authorization is recorded.
- **Build identity and tool readiness.** The commit and a fingerprint of the working tree. Native binaries are identified by their SHA-256. A target whose tools are missing is `blocked` with the reason. Nothing is installed.
- **Analysis and plan.** Four read-only analysts (`flow-analyst`, `rbac-analyst`, `ux-analyst`, `test-strategist`). A plan check, a freeze and an approval bound to the frozen digest. A change to any plan item makes the approval stale.
- **Artifact package.** Files 00 to 11 and five data files, rendered deterministically from the ledger. Coverage is reported as separate measures, with no combined percentage.
- **Test database control (`env.mjs`).** A test database is validated against its run marker before any write. It is seeded only when it has no tables, reset only when the config allows it, and refused when its marker names another database. Reset restores the seed and checks the row counts.
- **Executable checks (`checks.mjs`).** An api or db test case lists its checks: a request as a role, the status and the JSON it must return, concurrent requests with their invariant, or a read-only query. Credentials are environment-variable names, never values. A missing credential blocks; it does not fail.
- **API runner (`run-api.mjs`).** Runs the implemented api and db test cases against a target. Each mutating case starts from a fresh seed. Each run is recorded against the current build, and each confirmed failure opens one defect. A derived, unconfirmed requirement's failure is `needs-confirmation`, not a defect.
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
                                  backend verification, reporting and gates
agents/
  repo-intel.md                   maps the application (read-only)
  flow-analyst.md                 journeys, branches, requirements (read-only)
  rbac-analyst.md                 roles, permissions, outcomes per role (read-only)
  ux-analyst.md                   screens, controls, states, design references (read-only)
  test-strategist.md              test catalogue with oracles and checks (read-only)
  env-data.md                     prepares the test database (writes through env.mjs)
  api-runner.md                   runs the API and data checks (writes through run-api.mjs)
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

Run against the clean control, the API suite passes 10 of 10 with no defects. Run against the planted build, it fails six test cases, which are tied to planted defects 2, 3, 4, 5, 6 and 7. The tests that check behaviour the planted build gets right still pass (`TC-AUTH-01`, `TC-AUTH-02`, `TC-APR-01`, `TC-DB-01`). The gate reads FAIL for the planted build and PARTIALLY TESTED for the clean one, because the web and static tests have not run yet.

## Gate status

`BLOCKED`, `PARTIALLY TESTED`, `FAIL` and `PASS` follow the precedence in the plan (G19). `PASS WITH ACCEPTED RISKS` needs a named decision for each accepted item, and it arrives in a later version.

- `FAIL` when a test case's current run failed.
- `BLOCKED` until intake is allowed, the plan is frozen and approved, the approval matches the current plan, every target in scope is ready, and no P0 test case is blocked.
- `PARTIALLY TESTED` until every test case of every P0 journey has a current pass.
- `PASS` otherwise.

## Limits in v0.3

- The analysts are prompts. Their output on a real repository has not been run here. The worked plan is hand-written in the shape they return.
- Only api and db test cases run. The web, mobile and static test cases remain `planned` until v0.4 and v0.5.
- The guard is a workflow guard, not a sandbox. It checks tool writes, not shell commands, so a shell redirection can still write a file it does not name.
- A failure is not yet triaged. Every defect is `unassigned` until the triage phase (v0.6).
- Test 11 in the fixture is a property of a sample test suite, which is added in v0.6.
- Flakiness is not measured. A test that passes and fails on the same tree is not yet classified as `flaky`.
- Security probes are gated by the recorded authorization. The fixture has none, so its probes are refused. No probe is in the worked plan yet.
- Approval records the approver as the name or identifier the user gives. The plan does not verify who they are.
