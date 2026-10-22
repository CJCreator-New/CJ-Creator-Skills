# e2e-engineer analyst trial

Date: 2026-10-22. The analysts had only been checked against a hand-written plan. This trial ran them, as agents, on an application they had not seen, and measured two things: what they find, and whether what they return loads into the ledger and freezes.

## The application

A copy of the planted-app fixture, made to read like an ordinary repository: every planted flag resolved to the buggy behaviour (so the code simply has the defects), the flag names, comments and `PLANTED` switch removed, and the plan, the defect manifest and the flaky cases left out. It has `server.mjs`, `schema.sql`, `seed.json`, `openapi.json`, `public/index.html`, and an `android/` folder with a manifest and strings. The analysts got only that folder and their own agent instructions.

## Trial 1: the analysts in parallel, with the v1.0 instructions

`flow-analyst`, `rbac-analyst` and `ux-analyst` ran at the same time, as `SKILL.md` then said.

**Discovery was strong.** Between them, the three reported every planted defect that lives in the application (12 of 13; number 11 is a property of a test suite, not of the app) as a contradiction, a gap or a `ui-only` finding, each with the file and line:

| Planted defect | Reported by |
| --- | --- |
| 1 Export has no handler | flow (gap), ux (gap) |
| 2 No validation on create | flow (contradiction with the 422 contract), ux |
| 3 Approve is hidden, not refused | rbac (`ui-only`), flow (contradiction) |
| 4 Another tenant's order is readable | rbac (not enforced), flow, ux |
| 5 No 1000 limit for managers | rbac, flow |
| 6 Concurrent approvals both succeed | rbac (the 50 ms window), flow |
| 7 Total returned as a string | flow, ux |
| 8 A refused approval shows "Approved" | flow, ux, rbac |
| 9 Table clipped at phone width | flow, ux |
| 10 Total input has no label | flow, ux |
| 12 Targets under 24 px at phone width | flow, ux |
| 13 Debuggable, cleartext, hardcoded key | flow, ux |

They also found real issues the fixture did not plant: tokens are never revoked on sign-out, an undefined "director rule" in the contract, colliding order ids under concurrent creates, plaintext passwords in the seed, and an exported Android activity.

**The output did not join up.** Run in parallel, each analyst invented its own way to name the others' items:

- `flow-analyst` named screens by route ("Sign in (#/login)"), operations by method and path ("POST /api/login"), and journey permissions by role name. It defined no operations at all, though the plan needs them. One journey named no role.
- `rbac-analyst` put requirement text, not requirement ids, in `requirements`, invented permission ids, and added an `anonymous` role with no account.
- `ux-analyst` wrote notes into control ids ("login-username (name=username, no DOM id)").

None of this passes the plan check, which refuses every reference it cannot resolve: journey screens, operations and permissions, permission requirements, and control references written as prose.

**Changes made:**

1. The analysts run in order, `ux-analyst`, `flow-analyst`, `rbac-analyst`, `test-strategist`, each given the earlier outputs, in `SKILL.md`.
2. Each prompt states the id rule (`^[A-Za-z0-9][A-Za-z0-9._-]*$`, notes in their own field) and which ids to use for the others' items.
3. `flow-analyst` defines `operations` and names each journey's `PERM-` ids; every journey names a role.
4. `rbac-analyst` fills the permissions the journeys name, uses requirement ids, records the unauthenticated outcome as `unauthenticated` instead of a role, and records `enforcement` per rule.

## Trial 2: the analysts in order, with the changed instructions

Each analyst read its real agent file from the plugin and wrote its JSON to a file; the next one read the earlier files.

**The output joins up.** All four outputs loaded into one ledger with `loadPlan`, and every reference between them resolved:

| Item | Count | From |
| --- | --- | --- |
| Screens (12 controls) | 4 | ux-analyst |
| Requirements | 27 | flow-analyst |
| Operations | 6 | flow-analyst |
| Journeys (6 P0) | 10 | flow-analyst |
| Roles, permissions | 3, 3 | rbac-analyst |
| Test cases, fixtures | 70, 22 | test-strategist |

The plan check found 3 errors in the whole plan, where trial 1's cross-references did not resolve:

- P0 journey J-08 has no failure branch (flow-analyst).
- Journey J-09 names a permission but has no permission branch (flow-analyst).
- Test case TC-OPS-01 is linked to no journey (test-strategist).

The prompts state each of these rules. The plan check refuses each one, which is how the orchestrator finds them and sends them back. Coverage was complete for what the analysts recorded: every requirement, journey, screen, control, permission and operation has a test case.

**What the catalogue would catch.** Of the 12 planted defects that live in the application, the 70 planned test cases target 9: validation (2), the staff approval (3), another tenant's order (4), the 1000 limit (5), concurrent approvals (6), the total's type (7), a refused approval shown as success (8), reflow at 320 px (9), and the debuggable manifest (13). Three had no test case, and the strategist reported each as a gap instead of inventing a requirement:

- **The Export button (1).** Nothing in the repository says what Export should do. This is a decision for a person; in the fixture plan it is a requirement the user confirmed.
- **The unlabelled Total field (10) and the small touch targets (12).** ux-analyst recorded both as objective checks, but they reached no requirement, so no test could cite one.

rbac-analyst also recorded one manager role for both tenants, so four tenant-boundary test cases had no account for the second tenant. The strategist reported that as a gap too.

**Changes made after trial 2:**

1. ux-analyst turns each objective check into a `REQ-UI-` requirement with the standard as its oracle source, marked derived where the team has not chosen a level (24 or 44 px).
2. flow-analyst refers to those, and checks its branch rules before it returns.
3. rbac-analyst records a role per tenant when the seed has the same role in several tenants.
4. test-strategist checks its own references and journeys before it returns.
5. `SKILL.md` sends each analyst's gaps and plan-check errors back to their owner once, and sends a gap that needs a decision to the user.

These last changes have not been re-trialled.

## What this shows

- The analysts find real defects, including ones the fixture did not plant, from the code and the contract alone.
- Run in order with the id rules, their output loads and its references resolve. Run in parallel, the references do not.
- The plan check is the loop that catches what the prompts miss. A frozen plan has none of these errors, because a plan with errors does not freeze.
- Requirements that only a person can set (what Export does, the touch-target level) stay gaps or derived requirements until the user decides, as the oracle rules require.
