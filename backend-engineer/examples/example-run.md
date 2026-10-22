# Example run: expense report submit

This is a real run of the ledger, telemetry and report scripts, captured as the transcript below. It runs one feature from requirement to a Complete release status in a scratch git repository. Every line of output is the script's own output. The paths were generalised: `${CLAUDE_PLUGIN_ROOT}` stands for this plugin's folder, and `<project>` for the scratch repository.

What the run does not show:

- The test commands are stand-ins (`node -e` scripts that print a result). They prove that the ledger records a run, its exit code, and its currency, not that a real suite passes.
- The implementer's change is a one-line `echo` that writes the fixed file. In a real run the backend-implementer agent makes that edit, under the guard.
- No browser, database or external service was available, so no visual or live integration check happened. The project record says so, and the report carries that limitation.

## The feature

An employee submits a draft expense report for manager approval. Journey J-01 covers the submit button, which calls `POST /expenses/:id/submit`. A gap was found after integration: the approval queue does not refresh after a submit. A decision is open on whether the employee can recall a submitted report. Until that decision is answered, J-01 is blocked.

## What the transcript shows

1. The ledger starts `Blocked`. The open decision blocks the journey, and the gap is open.
2. Gap G-01 cannot move to `Assigned` until it has an owner. The ledger refuses the step and says why.
3. Gap G-01 cannot move to `Focused Tests Passed` until a current run is linked to it.
4. The decision is answered, and the journey is no longer blocked.
5. The fix is recorded, and the focused, regression and full runs and the E2E run are recorded by the script. Each run stores its exit code.
6. The review is recorded against the working tree after the last change.
7. The release status becomes `Complete`, and the report is generated from that state.

The telemetry lines show two dispatches with the model chosen by `route.mjs`, and the implement stage time. No token counts were recorded, so the report shows them as unavailable.

## Transcript

