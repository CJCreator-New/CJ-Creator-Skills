# Example run: expense report submit

This is a real run of the plugin's scripts, captured as the transcript below. It takes one feature from requirement to delivery in a scratch git repository. Every line of output is the script's own output. The paths were generalised: `${CLAUDE_PLUGIN_ROOT}` stands for this plugin's folder, and `<project>` for the scratch repository. Lines starting with `#` are the driver's notes on work that another agent does in a real run.

What the run shows, in order:

1. The phases advance only when their prerequisites hold. `orchestrate.mjs status` names the next phase.
2. The project declares its commands, including `migrate`. Each check later runs one of those declared commands, and nothing else.
3. The UI inventory is recorded, and each UI file with interaction sites has an interaction record that names it.
4. The contract is checked against the journey and the client's calls, then approved. The approval records the file's hash.
5. `orchestrate.mjs plan` returns the implementation in waves. The backend task is in wave 1. The frontend task depends on it, so it is in wave 2.
6. The gap moves through its lifecycle, and each step needs what the previous one recorded. Its regression test must print its name in a passing regression run.
7. A migration is not verified until a current passing `migrate` run exists, so `verify` is refused until it does.
8. The gap closes only when its acceptance cites current passing evidence linked to it.
9. The release status is computed from the evidence. It is Complete only after the full suite, the migration and the review are current.

What the run does not show:

- The test commands are stand-ins: `node -e` scripts that print a result. They prove that the ledger records a declared run, its exit code, and its currency, not that a real suite passes.
- The implementers' and reviewer's edits are simulated by the driver, and marked with `#`. In a real run the backend-implementer and frontend-integrator agents make those edits, under the guard.
- The decision `D-01` is answered by the driver. That answer is a stand-in for the person who owns the decision; the plugin does not supply business answers.
- The review verdict is the one the orchestrator records. The ledger cannot check that it reflects a real review.
- No browser, database or external service was available, so no visual or live integration check happened.
- The telemetry is not shown, because the run did not bracket its phases with telemetry commands.

## Transcript

