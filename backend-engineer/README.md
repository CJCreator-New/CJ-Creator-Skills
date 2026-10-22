# backend-engineer

A Claude Code plugin that builds the backend a frontend application needs, starting from what the user is trying to do. It reconstructs each user journey from the UI, the routes, the API calls and the requirements. It finds the missing pieces early: a control with no backend, an API that does not exist, a business rule nobody has decided. It then designs contracts and schema, implements and connects the backend with parallel agents, and verifies complete journeys with recorded evidence.

The agents reason and write code. Deterministic scripts hold the records, enforce the phase order, decide which agents may run in parallel, and compute the release status from evidence. A status is never typed in.

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

## How a run is orchestrated

The orchestrator is the main session running the `backend-build` skill. Two scripts hold the state:

- **`ledger.mjs`** holds the records and the evidence (below).
- **`orchestrate.mjs`** holds the phase order and the parallel waves.

The phases run in this order: discover → understand → plan → contract → implement → verify → e2e → review → deliver. Each phase ends with `orchestrate.mjs advance <phase>`, which checks the prerequisites in the ledger and refuses the phase if they do not hold. `orchestrate.mjs status` names the next phase and what blocks it.

The contract is gated. `orchestrate.mjs approve contract <openapi.json>` runs the journey check on the document and records its hash. The contract phase is refused when the file has changed since it was approved.

### Parallel waves

`orchestrate.mjs plan` groups the unfinished tasks into waves. A wave holds the tasks whose dependencies are all done. The orchestrator dispatches each wave in one message, one Agent call per task, with the model the router chose for it. It starts the next wave only when the current one is complete.

The ledger guarantees that no two tasks in a wave own the same file. Two tasks that share a file must be ordered by `dependsOn`, or the ledger refuses the change.

### The workflow path

`workflows/backend-build.js` runs the same waves as a deterministic workflow. It is used only when the user asks for a workflow in their own words. It stops at the first wave that does not complete, and it does not write to the ledger. The orchestrator records its results from the list it returns. The Workflow tool's agents have not been checked against the guard, so this path is untested until a real run.

## What is recorded

`scripts/ledger.mjs` keeps one ledger per run in `.claude/backend-engineer/ledger.json`:

| Section | Holds |
| --- | --- |
| requirements | each requirement, with its source (confirmed, inferred, proposed, unresolved, defect, assumption, out-of-scope) and priority |
| journeys | each user journey: role, start, steps, success outcome, failure branches, the paths it depends on |
| interactions | each UI interaction, classified `local` (with a reason) or `backend` (with its journey) |
| gaps | each gap, with severity, category, and its lifecycle step |
| decisions | each unresolved question, and the journeys it blocks |
| tasks | each piece of implementation work: owner, files, dependencies, and optional route kind, risk and ambiguity |
| phases | the phases completed, in order, with the time each finished |
| approvals | the contract approval, with the hash of the file approved |
| evidence | every recorded check run and every recorded review |
| project | the mode, the stack, the **declared commands**, the capabilities and the limitations |

```
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" init
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" set project '{"mode":"standard","commands":{"test":"npm test","testFocused":"npm run test:focused","e2e":"npm run test:e2e","lint":"npm run lint","typecheck":"npm run typecheck","build":"npm run build"}}'
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" add requirements '{"source":"confirmed","priority":"high","text":"...","status":"open"}'
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" validate
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" run test --scope full -- "npm test"
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" review passed --reviewer release-reviewer --notes "..."
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" release
node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" finish
```

`examples/ledger.example.json` is an illustrative ledger for one feature. It validates, and its release status is Blocked by an open decision.

## What the ledger enforces

- **Declared commands.** A check runs only the command the project declared for its name in `project.commands`. The names are `test`, `testFocused`, `regression`, `e2e`, `lint`, `typecheck` and `build`. Any other command is refused, so `true` cannot be recorded as the full suite.
- **Runs need files to fingerprint.** A run linked to a journey is refused when the journey's `dependsOn` matches no tracked files, and release reports such a journey as not releasable. A mistyped path cannot make a journey look verified forever.
- **References and fields.** Every reference resolves, required fields are present, and a gap's required fields exist before it moves past each stage. A change that would leave the ledger invalid is refused and not saved.
- **The task graph.** Tasks that share a file must be ordered by `dependsOn`, and `dependsOn` may not form a cycle.
- **Unresolved business rules.** A requirement whose source is `unresolved` cannot be marked `implemented`.
- **The gap lifecycle.** A gap moves one step at a time: `Detected → Triaged → Assigned → Root Cause Confirmed → Fix Implemented → Focused Tests Passed → Regression Verified → Closed`. Each step needs its prerequisites, such as an owner, a root cause, or a current passing run.
- **Currency.** A journey's run is current while the files named in its `dependsOn` are unchanged. A review is current while the working tree is unchanged. A change makes the affected evidence stale, and stale evidence does not count.
- **Serial writes.** Every write takes a lock on the ledger, and each save replaces the file atomically. A long check runs without the lock, so it cannot block other writes. Parallel processes keep every write.
- **Phases and approvals are not set by hand.** `set` refuses `phases`, `approvals` and `evidence`. The orchestration commands write them.
- **Release status.** Computed from the evidence:
  - **Blocked**: an open decision blocks a journey.
  - **Not Release Ready**: an open Critical or High gap, a high-priority journey that is not verified, a failed journey, no current passing full suite run, no current passing review, a journey that matches no files, or an empty ledger.
  - **Partially Complete**: only lower-priority items remain open.
  - **Complete**: none of the above.

