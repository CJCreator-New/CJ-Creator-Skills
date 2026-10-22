# Quality gates, completion states and reporting

## Gates

A failed gate returns the work to the stage that owns the missing item. The orchestrator never moves past a gate to meet a speed target.

Enforcement: `scripts/gates.mjs check <n>` tests each gate below and lists every failure. Its checks are:
- Gate 1: matrix rows have requirements and files; work packages do not overlap; every matrix file has an owner; `ownership.json` matches the packages.
- Gate 2: no open handoffs; `lint` and `typecheck` runs passed against the current changes.
- Gate 3: gate 2, and every matrix row is at least `implemented`.
- Gate 4: gate 3, and `tested` or `verified` rows name tests; `verified` rows have evidence files that exist; `build` passed and the full `test` run passed (or failed only as listed in `allowedFailures`, with a failing baseline); visual status is consistent with its remaining defects; the review passed.
- Gate 5: gate 4, and approval and limitations are recorded.

"Current" means the run's recorded working-tree hash still matches the tree, so a check that passed before a later edit does not count. Recorded results come only from `gates.mjs run`, which executes the command and stores its exit code and output.

The text under each gate lists what a person checks as well. The script cannot judge whether a test is meaningful, whether the design matches, or whether the review is sound. Those remain judgment, and the report must say so.

**Gate 1: ready to implement** (checked end of Stage 3)
- Scope understood, and affected routes listed.
- Relevant repository inspected: repo-intel output or the checkpoint's index.
- Design requirements documented, with explicit and inferred items separated (or "no design reference" stated).
- Dependencies on APIs and other features identified.
- Traceability matrix and contracts written.
- Ownership assigned and written to `ownership.json`.

**Gate 2: ready to integrate** (Stage 5)
- Every implementer returned a handoff.
- Each diff matches its contract.
- Handoff requests from other owners were resolved.
- Format, lint and typecheck were run, and their actual results are recorded.

**Gate 3: ready for QA** (Stage 5)
- All components integrated and reachable from their routes.
- Interactions in the matrix are implemented, with no dead controls or placeholder handlers.
- Runtime errors seen in the dev server or the console are addressed.

**Gate 4: ready for final review** (Stage 9)
- Required tests executed, with actual results recorded.
- Build checked where applicable.
- Browser rendering inspected at every configured viewport, or the report states that it was not performed.
- Visual defects recorded and corrected, or listed as remaining.
- Regressions investigated: each failure is marked regression or pre-existing, with evidence.
- Final diff reviewed for unintended changes.

**Gate 5: ready for user approval** (Stage 9)
- Evidence presented: test output, screenshots, and the reference path.
- Reference and actual implementation are both available to the user (paths or URLs).
- Remaining limitations disclosed.
- User feedback is either incorporated or marked as pending.

## Completion states

Report each separately. Never merge them into one "done":

| State                  | Values                                                              |
| ---------------------- | ------------------------------------------------------------------- |
| Implementation         | not started / partial / complete                                    |
| Automated testing      | not run / failing / passing (with the command and date)             |
| Visual verification    | not performed (reason) / incomplete / passing at N viewports        |
| Independent review     | not run / findings open / passed                                    |
| User approval          | pending / approved / changes requested                              |

## Telemetry

Record through `scripts/telemetry.mjs`, which writes `.claude/frontend-engineer/telemetry.jsonl`:

- `start <stage>` and `end <stage>` for every stage: gives elapsed time per stage.
- `tokens <agent> <input> <output>`: only when the harness reports usage for that agent. Otherwise do not call it.
- `defect <severity> [--fixed]`: each defect found and each fixed.
- `iteration`: each visual correction iteration.

The summary reports token totals as `unavailable` unless `tokens` entries exist. Never estimate token counts. Report model calls only as the number of agents dispatched, which the orchestrator knows.

To judge whether the plugin is efficient, compare runs of similar mode and scope against a baseline. Compare total elapsed time, iterations, defects found after integration, and rework. A change that reduces tokens but raises defects or rework is reverted.

## Final report

Keep it short. Evidence only. Do not repeat the repository structure or the agent conversation.

```
Task: <one line>
Mode: <quick | standard | full | visual-fix | review-only>
Design reference: <path, URL, or "none">

Requirements: <completed / total>, with any not completed and why
Components: reused <list>; created <list>
Files changed: <list>

Tests: <command> -> <pass/fail counts, actual output summary>; regressions: <none or list>; pre-existing failures: <list>
Build and runtime: <command -> result>; console errors: <none or list>
Visual verification: <passing at viewports | incomplete (defects) | not performed (reason)>
Defects: fixed <n> (critical <n>, high <n>, medium <n>, low <n>); remaining <list with severity>

Gates: 1 <status>, 2 <status>, 3 <status>, 4 <status>, 5 <status>
Limitations: <list>
Telemetry: <stage durations>, iterations <n>, tokens <reported totals or "unavailable">
User approval: pending
```