```
# the project declares its commands, and the stand-in commands are the only ones a run may execute

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs init
ledger: <project>/.claude/backend-engineer/ledger.json
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set project '{"mode":"standard","stack":{"frontend":"React and TypeScript","backend":"Node.js and Express","database":"PostgreSQL"},"commands":{"test":"node -e \"console.log('\''full suite: 46 passed (stand-in)'\''); process.exit(0)\"","testFocused":"node -e \"console.log('\''queue refetch test: submit-refreshes-queue passed (stand-in)'\''); process.exit(0)\"","regression":"node -e \"console.log('\''regression: submit-refreshes-queue passed (stand-in)'\''); process.exit(0)\"","e2e":"node -e \"console.log('\''E2E success path passed (stand-in); permission and duplicate branches not run'\''); process.exit(0)\"","lint":"node -e \"console.log('\''lint clean (stand-in)'\''); process.exit(0)\"","migrate":"node -e \"console.log('\''migration 002 applied and reverted on a test database (stand-in)'\''); process.exit(0)\""},"capabilities":{"testDatabase":false,"runnableBackend":false,"browser":false,"externalServices":[]},"limitations":["No test database or browser was available, so E2E results are stand-ins, not a real environment."]}'
project updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs status
{
  "completed": [],
  "next": "discover",
  "nextBlockers": [],
  "release": "Not Release Ready"
}
[exit 0]

# discover and understand: the requirement, the journey, the UI interactions and the gap

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add requirements '{"source":"confirmed","priority":"high","text":"An employee can submit a draft expense report for manager approval.","status":"open"}'
R-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add journeys '{"requirementIds":["R-01"],"role":"employee","start":"Draft expense report open in the form","steps":[{"ui":"Submit button","api":"POST /expenses/:id/submit"},{"ui":"Confirmation dialog"}],"outcomeSuccess":"Status becomes submitted and the report appears in the approval queue.","failureBranches":["Missing receipt returns a validation error and keeps the draft."],"dependsOn":["src/features/expenses/","server/expenses/"],"priority":"high"}'
J-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add interactions '{"route":"/expenses/:id","element":"Submit button","classification":"backend","journeyId":"J-01","source":"src/features/expenses/ExpenseForm.tsx"}'
I-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add interactions '{"route":"/expenses/:id","element":"Details / Receipts tab","classification":"local","reason":"Switches panels in the client; no data is read or written.","source":"src/features/expenses/ExpenseForm.tsx"}'
I-02
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/inventory.mjs record src
recorded 1 UI file(s) with 4 interaction site(s)
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add gaps '{"title":"Approval queue does not refresh after submit","severity":"High","category":"Frontend","detectedIn":"e2e","journeyIds":["J-01"],"requirementIds":["R-01"]}'
G-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add decisions '{"question":"Can the employee recall a submitted report before approval?","status":"open","blocks":["J-01"]}'
D-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add migrations '{"file":"db/migrations/002_expense_status.sql","description":"add status column to expense reports","backwardCompatible":true,"irreversible":false,"rollback":"drop status column"}'
M-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs validate
ledger valid
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance discover
phase discover complete
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance understand
phase understand complete
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance plan
phase plan complete
[exit 0]

# plan: the tasks, with their file ownership and dependencies

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add tasks '{"owner":"api-architect","files":["contracts/"],"kind":"contract","status":"planned"}'
T-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add tasks '{"owner":"backend-implementer","files":["server/expenses/"],"kind":"implementation","risk":"low","status":"planned","dependsOn":["T-01"]}'
T-02
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add tasks '{"owner":"frontend-integrator","files":["src/features/expenses/"],"kind":"frontend","status":"planned","dependsOn":["T-02"]}'
T-03
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs validate
ledger valid
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs ownership
ownership.json: 3 path(s)
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 Triaged
G-01: Triaged
[exit 0]

# contract: the api-architect writes the document, the journey and client check runs, then the contract is approved

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/contract.mjs check contracts/openapi.json --client src/features/expenses/api.ts
contract consistent with the journeys and the client
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set tasks T-01 '{"status":"done"}'
T-01 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs approve contract contracts/openapi.json
contract approved
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance contract
phase contract complete
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs plan
{
  "waves": [
    {
      "wave": 1,
      "tasks": [
        {
          "id": "T-02",
          "owner": "backend-implementer",
          "files": [
            "server/expenses/"
          ],
          "kind": "implementation",
          "model": "sonnet",
          "reasons": [
            "implementation is sonnet-class work"
          ]
        }
      ]
    },
    {
      "wave": 2,
      "tasks": [
        {
          "id": "T-03",
          "owner": "frontend-integrator",
          "files": [
            "src/features/expenses/"
          ],
          "kind": "frontend",
          "model": "sonnet",
          "reasons": [
            "frontend is sonnet-class work"
          ]
        }
      ]
    }
  ],
  "blocked": [],
  "waiting": []
}
[exit 0]

# implement: the backend and the frontend change, in two waves

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance implement
phase implement complete
[exit 0]

# the backend-implementer writes server/expenses/submit.ts (simulated)

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set tasks T-02 '{"status":"done"}'
T-02 updated
[exit 0]

# the frontend-integrator refetches the queue on success (simulated)

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set tasks T-03 '{"status":"done"}'
T-03 updated
[exit 0]

# the gap moves through its lifecycle, and each step needs what the previous one recorded

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set gaps G-01 '{"owner":"frontend-integrator"}'
G-01 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 Assigned
G-01: Assigned
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set gaps G-01 '{"rootCause":"the approval queue is cached and is not invalidated after a submit","fix":"invalidate the approval queue query when a submit succeeds","regressionTests":["submit-refreshes-queue"]}'
G-01 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 'Root Cause Confirmed'
G-01: Root Cause Confirmed
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 'Fix Implemented'
G-01: Fix Implemented
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs run testFocused --scope focused --gap G-01 -- 'node -e "console.log('\''queue refetch test: submit-refreshes-queue passed (stand-in)'\''); process.exit(0)"'
E-01 testFocused [focused] passed
queue refetch test: submit-refreshes-queue passed (stand-in)
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 'Focused Tests Passed'
G-01: Focused Tests Passed
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs run regression --scope regression --gap G-01 --tests submit-refreshes-queue -- 'node -e "console.log('\''regression: submit-refreshes-queue passed (stand-in)'\''); process.exit(0)"'
E-02 regression [regression] passed
regression: submit-refreshes-queue passed (stand-in)
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 'Regression Verified'
G-01: Regression Verified
[exit 0]

# a decision that blocks a journey shows as blocked; the stand-in answers it so the journey can be verified

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs status
{
  "completed": [
    "discover",
    "understand",
    "plan",
    "contract",
    "implement"
  ],
  "next": "verify",
  "nextBlockers": [
    "migrations are not verified: run the migrate command against a test database, and it must pass on the final tree"
  ],
  "release": "Blocked"
}
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set decisions D-01 '{"status":"answered","answer":"No recall after submit; a submitted report is locked for the approver."}'
D-01 updated
[exit 0]

# the verify phase needs the migration verified, and the first attempt is refused

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance verify
refused:
  - migrations are not verified: run the migrate command against a test database, and it must pass on the final tree
[exit 1]

# the migration is written (simulated), then the migrate run executes it on the test database

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs run migrate --scope focused -- 'node -e "console.log('\''migration 002 applied and reverted on a test database (stand-in)'\''); process.exit(0)"'
E-03 migrate [focused] passed
migration 002 applied and reverted on a test database (stand-in)
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs run e2e --scope e2e --journey J-01 -- 'node -e "console.log('\''E2E success path passed (stand-in); permission and duplicate branches not run'\''); process.exit(0)"'
E-04 e2e [e2e] passed
E2E success path passed (stand-in); permission and duplicate branches not run
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs run test --scope full -- 'node -e "console.log('\''full suite: 46 passed (stand-in)'\''); process.exit(0)"'
E-05 test [full] passed
full suite: 46 passed (stand-in)
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance verify
phase verify complete
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance e2e
phase e2e complete
[exit 0]

# the gap cannot close until its acceptance cites current evidence linked to it; the earlier regression run is stale, because the migration changed the tree after it

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 Closed
G-01 stays Regression Verified:
  - record acceptance criteria first
[exit 1]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs run regression --scope regression --gap G-01 --tests submit-refreshes-queue -- 'node -e "console.log('\''regression: submit-refreshes-queue passed (stand-in)'\''); process.exit(0)"'
E-06 regression [regression] passed
regression: submit-refreshes-queue passed (stand-in)
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set gaps G-01 '{"acceptance":[{"criterion":"The approval queue shows a report right after it is submitted","evidence":"E-06"}]}'
G-01 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 Closed
G-01: Closed
[exit 0]

# review: the reviewer writes the report, and the ledger stores its hash

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs review passed --report .claude/backend-engineer/review.md --notes 'checked the submit path, the queue refresh and the rollback'
E-07 review passed
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance review
phase review complete
[exit 0]

# release: computed from the evidence, and Complete only when every check holds

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs release
{
  "status": "Complete",
  "blockers": [],
  "notReady": [],
  "partial": []
}
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance deliver
phase deliver complete
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs status
{
  "completed": [
    "discover",
    "understand",
    "plan",
    "contract",
    "implement",
    "verify",
    "e2e",
    "review",
    "deliver"
  ],
  "next": null,
  "nextBlockers": [],
  "release": "Complete"
}
[exit 0]

```
