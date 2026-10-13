---
description: Set up Forge in this project (creates .claude/forge/, git-ignored)
allowed-tools: Bash
---
Run `python3 "${CLAUDE_PLUGIN_ROOT:-$FORGE_ROOT}/scripts/forge_cli.py" init`, then `python3 .claude/forge/forge.py claude-md check`.
Reply in 3 lines: what was created, that live views are `.claude/forge/dashboard.html` (browser) and `python3 .claude/forge/forge.py watch` (second terminal; `/forge-watch` for details), and that `/forge <request>` starts a run and offers to add the Forge section to CLAUDE.md (only if missing).
