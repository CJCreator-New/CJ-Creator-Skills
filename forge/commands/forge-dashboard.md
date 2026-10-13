---
description: Open the live Forge dashboard in the browser (add details per ticket, send messages to Forge)
allowed-tools: Bash
---
Run `python .claude/forge/forge.py dashboard` and give the user the printed URL. Then say, in two lines: add details to any ticket with "+ Add detail"; send a message with the bar at the bottom, and Forge reads it before the next build wave. If the command fails, show its message and the static snapshot path `.claude/forge/dashboard.html`.
