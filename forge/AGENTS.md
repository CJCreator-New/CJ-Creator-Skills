# Forge (agent instructions)

Forge is a token-efficient feature workflow: project map, enhance, plan with token estimates, approval gate, build, test, handoff.

- The full runbook is the `forge` skill: `skills/forge/SKILL.md`. Load it only when the user explicitly asks to forge a feature, or to approve, test, hand off or check a Forge run.
- Ignore Forge for ordinary coding requests.
- Everything state-changing goes through the CLI: `python <plugin>/scripts/forge_cli.py` (after `init`, `python .claude/forge/forge.py`). Never edit `.claude/forge/state.json` by hand.
- Ponytail rules (smallest complete change): `ponytail/SKILL.md`.
