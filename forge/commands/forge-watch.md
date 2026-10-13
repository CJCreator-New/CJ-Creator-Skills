---
description: How to open the live Forge terminal view (and optional status bar)
allowed-tools: Bash
---
Run `python .claude/forge/forge.py watch-hint` and show its output verbatim. Do NOT run `watch` yourself: it is interactive and never exits. Tell the user it updates live (spinners, toasts when tickets clear), `q` quits, and `/forge-status` gives a one-time snapshot inside this session.
