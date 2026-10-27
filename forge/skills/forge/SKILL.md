---
name: forge
description: Runs the Forge feature workflow (project map, enhance, phased plan with token estimates, approval gate, build, test, dev handoff). Use only when the user explicitly asks to forge a feature, or to approve, test, hand off or check a Forge run. Not for ordinary coding requests.
argument-hint: "<feature request> | approve all|phase N|<ids> | test | handoff | status"
license: MIT
---

# Forge

A token-efficient feature workflow that runs from any agent CLI or IDE that can run shell commands. Tool-specific extras (parallel subagents, exact token counts from transcripts, the Claude Code status bar) are optional; the workflow below works without them.

Conventions:
- `F` means `python .claude/forge/forge.py` inside the project. If `python` is not found (common on Windows), use `py -3` or `python3`.
- Be terse: summaries, never file dumps or pasted logs.
- The scripts are stdlib-only Python 3.8+. Git is optional.

## Setup (once per project)

1. The Forge plugin folder is the folder that contains `scripts/forge_cli.py`. From this file (`skills/forge/SKILL.md`) it is two levels up.
2. Run `python <plugin>/scripts/forge_cli.py init`. It creates `.claude/forge/` (git-ignored) and the `F` launcher.
3. Run `F new-run "<3-6 word name>" --request "<raw request>"`.
4. Tell the user once: the dashboard is `.claude/forge/dashboard.html` (always) or `F dashboard` (a local server with a browser UI). For a live terminal view, run `F watch` in a second terminal.

Each step: run `F step N` (it prints the banner `Step N/9 - <name>`) and start that part of your reply with it.

## Step 1/9 - Project map

