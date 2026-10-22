# forge

A Claude Code plugin for a token-efficient feature workflow. It works in any project and any stack, and
needs Python 3.8+ (stdlib only) and git.

**Flow:** project map, then enhance the request into an exact spec and context pack, then phases and
tickets with token estimates, then **your approval**, then parallel subagents build, then one test run at
the end, then a dev handoff. A live dashboard shows progress throughout.

The full guide (install options, the dashboard and terminal views, design notes and known limits) is in the
root [README](../README.md). This file describes the plugin's own parts.

## Install

```
/plugin marketplace add CJCreator-New/CJ-Creator-Skills
/plugin install forge@forge-marketplace
```

Then, in any project: `/forge-init` once (optional, `/forge` does it), then `/forge <feature request>`.

## Commands

| Command | What it does |
| --- | --- |
| `/forge <request>` | Map, enhance, plan, then stop at the approval gate |
| `/forge-approve all \| phase N \| IDs [--test-mode per_phase]` | Run approved tickets in parallel, account tokens, test |
| `/forge-status` | One-time snapshot of the dashboard in the terminal |
| `/forge-watch` | How to open the live terminal view and the optional status bar |
| `/forge-dashboard` | Open the live dashboard in the browser |
| `/forge-test` | Re-run the testing stage |
| `/forge-handoff` | Handoff document and project doc updates, after showing the file list |
| `/forge-level lite\|full\|ultra` | Set the ponytail level (default full) |
| `/forge-init` | Create `.claude/forge/` in the project |

## Components

```
forge/
├── .claude-plugin/plugin.json
├── commands/                 slash commands listed above
├── agents/                   forge-mapper, forge-enhancer, forge-planner, forge-dev, forge-tester, forge-docs
├── hooks/hooks.json          SessionStart, SubagentStart, SubagentStop, Stop and tool hooks
├── scripts/                  forge_cli.py, forge_lib.py, hook.py, dash_server.py, render_dashboard.py, tui.py
├── ponytail/SKILL.md         the smallest-change discipline, injected into Forge's agents only
└── templates/                claude-md-section.md, the section added to CLAUDE.md after a confirmed diff
```

Per project, Forge creates `.claude/forge/` (git-ignored) with `state.json`, the project map, the dashboard
and its launcher, the work folder, and archived runs. Handoffs go to `docs/handoffs/`.

## Notes

- Hooks are inert unless a Forge run is active in the project, and they fail open.
- The ponytail skill is deliberately kept outside `skills/`, so it does not trigger in ordinary chat.
- Token figures are estimates until a subagent transcript provides actual usage. The root README explains which
  numbers are computed and which are measured.