```
$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" init
ledger: <project>/.claude/backend-engineer/ledger.json
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" set project {"mode":"standard","stack":{"frontend":"React and TypeScript","backend":"Node.js and Express","database":"PostgreSQL"},"capabilities":{"testDatabase":false,"runnableBackend":false,"browser":false,"externalServices":[]},"limitations":["No test database or browser was available, so E2E results are stand-ins, not a real environment."]}
project updated
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" add requirements {"source":"confirmed","priority":"high","text":"An employee can submit a draft expense report for manager approval.","status":"open"}
R-01
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" add journeys {"requirementIds":["R-01"],"role":"employee","start":"Draft expense report open in the form","steps":[{"ui":"Submit button","api":"POST /expenses/:id/submit"},{"ui":"Confirmation dialog"}],"outcomeSuccess":"Status becomes submitted and the report appears in the approval queue.","failureBranches":["Missing receipt returns a validation error and keeps the draft."],"dependsOn":["src/features/expenses/","server/expenses/"],"priority":"high"}
J-01
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" add interactions {"route":"/expenses/:id","element":"Submit button","classification":"backend","journeyId":"J-01"}
I-01
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" add interactions {"route":"/expenses/:id","element":"Details / Receipts tab","classification":"local","reason":"Switches panels in the client; no data is read or written."}
I-02
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" add gaps {"title":"Approval queue does not refresh after submit","severity":"High","category":"Frontend","detectedIn":"e2e","journeyIds":["J-01"],"requirementIds":["R-01"]}
G-01
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" add decisions {"question":"Can the employee recall a submitted report before approval?","status":"open","blocks":["J-01"]}
D-01
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" add tasks {"owner":"backend-implementer","files":["server/expenses/"],"status":"planned"}
T-01
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" validate
ledger valid
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" release
{
  "status": "Blocked",
  "blockers": [
    "D-01 is open: Can the employee recall a submitted report before approval?",
    "J-01 (high priority) is blocked"
  ],
  "notReady": [
    "G-01 High is open at Detected: Approval queue does not refresh after submit",
    "no current passing full suite run (run test --scope full)",
    "no independent review recorded"
  ],
  "partial": []
}
[exit 1]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" gap G-01 Triaged
G-01: Triaged
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" gap G-01 Assigned
G-01 stays Triaged:
  - set an owner first
[exit 1]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" set gaps G-01 {"owner":"frontend-integrator","rootCause":"The queue query is cached and not invalidated by the submit mutation."}
G-01 updated
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" gap G-01 Assigned
G-01: Assigned
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" gap G-01 Root Cause Confirmed
G-01: Root Cause Confirmed
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" set decisions D-01 {"status":"answered","answer":"No. Recall is not allowed after submit; the approver must return the report."}
D-01 updated
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/route.mjs crud --risk high
{
  "model": "opus",
  "reasons": [
    "crud is sonnet-class work",
    "high risk runs on opus"
  ]
}
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs start implement
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs dispatch backend-implementer --model sonnet
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs end implement
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" set tasks T-01 {"status":"done"}
T-01 updated
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" set gaps G-01 {"fix":"Submit now invalidates the approval queue query, so the queue refetches after the mutation."}
G-01 updated
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" gap G-01 Fix Implemented
G-01: Fix Implemented
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" run test --scope focused --journey J-01 --gap G-01 -- node -e "console.log('queue refetch test: 1 passed'); process.exit(0)"
E-01 test [focused] passed
queue refetch test: 1 passed

[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" gap G-01 Focused Tests Passed
G-01: Focused Tests Passed
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" set gaps G-01 {"regressionTests":["submit invalidates the approval queue query"]}
G-01 updated
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" run test --scope regression --journey J-01 --gap G-01 -- node -e "console.log('regression: 1 passed'); process.exit(0)"
E-02 test [regression] passed
regression: 1 passed

[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" gap G-01 Regression Verified
G-01: Regression Verified
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" set gaps G-01 {"acceptance":["Queue shows the submitted report without a page reload."]}
G-01 updated
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" gap G-01 Closed
G-01: Closed
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" run test --scope full -- node -e "console.log('full suite: 42 passed (stand-in)'); process.exit(0)"
E-03 test [full] passed
full suite: 42 passed (stand-in)

[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" run e2e --scope e2e --journey J-01 -- node -e "console.log('E2E: success path (stand-in); permission and duplicate branches not run'); process.exit(0)"
E-04 e2e [e2e] passed
E2E: success path (stand-in); permission and duplicate branches not run

[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs dispatch test-engineer --model sonnet
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" review passed --reviewer release-reviewer --notes Checked journey J-01, the contract, and the queue invalidation.
E-05 review passed
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" status
{
  "journeys": [
    {
      "id": "J-01",
      "priority": "high",
      "state": "verified"
    }
  ],
  "openGaps": [],
  "release": "Complete"
}
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" release
{
  "status": "Complete",
  "blockers": [],
  "notReady": [],
  "partial": []
}
[exit 0]

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/telemetry.mjs summary
{
  "stageMs": {
    "implement": 100
  },
  "dispatches": {
    "total": 2,
    "byAgent": {
      "backend-implementer": 1,
      "test-engineer": 1
    },
    "byModel": {
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

$ node ${CLAUDE_PLUGIN_ROOT}/scripts/report.mjs dashboard
dashboard written: <project>/.claude/backend-engineer/dashboard.html
[exit 0]

$ node "${CLAUDE_PLUGIN_ROOT}/scripts/ledger.mjs" finish
run finished; ownership.json removed
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
- T-01 (backend-implementer, done): server/expenses/

## D. Gaps

- Detected 1; closed 1; detected after integration 1.
- Open by severity: Critical 0, High 0, Medium 0, Low 0.
Open Critical and High gaps:
- none

Decisions the user must make:
- none

## E. Verification evidence

Recorded runs:
- E-01 test [focused] exit 0 at 2026-10-22T04:20:49.372Z
- E-02 test [regression] exit 0 at 2026-10-22T04:20:49.617Z
- E-03 test [full] exit 0 at 2026-10-22T04:20:49.919Z
- E-04 e2e [e2e] exit 0 at 2026-10-22T04:20:50.076Z
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

- Stage time (ms): {"implement":100}
- Dispatches: 2; correction rounds: 0; failures: 0
- Tokens: unavailable
```
