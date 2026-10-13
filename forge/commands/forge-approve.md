---
description: Approve Forge tickets and run them with parallel subagents (all | phase N | ticket IDs)
argument-hint: all | phase N | <ticket IDs> [--test-mode per_phase]
allowed-tools: Bash, Read, Agent
---
Approve: $ARGUMENTS (if empty, ask which). `F` = `python .claude/forge/forge.py`. Terse; no file dumps.

1. `F approve <args>` (same args). Show any WARNING lines. It opens the live dashboard; give the user its `dashboard:` URL.
2. Step 5/9 - Execute (print the banner). Rolling pipeline: never wait for a whole wave.
   a. Before each wave, run `F inbox`. For each message the user sent from the dashboard: a message that names a ticket is already in that ticket's brief; any other message is an instruction. Follow it if it only changes how the work is done. Ask first if it changes scope. Reply with one line per message you act on.
   b. `F ready [--phase N]` -> JSON. Start every id in `batch` now: `F ticket <id> running`, then `F brief <id>`, and use its output VERBATIM as the subagent prompt. Launch them all in ONE message as Agent calls: subagent_type `forge-dev` (`forge:forge-dev` if namespaced), `model` from `models` (opus only if complex), `run_in_background: true`. Agents share this working tree; `ready` never gives two running agents the same file, so no worktrees and no merge step.
   b. When a background agent reports (DONE | GAP | BLOCKED): `F result <id> --status done --summary "<short>" --closing "<line>"` (add a second `--closing` if useful). GAP/BLOCKED: `F result <id> --status blocked --gap "<why>"` and tell the user now.
   c. Right away, run `F ready` again and start its `batch` the same way. Do not wait for the other agents: a finished ticket can unblock its dependents at once.
   d. Stop when `F ready` returns an empty `batch` and no ticket is `running`. Tickets in `deferred` wait for files a running agent holds; a later `ready` picks them up.
   e. If the user approved only a phase or IDs, stop when they are done.
   f. If test mode is `per_phase`, run the testing stage (step 4) when a phase completes.
3. Step 6/9 - Token accounting runs in hooks. Run `F status --brief`. Tickets without exact usage show "estimated"; never invent actuals.
4. Step 7/9 - Testing, when all approved tickets are done (default mode `end`): `F step 7`, `F tests running`, launch `forge-tester` (pass the changed files from `F export`, and "fix loop N" if repeating). On FAIL: `F plan .claude/forge/work/fixes.json --append`, `F approve <fix ids>`, go back to step 2 (max 2 fix loops, then ask the user).
5. On pass: show `F status --brief` and say: run `/forge-handoff` for the handoff and doc updates.
