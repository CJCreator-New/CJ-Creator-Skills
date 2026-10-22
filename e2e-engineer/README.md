# e2e-engineer

End-to-end testing for an application, built from its user journeys. It discovers the screens, the API and the database, plans the journeys behind an approval gate, then verifies them through the browser, mobile web, native Android and iOS, the API and the data layer. It reports a release status from evidence, not from test counts.

**Version 0.1 (foundation).** It sets up what every later phase depends on:

- **Intake and safety.** The run is refused unless every target, host, package, bundle and database is on the config allowlist. Production-looking names are refused without an override. Security probes are refused unless authorization is recorded.
- **Build identity.** The commit and a fingerprint of the working tree. Native binaries are identified by their SHA-256, computed by the ledger.
- **Tool readiness.** A browser, Android tools, iOS tools and an automation tool are each probed. A target whose tools are missing is `blocked` with the reason. Nothing is installed.
- **Evidence ledger.** The only writer of run state. It computes its own hashes, and it derives the gate status from the precedence in the plan.
- **Planted-app fixture.** A small order-approval app with 11 switchable app-side defects, and a clean control (`PLANTED=none`). Two Android configuration fixtures cover the static check.

It does not yet discover journeys, generate plans, run browsers, or triage defects. Those come in v0.2 onward. The full plan is in `docs/e2e-engineer-plan.md`, and the approval is recorded in `docs/e2e-engineer-approval.json`.

## Layout

```
.claude-plugin/plugin.json    manifest
skills/e2e-engineer/SKILL.md  the skill (v0.1 shell)
agents/repo-intel.md          maps the application (read-only)
scripts/
  intake.mjs                  runs intake: safety, build identity, probes, ledger
  safety.mjs                  target allowlist, production refusal, authorization, reset rules
  probe.mjs                   tool and device readiness, per target
  binary.mjs                  SHA-256 identity of APK, AAB and IPA files
  ledger.mjs                  run state, approval, binary records, gate status
  fingerprint.mjs             copy of backend-engineer's, checked for identity
  validate.mjs                structure check for the plugin and its marketplace entry
templates/qa.config.example.json
fixtures/planted-app/         the app, its OpenAPI contract, and manifest.json (the defect list)
fixtures/planted-android-config/  planted static-check defect (13)
fixtures/clean-android-config/    its clean control
test/                         node:test suites
```

## Run

No dependencies are installed. Node 22 or later is needed.

```bash
# Intake for a repository, using its qa.config.json
node e2e-engineer/scripts/intake.mjs qa.config.json --root .

# Gate status for that run
node e2e-engineer/scripts/ledger.mjs status .claude/e2e-engineer/ledger.json

# Start the fixture with its planted defects, or as the clean control
PLANTED=all  node e2e-engineer/fixtures/planted-app/server.mjs
PLANTED=none node e2e-engineer/fixtures/planted-app/server.mjs

# Tests and structure check
node --test e2e-engineer/test/*.test.mjs tests/e2e-engineer-identity.test.mjs
node e2e-engineer/scripts/validate.mjs
```

The run state lives in `.claude/e2e-engineer/` in the target repository. The plugin adds that folder to the target's `.gitignore` only with consent.

## Gate status

`BLOCKED`, `PARTIALLY TESTED`, `FAIL` and `PASS` follow the precedence in the plan (G19). `PASS WITH ACCEPTED RISKS` needs a named decision for each accepted item, and it arrives in a later version. In v0.1 the status is `BLOCKED` until intake is allowed, the plan is approved and every target in scope is ready. It is `PARTIALLY TESTED` until a P0 journey has a passing run.

## Limits in v0.1

- Journeys, plans, runs and triage are not implemented. A v0.1 run can only be `BLOCKED` or `PARTIALLY TESTED`.
- The hooks that stop the skill writing to application source come with the first phase that writes to a target (v0.3).
- The database run-marker check and reset are v0.3.
- Browser and device runs are v0.4 and v0.5. The fixture's browser-only defects (1, 8, 9, 10, 12) are wired into the code, but nothing drives a browser against them until v0.4 and v0.5. The API defects (2 to 7) are tested now, in the fixture suite.
- The Figma connector is checked at intake by the skill, not by a script.
- Test 11 in the fixture is a property of a sample test suite, which is added in v0.3.
