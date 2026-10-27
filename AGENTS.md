# Contributing to Forge (agent instructions)

This repo is a plugin marketplace for Forge, a plan-approve-build workflow. Any AI coding tool can work on it. The shared parts are the portable skill and the stdlib CLI. Claude Code is one of several install targets.

## Layout

- `forge/skills/forge/SKILL.md`: the portable runbook. Keep it tool-neutral: no `${CLAUDE_*}` variables and no tool-specific tool names outside a labelled "Claude Code:" note.
- `forge/scripts/`: stdlib-only Python 3.8+ (`forge_cli.py` holds all state changes; `hook.py` is Claude Code only).
- `forge/commands/`, `forge/agents/`, `forge/hooks/`: Claude Code only.
- `forge/gemini-extension.json`, `forge/plugin.json`, `forge/.codex-plugin/`, `forge/.cursor-plugin/`, `.claude-plugin/`: one manifest per tool. Keep `name` and `version` identical across them.
- `forge/templates/claude-md-section.md`: the instructions section written into `CLAUDE.md` or `AGENTS.md`.

## Rules

- Anything the CLI does must work with no hook data and no Claude environment variables.
- When you change a CLI subcommand or flag, update `forge/skills/forge/SKILL.md` and the Claude prompts in `forge/commands/` and `forge/agents/`.
- Bump the version in every manifest and in `forge/scripts/forge_lib.py` (`VERSION`) together.

## Tests

```
python tests/dry_run.py
python tests/portability_test.py
python tests/tui_test.py
```

`portability_test.py` checks manifest agreement, the skill's frontmatter, that every `F <command>` in the docs exists in the CLI, and that init works without Claude variables.