`finish` ends a run only at Complete.

## Scripts

| Script | What it does |
| --- | --- |
| `ledger.mjs` | the records, the task graph, the gap lifecycle, declared runs, reviews, validation, release status |
| `orchestrate.mjs` | the phase order and its prerequisites, the contract approval, and the parallel waves |
| `route.mjs` | the model tier for one dispatch, with the reasons; the orchestrator passes it to the Agent tool |
| `guard.mjs` | the PreToolUse guard (see below) |
| `telemetry.mjs` | stage time, dispatches by agent and model, reported tokens, failures, correction rounds, and a comparison of two runs |
| `contract.mjs` | checks an OpenAPI 3 document against the API each journey step names |
| `report.mjs` | writes the operational dashboard (HTML) and the final report (Markdown) |
| `view.mjs` | the view both renderings read, so they cannot disagree |
| `fingerprint.mjs` | content fingerprints of journeys' files and of the working tree |

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

`contract.mjs check <openapi.json>` checks that every API a journey step names exists in the document, that each operation documents a success response and a client-error response, that state-changing operations are protected (or marked `x-public: true`), and that operation IDs are unique. An empty `security` list counts as unprotected, and an operation with no list of its own inherits the document's. It does not call the service, and it does not generate the document.

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

## Guard

`hooks/guard.mjs` runs before every Write, Edit, MultiEdit, Bash, Read, Grep and Glob call.

For every agent:

- **The ledger is written only by its commands.** `ledger.json` and its lock cannot be written by a tool, and cannot be rewritten through the shell, by `node -e`, `python -c`, `cp`, `tee`, `sed -i` or a redirection.
- **Secrets are never written, read, or named in a shell command.** This covers `.env` files other than examples, key and certificate files, and credentials files. It applies to `Read`, `Grep` and `Glob`, and to any shell target such as `echo x > .env` or `cp template .env`.
- **Committed migrations are never edited**, through a tool or a shell target. A new migration is allowed.
- **Inline interpreter code cannot touch the run state**, even with no redirection.

For read-only agents (`requirements-analyst`, `repo-intel`, `security-reviewer`, `e2e-verifier`, `release-reviewer`): no writes, with a tool or through the shell.

For subagents: the ledger is read and run only, through `ledger.mjs run`, `validate`, `status` and `release`. Other `ledger.mjs` commands, and the other plugin commands, are refused. While a run has an ownership file, subagents write only the files their tasks own, through Edit or Write, and not through the shell.

For the orchestrator: plugin commands are allowed. While a run has an ownership file, its writes stay inside it, or under the state folder.

## Limitations

- **Agent identity.** The guard identifies subagents by `agent_id` and read-only agents by `agent_type` in the hook input. Neither is confirmed for `PreToolUse` in the Claude Code version this plugin targets. If the harness omits them, subagent rules fall back to the orchestrator's rules, and read-only agents are not restricted. Check this on a real run first.
- **Plugin root variable.** The skill and agent prompts call the scripts through `${CLAUDE_PLUGIN_ROOT}`. Hook commands are documented to support this variable. Its expansion in skill and agent text is not confirmed. If it does not expand, the commands in those prompts will fail and must be pointed at the installed path.
- **The orchestrator is trusted.** It records review verdicts it receives, and it chooses which declared command to run. The ledger cannot check that a verdict reflects a real review. The report says so.
- **Declared commands are the project's responsibility.** The ledger runs whatever command the project declared. If the project's `test` script is a stub, a passing run proves nothing about the code.
- **Interpreters can still write files they do not name.** Inline interpreter code that names the run state is refused. Other interpreter writes are not visible to the guard.
- **Directory-wide search can return secret contents.** `Grep` over a directory does not name a secret file, so it can return lines from `.env` if it covers that directory. Only a search that names the file is refused.
- **The ownership guard works on paths.** It cannot tell which of several implementers is writing, so the split between them is enforced by the plan and the waves.
- **Git is required for currency.** Without git, no fingerprint exists, so no evidence is current and every journey reports stale.
- **Judgment is not checked.** The ledger cannot tell whether a requirement is right, whether a journey is complete, or whether a review is sound.
- **The workflow script is untested live.** It compiles, and the validator checks its phase names. It has not been run, and its agents' identity under the guard is unverified.
- **Duplicated code.** `ownership.mjs` and the ownership rules are copies of the `frontend-engineer` plugin's, because each plugin is installed on its own and cannot import from another.

## Example

`examples/example-run.md` is a captured run of one feature in a scratch repository. It shows the phase order, a journey blocked by an open decision, a gap moved through its lifecycle, declared runs, a review, the Complete status, and the generated report. Its commands are stand-ins, and the document says so.

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
