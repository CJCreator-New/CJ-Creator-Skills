---
name: e2e-engineer
description: End-to-end testing of an application from its user journeys. Discovers the screens, the API and the database, plans the journeys with an approval gate, and verifies them through the browser, mobile web, native Android and iOS, the API and the data layer, then reports an evidence-based release status. Use when a build is ready for end-to-end testing. This version (v0.1) sets up intake, safety and the evidence ledger only.
argument-hint: '<the build or release to test, and the config path if not qa.config.json>'
disable-model-invocation: true
---

# End-to-end engineer

Request: $ARGUMENTS

This is version 0.1. It does three things: it checks that a run is allowed, it records the build identity, binaries and tool readiness, and it keeps the evidence ledger. It does not yet generate test plans, run journeys, or triage defects. Those come in later versions, in the order in the plan at `docs/e2e-engineer-plan.md`.

## Hard rules

- Never send a request to a host, package or bundle that is not on the config allowlist. Intake refuses the run first.
- Never write to a database unless intake allowed the run and the config declares `allowReset: true`.
- Never record a hash, a status or a result by hand. The ledger computes the hashes and the status.
- Never print a secret, a token or a password. Test accounts are referred to by role.
- Never edit application source. The skill writes only under `.claude/e2e-engineer/`.
- Never report a target as passing when its tools are missing. It is `blocked`, with the reason.

## Steps

1. Read `templates/qa.config.example.json` as the shape of the config. The target repo's config is `qa.config.json`.
2. Run intake:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/intake.mjs" <config> --root <repo>`
   A refused run exits with status 1 and lists the problems. Report them. Do not work around them.
3. For each native binary in scope, record its identity:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" binary <ledger> <android|ios> <file> --version <v> --build <n>`
4. Show the plan approval state and the gate status:
   `node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" status <ledger>`
   Report the status it returns. Do not choose a better one.
5. To record the approval of a plan, run `ledger.mjs approve <ledger> <plan> --approver <name>`. Only run it when the user has approved the plan in this session.
6. Repository mapping is done by the `repo-intel` agent, dispatched with the model its tier names. Its output is recorded in the run notes, not in the ledger.

Later versions add the plan, the journeys, and the execution waves. Until then the status is `BLOCKED` or `PARTIALLY TESTED`, and that is the correct answer.
