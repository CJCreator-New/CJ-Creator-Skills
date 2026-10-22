# Example run: expense report submit

This is a real run of the plugin's scripts, captured as the transcript below. It takes one feature from requirement to delivery in a scratch git repository. Every line of output is the script's own output. The paths were generalised: `${CLAUDE_PLUGIN_ROOT}` stands for this plugin's folder, and `<project>` for the scratch repository.

What the run shows, in order:

1. The phases advance only when their prerequisites hold. `orchestrate.mjs status` names the next phase.
2. The project declares its commands. Each check later runs one of those declared commands, and nothing else.
3. The contract is checked against the journey, then approved. The approval records the file's hash.
4. `orchestrate.mjs plan` returns the implementation in waves. The backend task is in wave 1. The frontend task depends on it, so it is in wave 2.
5. The gap moves through its lifecycle, and each step needs what the previous one recorded.
6. The release status is computed from the evidence. It is Complete only after the full suite and the review are current.

What the run does not show:

- The test commands are stand-ins: `node -e` scripts that print a result. They prove that the ledger records a declared run, its exit code, and its currency, not that a real suite passes.
- The implementers' edits are simulated with `echo`. In a real run the backend-implementer and frontend-integrator agents make those edits, under the guard.
- The review verdict is the one the orchestrator records. The ledger cannot check that it reflects a real review.
- No browser, database or external service was available, so no visual or live integration check happened.
- The telemetry shows no stage times, because the run did not bracket its phases with telemetry commands. It shows the dispatches and their models.

## Transcript

```
$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs init
ledger: <project>/.claude/backend-engineer/ledger.json
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set project {"mode":"standard","stack":{"frontend":"React and TypeScript","backend":"Node.js and Express","database":"PostgreSQL"},"commands":{"test":"node -e \"console.log('full suite: 42 passed (stand-in)'); process.exit(0)\"","testFocused":"node -e \"console.log('queue refetch test: 1 passed (stand-in)'); process.exit(0)\"","regression":"node -e \"console.log('regression: 1 passed (stand-in)'); process.exit(0)\"","e2e":"node -e \"console.log('E2E success path (stand-in); permission and duplicate branches not run'); process.exit(0)\"","lint":"node -e \"console.log('lint clean (stand-in)'); process.exit(0)\""},"capabilities":{"testDatabase":false,"runnableBackend":false,"browser":false,"externalServices":[]},"limitations":["No test database or browser was available, so E2E results are stand-ins, not a real environment."]}
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

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add requirements {"source":"confirmed","priority":"high","text":"An employee can submit a draft expense report for manager approval.","status":"open"}
R-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add journeys {"requirementIds":["R-01"],"role":"employee","start":"Draft expense report open in the form","steps":[{"ui":"Submit button","api":"POST /expenses/:id/submit"},{"ui":"Confirmation dialog"}],"outcomeSuccess":"Status becomes submitted and the report appears in the approval queue.","failureBranches":["Missing receipt returns a validation error and keeps the draft."],"dependsOn":["src/features/expenses/","server/expenses/"],"priority":"high"}
J-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add interactions {"route":"/expenses/:id","element":"Submit button","classification":"backend","journeyId":"J-01"}
I-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add interactions {"route":"/expenses/:id","element":"Details / Receipts tab","classification":"local","reason":"Switches panels in the client; no data is read or written."}
I-02
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add gaps {"title":"Approval queue does not refresh after submit","severity":"High","category":"Frontend","detectedIn":"e2e","journeyIds":["J-01"],"requirementIds":["R-01"]}
G-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add decisions {"question":"Can the employee recall a submitted report before approval?","status":"open","blocks":["J-01"]}
D-01
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

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add tasks {"owner":"api-architect","files":["contracts/"],"kind":"contract","status":"planned"}
T-01
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add tasks {"owner":"backend-implementer","files":["server/expenses/"],"kind":"implementation","risk":"low","status":"planned","dependsOn":["T-01"]}
T-02
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs add tasks {"owner":"frontend-integrator","files":["src/features/expenses/"],"kind":"frontend","status":"planned","dependsOn":["T-02"]}
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

--- contract: api-architect writes the document, then the journey check approves it ---
$ node ${CLAUDE_PLUGIN_ROOT}/scripts/contract.mjs check contracts/openapi.json
contract consistent with the journeys
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set tasks T-01 {"status":"done"}
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

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance implement
phase implement complete
[exit 0]

--- wave 1: backend-implementer edits its owned files (simulated edit) ---
$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set tasks T-02 {"status":"done"}
T-02 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs plan
{
  "waves": [
    {
      "wave": 1,
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

--- wave 2: frontend-integrator ---
$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set tasks T-03 {"status":"done"}
T-03 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set gaps G-01 {"owner":"frontend-integrator","rootCause":"The queue query is cached and not invalidated by the submit mutation."}
G-01 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 Assigned
G-01: Assigned
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 Root Cause Confirmed
G-01: Root Cause Confirmed
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set decisions D-01 {"status":"answered","answer":"No. Recall is not allowed after submit; the approver must return the report."}
D-01 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set gaps G-01 {"fix":"Submit now invalidates the approval queue query, so the queue refetches after the mutation."}
G-01 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 Fix Implemented
G-01: Fix Implemented
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance verify
phase verify complete
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs run testFocused --scope focused --journey J-01 --gap G-01 -- node -e "console.log('queue refetch test: 1 passed (stand-in)'); process.exit(0)"
E-01 testFocused [focused] passed
queue refetch test: 1 passed (stand-in)

[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 Focused Tests Passed
G-01: Focused Tests Passed
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set gaps G-01 {"regressionTests":["submit invalidates the approval queue query"]}
G-01 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs run regression --scope regression --journey J-01 --gap G-01 -- node -e "console.log('regression: 1 passed (stand-in)'); process.exit(0)"
E-02 regression [regression] passed
regression: 1 passed (stand-in)

[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 Regression Verified
G-01: Regression Verified
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs set gaps G-01 {"acceptance":["Queue shows the submitted report without a page reload."]}
G-01 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs gap G-01 Closed
G-01: Closed
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance e2e
phase e2e complete
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs run e2e --scope e2e --journey J-01 -- node -e "console.log('E2E success path (stand-in); permission and duplicate branches not run'); process.exit(0)"
E-03 e2e [e2e] passed
E2E success path (stand-in); permission and duplicate branches not run

[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs run test --scope full -- node -e "console.log('full suite: 42 passed (stand-in)'); process.exit(0)"
E-04 test [full] passed
full suite: 42 passed (stand-in)

[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs review passed --reviewer release-reviewer --notes Checked journey J-01, the contract, and the queue invalidation.
E-05 review passed
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/orchestrate.mjs advance review
phase review complete
[exit 0]

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

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs finish
run finished; ownership.json removed
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs dispatch api-architect --model opus
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs dispatch backend-implementer --model sonnet
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs dispatch frontend-integrator --model sonnet
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs summary
{
  "stageMs": {},
  "dispatches": {
    "total": 3,
    "byAgent": {
      "api-architect": 1,
      "backend-implementer": 1,
      "frontend-integrator": 1
    },
    "byModel": {
      "opus": 1,
      "sonnet": 2
    }
  },
  "tokens": "unavailable",
  "failures": {
    "total": 0,
    "byKind": {}
  },
  "iterations": {
    "total": 0,
    "byName": {}
  }
}
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs report
report written: <project>/.claude/backend-engineer/report.md
[exit 0]

```

