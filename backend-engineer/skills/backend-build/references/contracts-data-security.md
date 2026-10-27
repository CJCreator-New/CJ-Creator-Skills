# Contracts, data, security and integrations

## API contract

Every operation the journeys need is defined before parallel implementation starts. For each operation the contract records:

- the purpose and the journey it serves,
- the method and route, or the equivalent message or RPC contract,
- the authentication requirement,
- the authorization policy: who may call it, and on which resource,
- the request schema and its validation,
- the response schema,
- the success and error status codes,
- the business preconditions,
- the data read and written,
- the transaction boundary,
- the idempotency behaviour, for any operation that a repeat could harm,
- the pagination, filtering and sorting, for list operations,
- the audit and logging the operation requires,
- the contract, integration and end-to-end tests it needs.

Use one error format. It distinguishes validation failure, authentication failure, authorization failure, missing resource, conflict, rate limit and unexpected server error. Errors never include stack traces, SQL, or internal identifiers.

Validate every request at the server boundary. Reject unknown fields rather than storing them. Put business rules in the service or domain layer, once. Enforce critical invariants in the database where feasible.

Keep the OpenAPI document and any generated types in sync with the implementation. When a contract changes, find every consumer and revalidate it.

## State transitions

Each stateful entity lists its states and each allowed transition: from which states, by which operation, with which preconditions. A transition not in the contract is a gap. Enforce each transition with a conditional update, such as `UPDATE ... WHERE status = 'draft'`, or inside a transaction. A read followed by a write is not enough under concurrency.

## Database

- Schema changes are migrations. Prefer backward-compatible steps: add, backfill, use, then tighten.
- Preserve existing data unless an authorized migration says otherwise.
- Use foreign keys, uniqueness, not-null and check constraints where the business rule requires them.
- Add indexes for the query patterns the contracts name.
- A multi-write operation that must succeed or fail together runs in one transaction.
- A committed migration is never edited.
- Every irreversible change is marked and needs the orchestrator's approval before it runs.
- Test each migration against a real database. A mock does not prove a constraint.

Each stored value has one authority. A copy elsewhere is derived from it, and the derivation is named.

## Concurrency and idempotency

- Protect shared updates with a conditional update, a row lock, optimistic versioning, or a unique constraint.
- Every operation that could be repeated (a double-click, a retry, a redelivered webhook) either deduplicates on an idempotency key stored with the result, or is naturally idempotent. Name which one.
- An external side effect cannot share a database transaction with a local write. Use a transactional outbox, a durable job, or a compensating action, and name the reconciliation path.

## Security

Every protected operation:

- requires authentication on the server,
- checks authorization against the specific resource, including the owner and the tenant,
- validates input against an allow-list of fields,
- binds parameters in queries,
- returns only the fields the caller may see,
- logs without tokens, passwords or personal data.

Do not rely on the frontend. Hidden buttons, disabled controls and route guards are usability, not security.

Do not add an authentication system when one exists. If the repository has none for an operation that needs one, that is a gap to report.

Negative tests are required: unauthenticated, insufficient role, another owner, and another tenant. Each must fail with the contract's error and change nothing.

Secrets come from the environment or a secrets manager. Never commit a secret, never log one, and never print one in documentation.

## Integrations

For each external service, document: its purpose, the data exchanged, how it authenticates and where its secret comes from, its timeout, its retry policy and which failures are retryable, its rate limit, its idempotency mechanism, how it validates responses, its failure and recovery behaviour, what is logged, the test double used, and whether it was verified live.

Retries are bounded and apply only to safe operations. Webhooks verify the signature over the raw body with a constant-time comparison, reject stale timestamps, and process each event ID once.

If a live integration could not be exercised, record it as not verified. Do not describe a stub as a live test.
