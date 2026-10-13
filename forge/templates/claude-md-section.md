<!-- forge:start -->
## Forge

Applies to Forge runs (`/forge`) only. Token-saving rules:

1. Read `.claude/forge/PROJECT_MAP.md` first; never scan the repo broadly.
2. Use grep/glob/symbol search, then read only line ranges.
3. Subagents get a context pack, not the conversation.
4. Return summaries, never paste large files or logs.
5. Do not run tests per ticket unless test mode is `per_phase`.
6. Stop and report a context gap instead of exploring.
7. Prefer editing with targeted diffs over rewriting files.
8. Ponytail: reuse before writing, no dependency for a few lines, no "for later" code, smallest complete change that fully solves the ticket.

Runtime files live in `.claude/forge/` (git-ignored). Handoffs go to `docs/handoffs/`.
<!-- forge:end -->
