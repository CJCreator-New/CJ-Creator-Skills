# security-audit

A Claude Code plugin for read-only security audits. It maps a repository's attack surface, runs
specialist reviewers for secrets, dependencies, access control, input handling and configuration,
checks each finding by tracing its path from an entry point to the code that acts on it, and writes a
report. It never edits source, never commits, never installs packages, and never tests a running system.

## Install

The quickest route is the repo-wide installer in the root README, which installs this plugin with Forge.
To install only this plugin, add the marketplace this repo ships (`.claude-plugin/marketplace.json`):

```
/plugin marketplace add CJCreator-New/CJ-Creator-Skills
/plugin install security-audit@forge-marketplace
```

For local development, load the folder straight from a checkout:

```
claude --plugin-dir ./security-audit
```

## Use

Invoke the audit explicitly. It is not auto-triggered, because a full run dispatches five agents:

```
/security-audit:security-audit
/security-audit:security-audit src/api
/security-audit:security-audit main...HEAD
/security-audit:security-audit whole repo; the admin area is internet-facing, focus on auth
```

The argument sets the scope: the whole repository by default, a path, or a branch or diff range. Any
threat-model notes you add are used as context.

## What a run does

| Stage | What happens | Writes |
| --- | --- | --- |
| 0 Scope | git status and branch recorded, scope resolved, project instructions and `SECURITY.md` read | `.claude/security-audit/phase` |
| 1 Surface | entry points, auth code, data stores, outbound requests, secrets config, pipelines, manifests | `surface.md` |
| 2 Specialists | up to five read-only agents in one message, each skipped only with a stated reason | none |
| 3 Verify | duplicates merged, critical and high paths traced by the owner, unreachable findings dropped with a reason | none |
| 4 Report | status, counts, findings with paths and fix directions, dependency tools run, what was not covered | `report.md` |

The report is written to `.claude/security-audit/report.md`. Its status is `findings`, `blocked`, or
`clear`. `clear` is given only when no finding survives verification and every specialist ran. The
report never says "secure".

## Specialists

| Agent | Looks for |
| --- | --- |
| `secrets-scanner` | credentials in tracked files, configuration, and git history. Reports locations and types, never values |
| `dependency-auditor` | known advisories, checked for reachability. Runs only audit tools already installed |
| `access-control-reviewer` | missing or late authorization checks, ownership gaps (IDOR), token and session handling, account flows |
| `input-handler-reviewer` | untrusted input reaching queries, shells, file paths, server-side fetches, renderers, deserializers |
| `config-reviewer` | CI permissions and secret exposure, container and IaC defaults, CORS, headers, cookies, TLS verification, debug modes |

Severity follows the rubric in `skills/security-audit/references/checklist.md`. Severity depends on the
path an attacker can reach, not on how risky the code looks.

## Components

```
security-audit/
├── .claude-plugin/plugin.json           manifest
├── skills/security-audit/
│   ├── SKILL.md                         entry point, stage order, hard rules
│   └── references/checklist.md          severity rubric, finding format, report template
├── agents/
│   ├── secrets-scanner.md               read-only, credentials
│   ├── dependency-auditor.md            read-only, advisories with reachability
│   ├── access-control-reviewer.md       read-only, authn and authz
│   ├── input-handler-reviewer.md        read-only, untrusted input to sinks
│   └── config-reviewer.md               read-only, security configuration
├── hooks/
│   ├── hooks.json                       PreToolUse on Write, Edit, MultiEdit, NotebookEdit, Bash
│   └── guard-readonly.mjs               denies writes and state-changing commands
├── scripts/validate.mjs                 structure checks for the plugin and marketplace
└── test/
    ├── plugin-structure.test.mjs        runs the validator
    └── guard-readonly.test.mjs          hook tests, including agent list against agent files
```

## Read-only guard

The guard reads `.claude/security-audit/phase` in the project before each relevant call:

| Caller | Phase file | Writes | Commands that change state |
| --- | --- | --- | --- |
| any audit agent | any | denied | denied |
| main session | `audit` | only under `.claude/security-audit/` | denied |
| main session | missing or `done` | allowed | allowed |

The skill writes `audit` at the start and `done` at the end. It writes `done` with the Write tool, not by
deleting the file, because the guard also checks Bash commands.

The guard matches common write patterns: `git` commands that change state, `rm`, `mv`, `cp`, `sed -i`,
redirects to files, package installs and updates, `docker` build and run, `curl` with a write method, and
`--fix`. Read-only forms such as `git diff`, `git log`, `npm audit`, and `2>/dev/null` are allowed.

It is a workflow guard, not a sandbox. It fails open on malformed input so it never breaks a session. It
cannot see a write made by a script the agent runs, by a command that uses an unlisted tool, or by
an indirect route such as a build step. The read-only rule for agents also rests on their instructions.

## Validation

```
node security-audit/scripts/validate.mjs
node --test security-audit/test/plugin-structure.test.mjs security-audit/test/guard-readonly.test.mjs
claude plugin validate security-audit
```

## Limitations

- It reads code and configuration only. It does not test a running system, so authorization and input
  findings are inferred from the code and can be wrong when a gateway or database policy enforces the check.
  Those are listed under "Not reviewed" when they matter.
- Dependency results depend on the audit tools installed on the machine. The report records which ran.
  The plugin does not install them.
- Static analysis by reading code can miss issues that depend on runtime data, deployment, or infrastructure
  outside the repository.
- Subagents cannot spawn subagents. The main session dispatches all specialists.
- Model choice is inherited from the session for every specialist, so the cost of a run follows the
  session's model.