Run `F map-status`. If the map is missing or stale, write `.claude/forge/PROJECT_MAP.md` (under about 3k tokens). Prefer `git ls-files`, grep and symbol lookups. Read only manifests, README, CLAUDE.md or AGENTS.md, and small line ranges. Never read lockfiles, generated code or large assets. Use these sections: Stack / Layout / Entry points / Layers and module boundaries / Key symbols (name - file:line) / Conventions / Reusable helpers / Tests (framework, run-one and run-all commands) / Build and lint commands / Do not read.
Then run `F dnr set <patterns>` (this project's generated, vendored and large-asset paths) and `F map-stamp`. If the map is over budget, trim it and stamp again.

## Step 2/9 - Enhance

Turn the raw request into an exact spec. Read the map, then search with grep/glob and read only the line ranges needed. Apply "does it need to exist?": the smallest version that does the core job, prefer reuse, and list everything left out.
Write `.claude/forge/work/enhanced.json`:
`{"goal","acceptance":[],"non_goals":[],"skipped":[],"assumptions":[],"risks":[],"open_questions":[],"pushback":[],"smaller_option":"","context_pack":{"read":["path:a-b"],"edit":["path"],"create":["path"],"symbols":["name file:line"],"imitate":["path:a-b"],"conventions":[],"rule":"Do NOT explore outside this list."}}`
Then run `F enhanced .claude/forge/work/enhanced.json`. Fix any error it prints.
Show the spec in at most 25 lines: goal, acceptance criteria, non-goals, skipped, assumptions, risks, blocking questions, and the context pack as a short file list. Level (`F level`): at lite, show the smaller option and let the user choose; at ultra, list the pushback items and ask the user to confirm each.
If the instructions section is missing (`F claude-md check`), show `F claude-md show --file <file>` and apply it after OK. Use `CLAUDE.md` for Claude Code and `AGENTS.md` for other tools.
**Stop and wait** for edits or OK.

## Step 3/9 - Plan

After OK, write `.claude/forge/work/plan.json` and run `F plan .claude/forge/work/plan.json` (`--append` adds tickets). Fix any error.
`{"phases":[{"id":"P1","title":""}],"tickets":[{"id":"P1-T1","phase":"P1","title":"","description":"","edit":["path"],"create":["path"],"read":["path:a-b"],"symbols":[],"imitate":["path:a-b"],"conventions":[],"deps":[],"group":"A","complexity":"S|M|L|complex","tests_later":["one small self-check"],"diff_lines":20}],"skipped":[]}`
- Slice the context pack per ticket: exact paths or `path:a-b` ranges only.
- Keep `diff_lines` honest and small. Do not guess token numbers; the CLI computes them.
- Tickets with the same `group` run together. Tickets that share files go in different groups or depend on each other.
- Mark `complexity: complex` only for cross-cutting or subtle work.
Reply in 5 lines: ticket count, total estimate, anything flagged.

## Step 4/9 - Approval gate (hard stop)

Run `F dashboard` and give the user the URL (if the server does not start, give `.claude/forge/dashboard.html`). Run `F status --brief` and show its output as is. List the skipped items, one line each. Say that the user can add details to any ticket on the dashboard and send messages there.
Approve with `F approve all`, `F approve phase N` or `F approve <ids>`. Add `--test-mode per_phase` to test after each phase (default: once at the end). In Claude Code, the same is `/forge-approve`. To drop scope, use `F drop <ids>` or re-plan.
**Execute nothing. End your turn.**

## Step 5/9 - Execute (after approval)

Work in a rolling loop. Do not wait for a whole wave.
1. Before each wave, run `F inbox`. For each message the user sent from the dashboard: a message naming a ticket is already in that ticket's brief. Any other message is an instruction. Follow it if it only changes how the work is done. Ask first if it changes scope. Reply with one line per message you act on.
2. Run `F ready [--phase N]`. It returns JSON with `batch` (ids to start now), `deferred` and `models`.
3. For each id in `batch`: run `F ticket <id> running`, then `F brief <id>`. The brief is the complete instruction for one worker.
4. Run the workers:
   - **If your tool can run subagents in parallel**, launch one per brief, all at once, in the background. In Claude Code, use the Agent tool with `subagent_type` `forge-dev` (or `forge:forge-dev`), `model` from `models` (opus only for `complex`), and `run_in_background: true`. Other tools: use their subagent or background-task feature in the same way.
   - **Otherwise**, carry out each brief yourself, one ticket at a time. Follow its rules: read only the listed ranges, make targeted edits, do not run tests.
   - If a worker does not receive the ponytail rules automatically, prepend the output of `F ponytail`.
5. When a worker reports DONE, GAP or BLOCKED: run `F result <id> --status done --summary "<short>" --closing "<line>"`. For GAP or BLOCKED, run `F result <id> --status blocked --gap "<why>"` and tell the user now.
6. Run `F ready` again and start its batch at once. A finished ticket can unblock its dependents right away.
7. Stop when `F ready` returns an empty batch and nothing is running. Deferred tickets wait for files a running worker holds; a later `F ready` picks them up.
8. If the user approved only a phase or some ids, stop when they are done. In `per_phase` test mode, run step 7 when a phase completes.

Workers share one working tree. `F ready` never gives two running tickets the same file, so no worktrees and no merge step are needed.

## Step 6/9 - Token accounting

Run `F status --brief`. Tickets without exact usage show `estimated`. Never invent actuals. Exact usage comes only from Claude Code hooks, so `estimated` is the normal result in other tools.

## Step 7/9 - Testing

Run `F step 7` and `F tests running`. Run the tests yourself, or with a tester subagent if your tool has one. Use the test commands in `PROJECT_MAP.md` (Tests). Run the tests relevant to the changed files first (`F export` lists them as `touched`), then the full suite once, including the small self-checks the workers wrote.
Summarize each failure as test, file:line, one-line cause. Never paste logs. Record the result: `F tests pass|fail --summary "<one line>"`.
On failure, write `.claude/forge/work/fixes.json` in plan format (phase `FIX`, ids `F<loop>-<n>`, one ticket per root cause), then run `F plan .claude/forge/work/fixes.json --append` and `F approve <fix ids>`, and go back to step 5. Allow at most 2 fix loops, then ask the user.
On pass: run `F status --brief` and tell the user to run the handoff.

## Step 8/9 - Dev handoff

Run `F step 8`.
1. **Plan:** list the files you will create or modify: `docs/handoffs/<slug>-<YYYY-MM-DD>.md`, plus README, CHANGELOG or API docs only if they exist and the change affects them, and `CLAUDE.md` or `AGENTS.md` only for new conventions, commands or gotchas. **Stop for the user's OK.** They may remove items.
2. **Write** only the approved files. Take every number from `F export` (JSON) and never invent one. The handoff has these sections: Summary / What changed and why / Tickets and commits (`git log --oneline` if git is available) / Files touched / Decisions and trade-offs / Tests run and results / Token report (estimated vs actual vs saved; mark unmeasured tickets `estimated`; saved is an estimate) / Skipped, unchecked and risks / `shortcut:` comments (from `F shortcuts`) / Known issues / Follow-ups / How to verify.
3. Refresh the map: rebuild `.claude/forge/PROJECT_MAP.md` as in step 1, then `F map-stamp`.

## Step 9/9 - Final

Run `F finish`, show its output and the handoff path. Offer one next step only if there is a real one.

## Command reference

| Command | Use |
|---|---|
| `F new-run "<name>" --request "<text>"` | start a run |
| `F step N` | set and print the step banner |
| `F map-status`, `F map-stamp`, `F dnr set <patterns>` | project map |
| `F enhanced <file>`, `F plan <file> [--append]` | spec and plan from JSON |
| `F approve all\|phase N\|<ids> [--test-mode per_phase]` | approval gate |
| `F drop <ids>` | remove tickets |
| `F ready [--phase N]` | next batch of tickets |
| `F ticket <id> running`, `F brief <id>` | start a ticket; print its worker brief |
| `F result <id> --status done\|blocked [--summary] [--closing] [--gap]` | record a worker's result |
| `F tests none\|running\|pass\|fail [--summary]` | record testing |
| `F inbox` | read dashboard messages |
| `F status [--brief]`, `F dashboard`, `F watch`, `F render` | views |
| `F detail <id> <text>` | add a detail to a ticket |
| `F shortcuts`, `F export` | data for the handoff |
| `F claude-md check\|show\|apply [--file CLAUDE.md\|AGENTS.md]` | instructions section |
| `F level lite\|full\|ultra`, `F ponytail` | ponytail level and rules |
| `F finish` | final summary |

## Limits outside Claude Code

- No hooks: token counts stay `estimated`, and read guards are not enforced. The brief's "read only these" rule still applies.
- No parallel subagents: tickets run one at a time. The batching logic still prevents two tickets from sharing a file.
- The Claude Code status bar (`F statusline`) and the `forge-*` subagent definitions in `agents/` are Claude-only. Other tools use the briefs directly.
