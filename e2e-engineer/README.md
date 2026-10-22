# e2e-engineer

End-to-end testing for an application, built from its user journeys. It discovers the screens, the API and the database, plans the journeys behind an approval gate, then verifies them through the browser, mobile web, native Android and iOS, the API and the data layer. It reports a release status from evidence, not from test counts.

**Version 0.2 (analysis, plan and artifacts).** Builds on the v0.1 foundation:

- **Intake and safety.** The run is refused unless every target, host, package, bundle and database is on the config allowlist. Production-looking names are refused without an override. Security probes are refused unless authorization is recorded.
- **Build identity.** The commit and a fingerprint of the working tree. Native binaries are identified by their SHA-256, computed by the ledger.
- **Tool readiness.** A browser, Android tools, iOS tools and an automation tool are each probed. A target whose tools are missing is `blocked` with the reason. Nothing is installed.
- **Analysis.** Four read-only analysts: `flow-analyst` (journeys), `rbac-analyst` (roles and permissions), `ux-analyst` (screens, controls, design references) and `test-strategist` (the test catalogue, with an oracle for every test case).
- **Plan check, freeze and approval.** A plan with errors cannot be frozen. The approval binds to the frozen digest. A change to any plan item makes the approval stale.
- **Artifact package.** Files 00 to 11 and five data files, rendered deterministically from the ledger. Coverage is reported as separate measures, with no combined percentage. No credential value is ever written.
- **Design references.** A connected Figma connector is used first. Otherwise exported images, then design tokens, then none. With none, visual parity is reported as not performed.
- **Planted-app fixture.** A small order-approval app with 11 switchable app-side defects, and a clean control (`PLANTED=none`). A worked plan for it covers 15 requirements, 9 journeys and 18 test cases, with deliberate warnings and gaps. Two Android configuration fixtures cover the static check.

It does not yet run tests, drive a browser or a device, or triage defects. Those come in later versions. The full plan is in `docs/e2e-engineer-plan.md`, and the approval of that plan is recorded in `docs/e2e-engineer-approval.json`.

## Layout

```
.claude-plugin/plugin.json        manifest
skills/e2e-engineer/SKILL.md      the skill: the v0.2 steps
skills/e2e-engineer/references/   discovery and oracles, design references, strategy and approval, reporting and gates
agents/
  repo-intel.md                   maps the application (read-only)
  flow-analyst.md                 journeys, branches, requirements (read-only)
  rbac-analyst.md                 roles, permissions, outcomes per role (read-only)
  ux-analyst.md                   screens, controls, states, design references (read-only)
  test-strategist.md              test catalogue with oracles (read-only)
scripts/
  intake.mjs                      intake: safety, build identity, probes, ledger
  safety.mjs                      target allowlist, production refusal, authorization, reset rules
  probe.mjs                       tool and device readiness, per target
  binary.mjs                      SHA-256 identity of APK, AAB and IPA files
  ledger.mjs                      run state, plan items, freeze, approval, binaries, gate status
  plan.mjs                        plan digest, item checks, freeze, approval
  traceability.mjs               plan check: errors, gaps, warnings, coverage
  design.mjs                      design source resolution and the design map
  artifacts.mjs                   renders files 00 to 11 and data/*.json
  fingerprint.mjs                 copy of backend-engineer's, checked for identity
  validate.mjs                    structure check for the plugin, its marketplace entry and the fixture plan
templates/qa.config.example.json
fixtures/planted-app/             the app, its OpenAPI contract, manifest.json (the defect list), plan.json (a worked plan)
fixtures/planted-android-config/  planted static-check defect (13)
fixtures/clean-android-config/    its clean control
test/                             node:test suites
```

## Run

No dependencies are installed. Node 22 or later is needed.

```bash
# Intake for a repository, using its qa.config.json
node e2e-engineer/scripts/intake.mjs qa.config.json --root .

# Plan: load a plan, or add one item at a time, then freeze it
node e2e-engineer/scripts/ledger.mjs load  .claude/e2e-engineer/ledger.json plan.json
node e2e-engineer/scripts/ledger.mjs add   .claude/e2e-engineer/ledger.json journey item.json
node e2e-engineer/scripts/ledger.mjs design .claude/e2e-engineer/ledger.json design-map.json
node e2e-engineer/scripts/ledger.mjs freeze .claude/e2e-engineer/ledger.json

# Artifacts for review
node e2e-engineer/scripts/artifacts.mjs .claude/e2e-engineer/ledger.json out/

# Approval, only after the user has approved the frozen plan, then the gate status
node e2e-engineer/scripts/ledger.mjs approve .claude/e2e-engineer/ledger.json --approver <name>
node e2e-engineer/scripts/ledger.mjs status  .claude/e2e-engineer/ledger.json

# Start the fixture with its planted defects, or as the clean control
PLANTED=all  node e2e-engineer/fixtures/planted-app/server.mjs
PLANTED=none node e2e-engineer/fixtures/planted-app/server.mjs

# Tests and structure check
node --test e2e-engineer/test/*.test.mjs tests/e2e-engineer-identity.test.mjs
node e2e-engineer/scripts/validate.mjs
```

The run state lives in `.claude/e2e-engineer/` in the target repository. The plugin adds that folder to the target's `.gitignore` only with consent.

## Gate status

`BLOCKED`, `PARTIALLY TESTED`, `FAIL` and `PASS` follow the precedence in the plan (G19). `PASS WITH ACCEPTED RISKS` needs a named decision for each accepted item, and it arrives in a later version.

- `BLOCKED` until intake is allowed, the plan is frozen and approved, the approval matches the current plan, and every target in scope is ready.
- `PARTIALLY TESTED` until every P0 journey has a passing run.
- `FAIL` when any run has failed.

## Limits in v0.2

- The analysts are prompts. Their output on a real repository has not been run here. The worked plan for the fixture is hand-written in the shape they return.
- No test is executed. Every test case is `planned`, so no run can pass.
- The hooks that stop the skill writing to application source come with the first phase that writes to a target (v0.3).
- The database run-marker check and reset are v0.3. The `db` test case in the fixture plan is recorded but has no target to run against yet.
- Browser and device runs are v0.4 and v0.5. The fixture's browser-only defects (1, 8, 9, 10, 12) are wired into the code, but nothing drives a browser against them until v0.4 and v0.5.
- The Figma connector is checked at intake by the skill, not by a script.
- Test 11 in the fixture is a property of a sample test suite, which is added in v0.3.
- Approval records the approver as the name or identifier the user gives. The plan does not verify who they are.