## Final report (generated from the ledger)

```
# Backend run report

Mode: standard
Overall status: **Complete**

## A. Execution summary

- Journeys: 1 identified, 1 verified, 0 failed, 0 stale, 0 blocked.
- Requirements: 1 recorded, 1 traced to a journey.

## B. User-flow coverage

- Interactions: 2 (backend 1, mapped to a journey 1; local 1).
- Open decisions: 0.

## C. Implementation

Tasks and the files they own:
- T-01 (api-architect, done): contracts/
- T-02 (backend-implementer, done): server/expenses/
- T-03 (frontend-integrator, done): src/features/expenses/

## D. Gaps

- Detected 1; closed 1; detected after integration 1.
- Open by severity: Critical 0, High 0, Medium 0, Low 0.
Open Critical and High gaps:
- none

Decisions the user must make:
- none

## E. Verification evidence

Recorded runs:
- E-01 testFocused [focused] exit 0 at 2026-10-22T04:43:45.816Z
- E-02 regression [regression] exit 0 at 2026-10-22T04:43:46.144Z
- E-03 e2e [e2e] exit 0 at 2026-10-22T04:43:46.539Z
- E-04 test [full] exit 0 at 2026-10-22T04:43:46.660Z
Recorded reviews:
- E-05 release-reviewer passed
Journeys without a verified result:
- none

Limitations recorded in the ledger:
- No test database or browser was available, so E2E results are stand-ins, not a real environment.

## F. Release readiness

Blockers:
- none
Not release ready:
- none
Partial:
- none
Deployment and migration notes:
- none

## G. Next steps

- none

## Telemetry

- Stage time (ms): {}
- Dispatches: 3; correction rounds: 0; failures: 0
- Tokens: unavailable
```
