# Forge

A token-efficient feature workflow for AI coding tools, packaged as a plugin. It runs in Claude Code, Gemini CLI, Codex CLI, Cursor, GitHub Copilot CLI and OpenCode, and in any agent or terminal that can run a shell command. It works in any project and any stack. Python 3.8+ (stdlib only) is the only requirement; git is optional.

**Flow:** project map -> enhance the request into an exact spec + context pack -> phases and tickets with token estimates -> **you approve** -> build (parallel subagents where the tool has them, one ticket at a time where it does not) -> test once at the end -> dev handoff. A live dashboard shows progress throughout. Code written under Forge follows the *ponytail* discipline (smallest complete change).

## Where it runs

The workflow lives in one place: the **`forge` skill** (`forge/skills/forge/SKILL.md`), plus the stdlib CLI (`forge/scripts/forge_cli.py`) that holds all state. Each tool gets the skill through its own install path, and Claude Code also gets slash commands and hooks.

| Tool | Install | Workflow | Parallel workers | Exact token counts | Live views |
|---|---|---|---|---|---|
| **Claude Code** | `/plugin marketplace add CJCreator-New/CJ-Creator-Skills` then `/plugin install forge@forge-marketplace` (or a local path) | Slash commands + skill | Yes (Agent tool) | Yes (hooks) | Dashboard, `watch`, status bar |
| **Gemini CLI** | `gemini extensions install <path-to>/forge` (extension manifest: `forge/gemini-extension.json`) | Skill + `AGENTS.md` context | No, one ticket at a time | No (`estimated`) | Dashboard, `watch` |
| **Codex CLI** | Copy `forge/skills/forge` to `.agents/skills/forge` (project) or `~/.codex/skills/forge` (global) | Skill + `AGENTS.md` | No, one ticket at a time | No (`estimated`) | Dashboard, `watch` |
| **OpenCode** | Copy `forge/skills/forge` to `.opencode/skills/forge` (OpenCode also reads `.claude/skills` and `.agents/skills`) | Skill + `AGENTS.md` | No, one ticket at a time | No (`estimated`) | Dashboard, `watch` |
| **GitHub Copilot CLI** | `copilot plugin marketplace add <path-to-this-repo>`, then `copilot plugin install forge@forge-marketplace` (uses `forge/plugin.json`) | Skill | Only if the tool offers background agents | No (`estimated`) | Dashboard, `watch` |
| **Cursor** | Plugin folder `forge/` (manifest `forge/.cursor-plugin/plugin.json`); or copy `forge/skills/forge` into the skills folder Cursor reads | Skill + `AGENTS.md` | Only if the tool offers background agents | No (`estimated`) | Dashboard, `watch` |
| **Any other agent or a plain terminal** | Copy `forge/skills/forge` into the tool's skills folder, or paste the Forge section from `forge/templates/claude-md-section.md` into its instructions file | Skill, or run the CLI by hand | No | No | Dashboard, `watch` |

Notes:
- **Only the CLI and the tests were run here.** The install steps for Gemini CLI, Codex CLI, OpenCode, Copilot CLI and Cursor come from their public docs and community guides and were not run inside those tools. Confirm each one against your tool's docs before relying on it. The skill is plain `SKILL.md`, so copying its folder works in any tool that reads that format.
- **Live views in every tool:** `F dashboard` serves a browser UI, `F watch` gives a terminal view, and `.claude/forge/dashboard.html` is a static snapshot. The Claude Code status bar is Claude-only.
- **Exact token counts** come from Claude Code's hook payloads and transcripts. Other tools show tickets as `estimated`, and nothing is counted as used that was not measured.
- **Read guards** (blocking do-not-read paths) are enforced by hooks, so they are Claude-only. Elsewhere the brief's "read only these" rule still applies.

Setup in any project, for any tool:
```
python <path-to>/forge/scripts/forge_cli.py init      # on Windows: py -3 ...
```
This creates `.claude/forge/` (git-ignored) and the `F` launcher (`python .claude/forge/forge.py`). Then ask your tool to run the Forge skill with `<feature request>`, or run `F new-run` and the steps by hand. In Claude Code, `/forge-init` does the same and `/forge <feature request>` starts a run.

Add the instructions section to the file your tool reads: `CLAUDE.md` for Claude Code, `AGENTS.md` for the others.
```
python .claude/forge/forge.py claude-md apply --file AGENTS.md
```

## Install (Claude Code)

From GitHub (works for anyone, on Windows, macOS or Linux):
```
/plugin marketplace add CJCreator-New/CJ-Creator-Skills
/plugin install forge@forge-marketplace
```
From a local clone of this repo, use `/plugin marketplace add <path-to-this-folder>` instead.

Forge needs Python 3.8+. The hooks try `python3`, then `python`, then `py`, so whichever one your system has is used. If none is found the hooks do nothing and Forge still works.

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

The slash commands are Claude Code only. Every other tool runs the same steps from the `forge` skill, and the CLI commands are listed in `skills/forge/SKILL.md`.

## Seeing progress (three views, one state file)

