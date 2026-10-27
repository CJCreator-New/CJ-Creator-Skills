# User-flow intelligence

The application is a set of connected business workflows. A screen is not a feature, and an endpoint is not a journey. Work from what the user is trying to accomplish.

## Interaction classification

For every meaningful interaction, answer these before deciding whether it needs the backend:

1. Who can perform it?
2. What outcome does the user intend?
3. What must already be true?
4. What input does it need?
5. What validation does it need?
6. Is it local (client state only) or does it need backend work?
7. Which API or domain operation does it use?
8. Which permissions does it need?
9. Which records does it read or change?
10. Which business rules govern it?
11. Which state transitions can it cause?
12. What does the user see on success?
13. What happens on failure?
14. Can it be retried safely?
15. Which test proves it?

Classify each interaction with `classification: "local"` and a `reason`, or `"backend"` with a `journeyId`. A tab switch, an accordion or a local filter over data already on the screen is local. A save, a submit, a status change, a search over server data, or an export is backend. When the evidence does not settle it, record it as an unresolved question, not as local.

## Journey graph

Node types: user roles and authentication states, routes and screens, controls and forms, API endpoints, services and business operations, database entities and state transitions, external services, background jobs and notifications, and the success, error, cancellation and recovery states.

Edge types: user interaction, navigation, API request and response, authorization decision, business-rule dependency, database read or write, external integration, state transition, asynchronous notification, and error or recovery path.

Trace each critical journey through all of these, in order:

user action → frontend behavior → API contract → authentication and authorization → business validation → database or external operation → response → visible UI outcome.

Map the failure branches as well: permission denial, validation error, missing or stale data, duplicate submission, concurrent change, timeout, retry, cancellation, and recovery. A journey is not complete because its API returns 200. The intended business outcome and the resulting stored state must both be correct.

## Journey record

Each journey has an ID and records:

- the requirement IDs it serves,
- the role,
- the starting state,
- the steps, each with its UI element and the API it calls,
- the success outcome,
- the failure branches,
- the paths it depends on (`dependsOn`), which decide when its verification goes stale,
- its priority.

A journey with no `dependsOn` cannot be verified, because the ledger has no files to fingerprint. Name the directories the flow actually runs through.

## Coverage

Every high-priority requirement maps to at least one journey, or to an explicit reason it is not implemented. The release status treats a high-priority requirement with no journey as not release ready.

Each meaningful interaction is either mapped to a journey or classified local. The ledger validates the classification. It cannot tell you that you missed an interaction, so the requirements analyst must read every route and component that handles an action.

## Ambiguity

A business rule the evidence does not settle is an `unresolved` requirement, and it cannot be implemented until someone decides it. The ledger refuses to mark an unresolved requirement as implemented. A decision with `blocks` naming a journey blocks that journey, and the release status is Blocked while it stays open.

Ask about money, permissions, compliance, data retention and workflow transitions first. Ask one question with the consequences of each answer. Continue independent work while the answer is pending.

Never choose the easier rule. Never fill a gap in a requirement with a default that the user has not seen.
