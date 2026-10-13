---
description: Approve Forge tickets and run them with parallel subagents (all | phase N | ticket IDs)
argument-hint: all | phase N | <ticket IDs> [--test-mode per_phase]
allowed-tools: Bash, Read, Agent
---
Approve: $ARGUMENTS (if empty, ask which). `F` = `python3 .claude/forge/forge.py`. Terse; no file dumps.

1. `F approve <args>` (same args). Show any WARNING lines.
2. Step 5/9 - Execute (print the banner). Loop:
   a. `F ready [--phase N]` -> JSON. Empty `batch`: stop looping.
   b. For each id in `batch`: `F ticket <id> running`, then `F brief <id>`; use its output VERBATIM as the subagent prompt.
   c. Launch all batch tickets in ONE message as parallel Agent calls: subagent_type `forge-dev` (`forge:forge-dev` if namespaced), `model` from `models` (opus only if complex), `isolation: "worktree"` when `worktree` is true and this is a git repo (otherwise run them one at a time).
   d. Per reply (DONE | GAP | BLOCKED): `F result <id> --status done --summary "<short>" --closing "<line>" [--closing "<line>"]`. GAP/BLOCKED: `F result <id> --status blocked --gap "<why>"` and tell the user now; keep going with independent tickets.
   e. Merge any worktree branches into the working tree, resolve conflicts, remove the worktrees.
   f. Repeat. If the user approved only a phase or IDs, stop when they are done.
   g. If test mode is `per_phase`, run the testing stage (step 3) when a phase completes.
3. Step 6/9 - Token accounting runs automatically in hooks. Run `F status`. Tickets without exact usage show "estimated"; never invent actuals.
4. Step 7/9 - Testing, when all approved tickets are done (default mode `end`): `F step 7`, `F tests running`, launch `forge-tester` (pass the changed files from `F export`, and "fix loop N" if repeating). On FAIL: `F plan .claude/forge/work/fixes.json --append`, `F approve <fix ids>`, go back to step 2 (max 2 fix loops, then ask the user).
5. On pass: show `F status` output and say: run `/forge-handoff` for the handoff and doc updates.
