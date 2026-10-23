# Design analysis, contracts and ownership

## Design specification (design-analyst output)

Return this structure. Keep each item to one line where possible.

```
Reference: <file path, URL, or Figma link> at <viewport width x height>
Purpose: <what the page or component is for, in one sentence>
Layout: <regions, their order, grid or flex structure, and spacing rhythm>
Elements: <each visible element: role, text, icon or asset, position>
Typography and color: <tokens if the project has them; otherwise the observed values>
Assets: <icons, images, logos and where they come from>
Interactions: <actions a user can take, only where the design or the request shows them>
Data: <what each element displays, and what drives it>
States: <loading, empty, error, success, disabled, and responsive changes>
Requirements (explicit): <stated in the design or the request>
Assumptions (inferred): <each with the evidence it rests on>
Open questions: <only those that change correctness>
```

Rules:
- Explicit and inferred requirements are kept apart. An inferred item needs evidence, such as a visible control or a label.
- Do not invent business rules, validation limits, or copy that the reference does not show.
- If a state (loading, error, empty) is not in the design, list it as an assumption and implement the conventional behavior of the project, not a new design.

## Per-component questions

For each significant component, answer these before implementation:

1. What purpose does it serve?
2. What information does it show?
3. What actions can the user take?
4. What data or state drives it?
5. What validation and error states exist?
6. How does it behave at each viewport?
7. Which existing component or design token should it reuse?
8. How will its correctness be tested?
9. What visual evidence confirms its fidelity?

## Traceability matrix

One row per requirement. Keep it in the checkpoint.

| ID    | Requirement                        | Component / file            | Behavior                          | Test                          | Verification status                          |
| ----- | ---------------------------------- | --------------------------- | --------------------------------- | ----------------------------- | -------------------------------------------- |
| R-01  | Filter bar filters the table rows  | `src/features/x/Filters.tsx` | selecting a status narrows rows   | `Filters.test.tsx: filters`   | not started / implemented / tested / verified |

Verification status values: `not started`, `implemented`, `tested` (test ran and passed), `verified` (rendered and checked by visual-qa). A row is never `verified` on the strength of a passing unit test alone.

## Contract-first implementation

Before parallel coding, write these into the checkpoint:

- Component props and callback signatures.
- Shared type definitions and API response types.
- Route paths and their params.
- Design token names that will be used.
- The error-handling convention (throw, result object, or the project's existing pattern).

Independent agents implement against these contracts. A contract change after implementation starts is a handoff to the orchestrator, not a silent edit.

## File ownership

- Every work package lists the files it owns, the files it may read, and its dependencies.
- No two agents own the same file at the same time.
- Shared files (routes, global styles, barrel exports, shared types) have one owner, or are changed in Stage 5 by the orchestrator.
- `ownership.json` lists every path the run may write. It is the union of the owned files and the shared files named in the plan. The guard enforces that union. Assignment inside the union is enforced by the plan, not by the hook, because the hook cannot tell which agent is writing.

## Caching and invalidation

- The repository map is shared by backend-engineer, e2e-engineer and frontend-engineer. It lives at `.claude/repo-map/map.json`, one entry per file, each stamped with the commit it was mapped at.
- An entry is reused only while no commit after its stamp touched its file, the working tree has no change to it, and the file still exists. `repo-map.mjs status` reports the reusable entries and the stale paths.
- Without git nothing is cached, and every path is mapped again.
- The design spec is cached in the checkpoint with the reference's file hash or URL. Re-run design-analyst only when the reference changes.
- Never reuse a cached finding after the files it describes have changed.
