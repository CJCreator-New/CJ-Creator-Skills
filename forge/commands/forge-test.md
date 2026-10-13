---
description: Run the Forge testing stage (relevant tests first, then the full suite once)
allowed-tools: Bash, Read, Agent
---
`F` = `python .claude/forge/forge.py`. Step 7/9 - Testing (print the banner): `F step 7`, `F tests running`, then launch `forge-tester` with the changed files from `F export` (tickets' `touched`). Report pass/fail in 3 lines. On FAIL: `F plan .claude/forge/work/fixes.json --append`, show the fix tickets with `F status`, and ask the user to `/forge-approve` them.
