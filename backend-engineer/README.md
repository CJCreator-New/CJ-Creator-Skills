# backend-engineer

A Claude Code plugin that builds the backend a frontend application needs, starting from what the user is trying to do. It reconstructs each user journey from the UI, the routes, the API calls and the requirements. It finds the missing pieces early: a control with no backend, an API that does not exist, a business rule nobody has decided. It then designs contracts and schema, implements and connects the backend, and verifies complete journeys with recorded evidence.

It is built on the same principle as `frontend-engineer`: the agents reason and write code, and deterministic scripts hold the records and enforce what can be checked. The release status is computed from evidence, never typed in.

## Install

Installed with the rest of this repo by the root installer. To install only this plugin:

```
/plugin marketplace add CJCreator-New/CJ-Creator-Skills
/plugin install backend-engineer@forge-marketplace
```

For local development:

```
claude --plugin-dir ./backend-engineer
```

## Use

The skill is invoked explicitly, because a full run dispatches several agents:

```
/backend-engineer:backend-build Add the backend for the expense report submit flow (requirements: docs/requirements/expenses.md)
/backend-engineer:backend-build Fix the approval queue not refreshing after submit (fast mode)
```

## What is recorded

`scripts/ledger.mjs` keeps one ledger per run in `.claude/backend-engineer/ledger.json`:

| Section | Holds |
| --- | --- |
| requirements | each requirement, with its source (confirmed, inferred, proposed, unresolved, defect, assumption, out-of-scope) and priority |
| journeys | each user journey: role, start, steps, success outcome, failure branches, the paths it depends on |
| interactions | each UI interaction, classified `local` (with a reason) or `backend` (with its journey) |
| gaps | each gap, with severity, category and its lifecycle step |
| decisions | each unresolved question, and the journeys it blocks |
| tasks | each piece of implementation work, its owner and the files it owns |
| evidence | every recorded check run and every recorded review |

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" init
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" add requirements '{"source":"confirmed","priority":"high","text":"...","status":"open"}'
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" add journeys '{ ... }'
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" validate
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" gap G-01 Triaged
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" run test --scope full -- "npm test"
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" review passed --notes "..."
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" release
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" finish
```

`examples/ledger.example.json` is an illustrative ledger for one feature. It validates, and its release status is Blocked by an open decision.

## What the ledger enforces

- **References and fields.** Every reference resolves, required fields are present, and a stage's required fields exist before the gap moves past it. A change that would leave the ledger invalid is refused and not saved.
- **Unresolved business rules.** A requirement whose source is `unresolved` cannot be marked `implemented`.
- **The gap lifecycle.** A gap moves one step at a time: `Detected → Triaged → Assigned → Root Cause Confirmed → Fix Implemented → Focused Tests Passed → Regression Verified → Closed`. Each step needs its prerequisites, such as an owner, a root cause, or a current passing run.
- **Recorded results.** `run` executes the command and stores its exit code and output tail. `review` records a verdict against the working tree. Nothing else counts as a result.
- **Currency.** A journey's run is current while the files named in the journey's `dependsOn` are unchanged. A review is current while the working tree is unchanged. A change makes the affected evidence stale, and stale evidence does not count.
- **Release status.** Computed from the evidence:
  - **Blocked**: an open decision blocks a journey.
  - **Not Release Ready**: an open Critical or High gap, a high-priority journey that is not verified, a failed journey, no current passing full suite run, no current passing review, or an empty ledger.
  - **Partially Complete**: only lower-priority items remain open.
  - **Complete**: none of the above.

`finish` ends a run only at Complete.

## Scripts

| Script | What it does |
| --- | --- |
| `ledger.mjs` | the records, the gap lifecycle, recorded runs and reviews, validation, release status |
| `route.mjs` | the model tier for one dispatch, with the reasons; the orchestrator passes it to the Agent tool |
| `telemetry.mjs` | stage time, dispatches by agent and model, reported tokens, failures, correction rounds, and a comparison of two runs |
| `contract.mjs` | checks an OpenAPI 3 document against the API each journey step names |
| `report.mjs` | writes the operational dashboard (HTML) and the final report (Markdown) from the ledger and telemetry |
| `view.mjs` | the view both renderings read, so they cannot disagree |

### Model routing

`route.mjs` maps the kind of work to a tier: mechanical work to haiku, implementation to sonnet, and judgment (authorization, security, migrations, concurrency, review) to opus. Risk, ambiguity and repeated failure raise a tier. Nothing lowers one.

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/route.mjs" authorization --risk high
{ "model": "opus", "reasons": ["authorization is opus-class work", "high risk runs on opus"] }
```

The routing takes effect only when the orchestrator passes the model to the Agent tool. Each agent's frontmatter model is the fallback.

### Telemetry

`telemetry.mjs` records what the harness reports and nothing else. Token counts appear only when `tokens` is recorded, and the report shows them as unavailable otherwise. `compare` sets two runs side by side. It reports the numbers, and it is meaningful only for runs of the same mode and scope. There is no baseline yet, so one run does not show an improvement.

### Dashboard and report

