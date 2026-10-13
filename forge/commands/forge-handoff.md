---
description: Generate the dev handoff and update project docs after a Forge run
allowed-tools: Bash, Read, Agent, AskUserQuestion
---
`F` = `python .claude/forge/forge.py`. Step 8/9 - Dev handoff (print the banner): `F step 8`.
1. Launch `forge-docs` in PLAN mode. Show the list of files it will create or modify. STOP for the user's OK (they may remove items).
2. Launch `forge-docs` in WRITE mode with the approved list.
3. Refresh the map: launch `forge-mapper` ("refresh the map").
4. Step 9/9 - Final dashboard: `F finish`, show its output and the handoff path. Offer one next step if there is a real one.
