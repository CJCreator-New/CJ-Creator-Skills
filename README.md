# Forge

A token-efficient feature workflow for Claude Code, packaged as a plugin. Works in any project and any stack. Python 3.8+ (stdlib only) and git are the only requirements.

**Flow:** project map -> enhance the request into an exact spec + context pack -> phases and tickets with token estimates -> **you approve** -> parallel subagents build -> test once at the end -> dev handoff. A live dashboard shows progress throughout. Code written under Forge follows the *ponytail* discipline (smallest complete change).

## Install

```
/plugin marketplace add <path-or-git-url-of-this-folder>
/plugin install forge@forge-marketplace
```
Then, in any project: `/forge-init` once (optional, `/forge` does it), then `/forge <feature request>`.
Plugin commands may show namespaced as `/forge:forge-approve` etc.

## Commands

| Command | What it does |
|---|---|
| `/forge <request>` | Steps 1-4: map, enhance, plan, then stops at the approval gate |
| `/forge-approve all \| phase N \| IDs [--test-mode per_phase]` | Steps 5-7: run approved tickets in parallel, account tokens, test |
| `/forge-status` | Styled one-time snapshot of the dashboard in the terminal |
| `/forge-watch` | How to open the live terminal view (and the optional status bar) |
| `/forge-test` | Re-run the testing stage |
| `/forge-handoff` | Step 8-9: handoff doc + project doc updates (shows the file list first) |
| `/forge-level lite\|full\|ultra` | Ponytail level (default full) |
| `/forge-init` | Create `.claude/forge/` in the project |

## Seeing progress (three views, one state file)

- **Browser:** open `.claude/forge/dashboard.html` (self-contained, no network, refreshes every 3s).
- **Live terminal view:** in a second terminal run `python3 .claude/forge/forge.py watch`. Full-screen, colored, redraws as state changes: animated spinners for running tickets, XP/progress bars, token bars, parallel lanes, a toast when a ticket or phase clears. Keys: `q` quit, `j/k` scroll, `c` compact, `r` reload. Flags: `--ascii` (plain terminals), `--no-color` (also honours `NO_COLOR`). Two columns at 112+ columns, stacked below that.
- **Claude Code status bar (optional):** `/forge-watch` prints a `statusLine` snippet for your settings; it shows `Forge 5/9 Execute | progress | 2 running | tokens | saved` and nothing when no run is active.
- `/forge-status` prints the same layout once (no color) inside the Claude Code session.

## What lives where

- Plugin: `commands/`, `agents/` (mapper, enhancer, planner, dev, tester, docs), `hooks/hooks.json`, `scripts/`, `ponytail/SKILL.md`, `templates/`.
- Per project (created on first run, git-ignored): `.claude/forge/` with `state.json` (single source of truth), `PROJECT_MAP.md`, `dashboard.html`, `forge.py` launcher, `work/`, `runs/` (archived runs).
- Handoffs: `docs/handoffs/<feature>-<date>.md`. `CLAUDE.md` gets a "Forge" section only after you confirm the diff.

## Design notes

- **Ponytail is scoped to Forge.** The skill text is shipped verbatim at `ponytail/SKILL.md`, deliberately *outside* `skills/` so it does not auto-trigger in normal chat. A SubagentStart hook injects it (level-aware) into the enhancer, planner, dev and docs agents only. To also use it as a global skill, copy that folder into `skills/`.
- **Estimates are computed, not guessed.** The planner supplies exact files/line ranges and a diff size; the CLI turns that into tokens (chars/4 for files, 12 tokens per ranged line, 14 per diff line, 2,500 agent overhead; range 0.7x-1.5x). Baseline = estimate + heuristic exploration cost (12% of repo tokens, clamped 10k-150k). "Saved" is therefore an estimate, and labelled so.
- **Actuals come from transcripts.** SubagentStop reads the subagent transcript's usage fields (duplicate message ids counted once). "Used" = input + cache-write + output; cache reads are shown separately. If a transcript is unavailable the ticket shows "estimated" and nothing is counted as used.
- **Hooks fail open and are inert** unless a Forge run is active in the project. Guards apply only to `forge-dev` agents: do-not-read paths are denied, reads outside the ticket's context pack get a warning.
- **Models:** mapper, enhancer, planner, dev, tester on Sonnet; docs on Haiku; tickets the planner marks `complex` run on Opus. Edit the `model:` line in `agents/*.md` to change.

## Known limits

- Built and tested without a live Claude Code session: the scripts, hooks and dashboard are tested (`python3 tests/dry_run.py`), but the command/agent prompts and the exact hook payload fields (`agent_id`, `agent_type`, `agent_transcript_path`) depend on your Claude Code version. Hooks degrade gracefully (no attribution rather than wrong attribution).
- Parallel worktree merging is done by the orchestrating model, not a script.
- Main-session usage (`Stop` hook) is the whole session total, not only Forge.
