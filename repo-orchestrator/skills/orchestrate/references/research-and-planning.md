# Research and planning reference

Loaded by `orchestrate` at Stage 2. Keep it short; the orchestrator decides, this file only defines the method.

## Repository map (what a researcher returns)

For its assigned area only:

- Relevant files and symbols, with `path:line`.
- Entry points, routes, handlers, and their callers.
- Upstream dependencies (imports, config, env assumptions) and downstream dependents.
- Data and control flow for the requested behavior.
- API, schema, and database contracts touched.
- Authorization and permission checks on the path.
- Existing implementation pattern to follow (name one concrete example).
- Existing tests for the area and the command that runs them. Do not run it.
- Likely impact area and integration conflict risk.

Rules:

- Trace relationships through imports, call sites, route definitions, and queries. Do not assume similar names are related.
- Mark each claim as observed (with a location) or assumed.
- Do not invent files, endpoints, or tests. If something is missing, say "not found" and where you looked.
- Stop expanding when evidence stops adding decisions.

## Task spec (orchestrator output)

Include only sections that apply:

- Problem statement and current behavior.
- Expected behavior and functional requirements.
- Constraints and behavior that must be preserved.
- Affected modules.
- API or data contract changes.
- Security and permission requirements.
- Edge cases and error handling.
- Acceptance criteria (source: user or ticket).
- Implementation scope and out-of-scope items.
- Definition of done.

Label each item `explicit` or `inferred`. Inferred items cite the repo evidence that justified them.

## Classification to planning

| Signal                      | Adds                                                                  |
| --------------------------- | --------------------------------------------------------------------- |
| Migration or schema change  | shared contract task first; data-integrity review                     |
| Auth, roles, or permissions | `security-reviewer` read-only pass                                    |
| Public API or exported type | contract task first; check every caller                               |
| UI with a shared API        | contract first; UI and API tasks in parallel                          |
| Bug fix                     | reproduce by reading; smallest fix; regression check in verification  |
| Build or test failure       | skip Stages 4-6 if the fault is already located; go to Stage 8        |
| Refactor                    | no behavior change allowed; verification must cover the same behavior |

## Task graph classes

- A. Independent research
- B. Shared-contract definition
- C. Independent implementation
- D. Dependent implementation
- E. Integration and readiness review
- F. Final testing and remediation

Order: A and B first, then C in parallel with D after its inputs, then E, then F.

Do not parallelize inherently sequential work (for example a migration and the code that reads its new column).

## File ownership

- One owner per file that may change. Ownership is written in the plan before dispatch.
- Overlapping files serialize. Shared files (route tables, index exports, config) go to the integration owner.
- Use a separate git worktree only for a high-conflict parallel task, and only when the repo's instructions allow it.

## Parallelism

- Parallel means several Agent calls in one message. Fan out only when the tasks are independent and each has enough context to finish.
- One agent is enough for a small isolated task. Coordination costs more than it saves below that size.
- Read-only researchers may run alongside each other freely. Editing agents never share a file.

## Ticket intelligence

- Use a ticket integration only if the session exposes one as a usable tool. Otherwise use the user's text.
- Pull: description, acceptance criteria, status, priority, parent and child items, blockers, linked specs.
- Record what came from the ticket versus what was inferred.
- Do not update a ticket, comment on it, or change its status without explicit user approval.

## Prompt enhancement

Turn a rough request into the spec above. Do not expand scope. A feature idea becomes a spec with the smallest behavior that satisfies the request. Anything beyond that is listed as out of scope, not built.
