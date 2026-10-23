# Security audit: rubric, finding format and report

Read by the audit owner at Stage 0 and applied at Stage 3 and Stage 4.

## Severity rubric

Severity depends on what an attacker reaches, not on how a finding looks. Each level needs a reachable path.

| Severity | Use when the path exists and | Examples |
| --- | --- | --- |
| critical | an unauthenticated or low-privilege caller can read or change data they should not, run code on the server, or obtain a live credential | SQL built from request input on a public route; a live secret in tracked code; a route that skips its auth check |
| high | an authenticated user can reach another user's or tenant's data or an admin action, or a known exploitable dependency issue sits on a code path the app uses | missing ownership check on `/orders/:id`; a JWT accepted with `alg: none`; a vulnerable parser called on user input |
| medium | an attack needs extra conditions, or the impact is limited | no rate limit on login; CORS allows any origin with credentials; a password hashed with a fast hash |
| low | hardening with no direct path to data or code | verbose error messages in production; a container running as root with no exposed port |
| info | observation, not a defect | a deprecated but safe API; a note to review a policy |

Do not rate a finding critical because the code looks risky. Rate it by the path you traced.

## Finding format

Every finding has this shape, one per entry:

```
- [severity] <one-line issue> (path:line)
  Path: <entry point> → <step> → … → <sink>
  Evidence: <what the code does, in one or two lines; never a secret value>
  Mitigation checked: <what you looked for on the path and did not find>
  Fix: <direction, not a patch>
```

A finding with no path is not reported. Put it in "Not reviewed" with the reason, if it is worth a note.

## Report template

Write this to `.claude/security-audit/report.md`:

```
# Security audit report

Date: <today>. Scope: <whole repo | path | range>. Branch: <name> at <short sha>.

Status: clear | findings | blocked
Counts: critical <n>, high <n>, medium <n>, low <n>, info <n>

## Findings

| ID | Severity | Issue | Location | Fix direction |
| --- | --- | --- | --- | --- |
| SA-001 | critical | … | path:line | … |

(Detail for each critical and high finding, in the finding format above.)

## Dependency tools

| Tool | Version | Result |
| --- | --- | --- |
| <name> | <version> | ran: <n> advisories on used paths / not installed / not run: <reason> |

## Dropped without a path

- <candidate>: <why it has no reachable path>

## Checked and fine

- <area>: <what was checked and what was seen>

## Not reviewed

- <area>: <reason, such as "needs a running system" or "outside scope">
```

Status rules:

- `findings` when any finding is critical, high, medium or low.
- `blocked` when a required area could not be read, for example the auth code is missing from the checkout.
- `clear` only when no finding survives verification and every specialist ran. Even then, the report says what was
  not reviewed. Never write "secure".
