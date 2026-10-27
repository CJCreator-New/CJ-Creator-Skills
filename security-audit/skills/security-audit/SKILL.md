---
name: security-audit
description: Read-only security audit of a repository, a path, or a change set. Maps the attack surface, runs specialist reviewers for secrets, dependencies, access control, input handling and configuration, verifies each finding by tracing its path, and reports only issues with a reachable path. Never edits source and never exploits a running system. Use for a security review, a pre-release check, or an audit of auth, permissions, secrets or dependencies.
argument-hint: '<scope: whole repo (default), a path, or a branch or diff range, plus any threat-model notes>'
disable-model-invocation: true
---

# Security audit

Scope: $ARGUMENTS

You are the audit owner. Subagents cannot spawn subagents, so you dispatch the specialists with the Agent tool.
The audit is read-only. The only file it writes is its own report under `.claude/security-audit/`. The rubric,
the finding format and the report template are in `references/checklist.md`; read it once at Stage 0.

## Stage 0: Scope and preflight

1. Run `git status --short` and `git branch --show-current`. Record them. Do not change the working tree.
2. Resolve the scope. Default: the whole repository. A path limits the audit to that path. A branch or diff range
   (`main...HEAD`) limits it to the changed files, and the specialists still read the code those files call.
3. Read the project instructions once: root `CLAUDE.md`, `AGENTS.md` if present, and any security policy
   (`SECURITY.md`). Note any rule the project sets.
4. Start the run: `mkdir -p .claude/security-audit`, then write `audit` to `.claude/security-audit/phase`.
   While that file says `audit`, a hook blocks writes outside `.claude/security-audit/` and blocks commands
   that change state. Its limits are in the README.

## Stage 1: Attack surface map

Use Grep and Glob, not agents. Find and record, with paths:

- entry points: routes, handlers, controllers, CLI commands, webhooks, queue consumers, scheduled jobs
- authentication and authorization code, session and token handling, role and permission checks
- data stores, migrations, raw queries, and where user input reaches them
- outbound requests, file reads and writes driven by input, deserialization, template rendering
- secrets configuration: env files, config modules, CI secrets, vault references (names only)
- dependency manifests and lockfiles, and the package manager in use
- CI/CD, container and infrastructure-as-code files

Write the map to `.claude/security-audit/surface.md`, one line per item. Keep it short. It is the context pack
for every specialist.

## Stage 2: Specialist review

Dispatch in one message the specialists the surface needs. Skip one only with a stated reason.

| Specialist | Runs when | Question it answers |
| --- | --- | --- |
| `secrets-scanner` | always | Are credentials in the code, history, config, or tracked files? |
| `dependency-auditor` | a manifest or lockfile exists | Do dependencies have known vulnerabilities that the code uses? |
| `access-control-reviewer` | any entry point or auth code | Does every protected action check who is calling and what they may touch? |
| `input-handler-reviewer` | any entry point, query, fetch, file or render path | Can untrusted input reach an interpreter, a path, a URL, or a renderer? |
| `config-reviewer` | CI, container, IaC, or server or framework config exists | Are defaults, headers, CORS, TLS, cookies, and CI permissions safe? |

Give each specialist a context pack, not this conversation: the scope, the path to `surface.md`, its checks, and
the reply shape. Each reply uses the same shape: `Status`, `Findings`, `Checked and fine`, `Not reviewed`.

## Stage 3: Verify findings

Specialists propose. You decide.

1. Merge the replies and remove duplicates. The same root cause reported twice is one finding.
2. For every critical and high finding, read the code yourself and confirm the path from entry point to sink.
   Look for an existing mitigation on that path, such as a middleware check, a parameterized query, or an allowlist.
3. Downgrade or drop findings with no reachable path. Record each drop with its reason, so it can be reviewed.
4. Assign severity with the rubric in `references/checklist.md`. Do not raise severity to make a report look fuller.
5. Confirm no secret value appears in any finding. Secrets are reported by location and type only.

## Stage 4: Report

1. Write `.claude/security-audit/report.md` from the template in `references/checklist.md`.
2. Record which dependency tools ran, with their versions. Record any that were not installed as not run. Do not
   install them.
3. Finish the run: use the Write tool to overwrite `.claude/security-audit/phase` with `done`. The guard then
   stops blocking. Do not delete the file with Bash, because the guard checks that command too.
4. Reply in chat with: `Status` (clear, findings, or blocked), counts by severity, the critical and high items
   with their location, what was not covered, and the path to the report.

## Hard rules

- Never edit application source, configuration, lockfiles or git state. Never commit, push, or install packages.
- Never print a secret value, a token, or the contents of a `.env` or key file. Confirm secrets by name and location.
  Find tracked secret files with `git ls-files`, not by reading them.
- No active testing against any running system: no exploit attempts, no scanning, no load, no login attempts.
  Read code and configuration only. A live check you would need goes under "Not reviewed".
- Report only issues with a reachable path. Do not list theoretical concerns.
- Never write "secure" or "no vulnerabilities". Say "no findings in scope" and list what was not checked.