`report.mjs dashboard` writes a self-contained HTML page: release readiness and its reasons, the plan with blocked tasks, the journey explorer with each journey's state, the interaction map, the gap table with severity and category filters, decisions, the recorded runs and reviews, and telemetry. It has no external resources, and user text is escaped.

`report.mjs report` writes the final report in the sections the specification asks for. Every figure comes from the ledger. The orchestrator adds narrative only where the ledger has none.

### OpenAPI check

`contract.mjs check <openapi.json>` checks that every API a journey step names exists in the document, that each operation documents a success response and a client-error response, that state-changing operations declare security (or `x-public: true`), and that operation IDs are unique. It does not call the service, and it does not generate the document. Generation depends on the framework the project already uses.

### Development modes

`project.mode` is `fast`, `standard` or `high-assurance`. High-assurance requires a current passing review by `security-reviewer` before the release status can be Complete. The other modes differ in how much the orchestrator verifies, as the skill describes. None of them lowers the checks the ledger enforces.

## Agents

| Agent | Model | Writes | Role |
| --- | --- | --- | --- |
| requirements-analyst | opus | no | reconstructs journeys, classifies interactions, finds gaps and decisions |
| repo-intel | haiku | no | maps frontend and backend: routes, services, schema, authorization, tests |
| api-architect | opus | contract files | defines operations, schemas, errors, transitions and authorization |
| db-integrity | opus | migrations | schema, constraints, indexes, transactions, backward-compatible migrations |
| backend-implementer | sonnet | owned files | implements handlers, services and domain rules |
| integration-engineer | sonnet | owned files | adapters for external services, retries, idempotency, webhooks |
| frontend-integrator | sonnet | owned files | connects the frontend to the contract and handles every state |
| security-reviewer | opus | no | authorization, tenancy, injection, exposure, secrets |
| test-engineer | sonnet | test files | requirement-driven tests, run through the ledger |
| e2e-verifier | sonnet | no | runs journeys and their failure branches, through the ledger |
| release-reviewer | opus | no | independent review of the integrated state |

The orchestrator is the main session running the `backend-build` skill. It owns the ledger.

## Guard

`hooks/guard.mjs` runs before every Write, Edit, MultiEdit and Bash call:

- **Secrets.** Writes to `.env` files (other than examples), key and certificate files, and credentials files are denied for every agent.
- **Committed migrations.** Editing a migration that git tracks is denied. Adding a new migration is allowed.
- **Read-only agents.** `requirements-analyst`, `repo-intel`, `security-reviewer`, `e2e-verifier` and `release-reviewer` cannot write, with a tool or through the shell.
- **Subagents and the ledger.** Subagents cannot write under `.claude/backend-engineer/`, and cannot change the ledger with `add`, `set`, `gap`, `review`, `finish`, `abort`, `init` or `ownership`. They can run, validate, check status and release.
- **File ownership.** While `ownership.json` exists, subagents write only the files their tasks own, through Edit or Write, and not through the shell. The orchestrator is held to the same list, except under the ledger folder.

## Limitations

- **Agent identity.** The guard identifies subagents by `agent_id` and read-only agents by `agent_type` in the hook input. Neither is confirmed for `PreToolUse` in the Claude Code version this plugin targets. If the harness omits them, subagent rules fall back to the orchestrator's rules, and read-only agents are not restricted. Check this on a real run first.
- **Plugin root variable.** The skill and agent prompts call the ledger through `${CLAUDE_PLUGIN_ROOT}`. Hook commands are documented to support this variable. Its expansion in skill and agent text is not confirmed. If it does not expand, the ledger commands in those prompts will fail and must be pointed at the installed path.
- **Shell writes.** Shell-write detection matches common patterns. An interpreter such as `node -e` or `python -c` can still write outside the list.
- **Git is required for currency.** Without git every fingerprint is null, so no evidence is current and every journey reports stale.
- **Judgment is not checked.** The ledger cannot tell whether a requirement is right, whether a journey is complete, or whether a review is sound. The reviewer and the user decide those.
- **Duplicated code.** `ownership.mjs` and the ownership rules are copies of the `frontend-engineer` plugin's, because each plugin is installed on its own and cannot import from another.
- **No live verification here.** The plugin itself is tested. It has not been run against a real backend, database or external service. Live integrations must be verified in an environment with credentials, and the report must say so when they were not.

## Example

`examples/example-run.md` is a captured run of one feature in a scratch repository: a journey blocked by an open decision, a gap moved through its lifecycle, recorded runs, a review, the Complete status, and the generated report. Its test commands are stand-ins, and the document says so.

## Not verified here

- **No run against a real application.** The scripts are tested and exercised in scratch repositories. A real backend, database and external service have not been used. Live integrations need credentials and an environment that the plugin cannot assume.
- **Token counts.** No run has reported token usage yet, so none appear in any output here.
- **Baseline.** Comparing efficiency needs several runs of the same mode and scope. None exist yet.
- **OpenAPI generation** is left to the project's own tooling. The check validates the document, not the code behind it.

## Development

```
node --test backend-engineer/test/*.test.mjs
node backend-engineer/scripts/validate.mjs
```

On Node 22, `node --test <directory>` does not find the tests, so list the files, as above.