- **Live dashboard (browser):** `/forge-approve` opens it on your machine at `http://127.0.0.1:<port>/`, and the approval gate opens it so you can review the plan first. It shows the 9-step track, a relay race with each ticket as a leg and its time, token totals, phases and tickets. Each ticket has **+ Add detail** (the building agent sees it in its brief), and the bottom bar sends a **message to Forge**, which the orchestrator reads before the next build wave. Run `/forge-dashboard` to open it at any time and `python .claude/forge/forge.py dashboard stop` to stop the server. Without the server, `.claude/forge/dashboard.html` is a read-only snapshot.
- **Live terminal view:** in a second terminal run `python .claude/forge/forge.py watch`. Full-screen, colored, redraws as state changes: animated spinners for running tickets, XP/progress bars, token bars, parallel lanes, a toast when a ticket or phase clears. Keys: `q` quit, `j/k` scroll, `c` compact, `r` reload. Flags: `--ascii` (plain terminals), `--no-color` (also honours `NO_COLOR`). Two columns at 112+ columns, stacked below that.
- **Relay race panel:** each ticket is one leg of the race. The runner (`o/` `\o`) carries the baton along the track, and each finished leg passes it on with its time (`0:03`, `1:07`). A running leg shows a live timer, a leg that takes more than twice the average gets a "Slow down, Usain" quip, and the footer shows total race time and the average leg. Legs timed before this version show `--:--`.
- **Claude Code status bar (optional, Claude-only):** `/forge-watch` prints a `statusLine` snippet for your settings; it shows `Forge 5/9 Execute | progress | 2 running | tokens | saved` and nothing when no run is active.
- `/forge-status` (Claude Code) and `python .claude/forge/forge.py status` (any tool) print the same layout once (no color).

## What lives where

- Plugin, shared by every tool: `skills/forge/SKILL.md` (the runbook), `scripts/` (CLI, dashboard, TUI), `ponytail/SKILL.md`, `templates/`, `AGENTS.md` (short context for tools that read it).
- Plugin, per tool: `.claude-plugin/` + `commands/`, `agents/` and `hooks/hooks.json` (Claude Code); `gemini-extension.json` (Gemini CLI); `plugin.json` (Copilot CLI); `.codex-plugin/plugin.json` (Codex CLI); `.cursor-plugin/plugin.json` (Cursor). Repo root: `.claude-plugin/marketplace.json` and `AGENTS.md` for contributors.
- Per project (created on first run, git-ignored): `.claude/forge/` with `state.json` (single source of truth), `PROJECT_MAP.md`, `dashboard.html`, `forge.py` launcher, `work/`, `runs/` (archived runs).
- Handoffs: `docs/handoffs/<feature>-<date>.md`. `CLAUDE.md` gets a "Forge" section only after you confirm the diff.

## Design notes

- **Ponytail is scoped to Forge.** The skill text is shipped verbatim at `ponytail/SKILL.md`, deliberately *outside* `skills/` so it does not auto-trigger in normal chat. A SubagentStart hook injects it (level-aware) into the enhancer, planner, dev and docs agents only. To also use it as a global skill, copy that folder into `skills/`.
- **Estimates are computed, not guessed.** The planner supplies exact files/line ranges and a diff size; the CLI turns that into tokens (chars/4 for files, 12 tokens per ranged line, 14 per diff line, 2,500 agent overhead; range 0.7x-1.5x). Baseline = estimate + heuristic exploration cost (12% of repo tokens, clamped 10k-150k). "Saved" is therefore an estimate, and labelled so.
- **Actuals come from transcripts.** SubagentStop reads the subagent transcript's usage fields (duplicate message ids counted once). "Used" = input + cache-write + output; cache reads are shown separately. If a transcript is unavailable the ticket shows "estimated" and nothing is counted as used.
- **Hooks fail open and are inert** unless a Forge run is active in the project. Guards apply only to `forge-dev` agents: do-not-read paths are denied, reads outside the ticket's context pack get a warning.
- **Models (Claude Code):** mapper, enhancer, planner, dev, tester on Sonnet; docs on Haiku; tickets the planner marks `complex` run on Opus. Edit the `model:` line in `agents/*.md` to change. Other tools ignore the `models` field from `F ready` and use their own default model.

## Known limits

- Built and tested without a live Claude Code session: the scripts, hooks and dashboard are tested (`python tests/dry_run.py`), but the command/agent prompts and the exact hook payload fields (`agent_id`, `agent_type`, `agent_transcript_path`) depend on your Claude Code version. Hooks degrade gracefully (no attribution rather than wrong attribution).
- Parallel agents share one working tree. `F ready` never gives two running tickets the same file, so there are no worktrees and no merge step. Dependents start as soon as their inputs finish (rolling, not wave by wave).
- `F status --brief` prints a short plain summary for the chat; the full layout stays in `watch` and the dashboard.
- Main-session usage (`Stop` hook) is the whole session total, not only Forge.
- Outside Claude Code, tickets run one at a time unless the tool offers background agents, and token figures stay `estimated`. The workflow itself, the CLI, the dashboard and the terminal view do not change.
- Cross-tool manifests (Gemini, Copilot, Codex, Cursor) are minimal and not validated against those tools' schemas here. Install one in its tool and check it loads before you publish.
- Tests: `python tests/dry_run.py`, `python tests/portability_test.py` and `python tests/tui_test.py`. They were run here on Windows with Python 3.13 only; Python 3.8 compatibility is the target but untested. The live terminal-view test needs a POSIX pty, so it is skipped on Windows; there, run `F watch` by hand.
- Windows: the commands use `python`. If that name is missing (the Microsoft Store stub, or a Python installed only as `py`), use `py -3` in its place.
