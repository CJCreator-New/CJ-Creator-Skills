---
name: accessibility-audit
description: Read-only accessibility audit of frontend pages and components against WCAG 2.2 AA. Reviews the code for semantics, names, labels, keyboard handling, focus, ARIA and token contrast, and runs the rendered page for axe-core violations, focus order and visibility, and 320px reflow where Playwright and axe-core are installed. Reports findings with the WCAG criterion and a fix direction. Never edits source. Use after a UI change, before a release, or to audit an existing page.
argument-hint: '<route, component path or folder, or "all routes" (default: the design route in config)>'
disable-model-invocation: true
---

# Accessibility audit

Scope: $ARGUMENTS

You are the audit owner. Subagents cannot spawn subagents, so you dispatch the two reviewers with the Agent tool.
The audit is read-only. It edits no source, changes no configuration, installs nothing, and writes only under
`.claude/frontend-engineer/accessibility/`. The criteria, severity rubric and report template are in
`references/criteria.md`. Read it once at Stage 0.

Two helper scripts ship with this plugin:
- `CONTRAST` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/contrast.mjs"`. It takes a foreground and a background colour, and prints the ratio and whether it passes.
- `AXE` means `node "${CLAUDE_PLUGIN_ROOT}/scripts/axe-scan.mjs"`. It runs axe-core and the focus and reflow checks against a URL, and prints a JSON summary.

## Stage 0: Preflight

1. Run `git status --short` and `git branch --show-current`. Record them. Do not change the working tree.
2. Read project instructions once: root `CLAUDE.md`, `AGENTS.md` if present, and any nested `CLAUDE.md` for the
   scope. Read `.claude/frontend-engineer/config.json` if it exists. Use its `devServer.url`, its `viewports`, and
   its `design.route`. If it does not exist, use the viewports 1440x900 and 390x844.
3. Probe each capability and record it as available or unavailable. Install nothing:
   - Playwright: `node -e "require.resolve('playwright')"` from the project root.
   - axe-core: `node -e "require.resolve('axe-core')"` from the project root.
   - The app: `curl -s -o /dev/null -w "%{http_code}" <devServer.url>`. A dev server that is down is not started
     unless the config names a `devServer.command`. If it does, start it in the background, wait for the URL, and
     stop it at the end of the run.
4. Create `.claude/frontend-engineer/accessibility/`.

If Playwright, axe-core or the app is unavailable, the runtime check is `not performed`, with the reason. Do not
describe the rendered page from the code. Name the install command in the report: `npm i -D playwright axe-core`.

## Stage 1: Scope

1. Resolve the targets from the argument: a route, a component path or folder, or "all routes". For "all routes",
   find the router definitions with Grep and list the routes. Ask only if the list is too large to audit in one
   run, and then audit the first five routes that the user names.
2. Write `.claude/frontend-engineer/accessibility/scope.md`: the routes, the files in scope, the viewports, and the
   capability results from Stage 0.
3. Routes behind a login are not reached by the scan, which cannot sign in. Put them under "Not reviewed" unless
   they are reachable without credentials. Never read credentials from `.env` or key files to get past a login.

## Stage 2: Review

Dispatch both reviewers in one message, each with its own context pack:

- `a11y-static-reviewer`: the files in scope, the path to `references/criteria.md`, and the contrast command as
  `CONTRAST`. Give it the token files the code uses.
- `a11y-runtime-auditor`: only when the runtime check is available. Give it each URL, the viewports, `--tab 20`, and
  the exact scan command:
  `AXE --url <url> --viewport desktop=1440x900 --viewport mobile=390x844 --tab 20 --out .claude/frontend-engineer/accessibility/evidence`

Skip the runtime reviewer only with the reason from Stage 0. Each reviewer replies in its own shape.

## Stage 3: Verify

Reviewers propose. You decide.

1. Merge the replies and remove duplicates. The same element reported by axe and by code review is one finding.
2. For each runtime violation, find the element in the code using its target selector, and confirm the failure.
   axe reports some false positives, such as contrast over images or hidden elements. Drop those with a reason.
3. For each critical and high finding, read the code and confirm the effect on a user. Do not rely on the severity
   that axe gives. Set the severity by the rubric in `references/criteria.md`.
4. For each "incomplete" axe rule, list it under "Needs review". Do not count it as a finding.
5. List the manual checks from `references/criteria.md` that the run did not record.

## Stage 4: Report

1. Write `.claude/frontend-engineer/accessibility/report.md` from the template in `references/criteria.md`.
2. Stop the dev server if this run started it.
3. Reply in chat with: `Status`, counts by severity, the critical and high items with their location, the coverage
   table, the manual checks outstanding, and the path to the report.
4. End with the handoff: "To fix these, run `/frontend-engineer:frontend-build` with this report. This audit does not edit source."

## Hard rules

- Never edit source, configuration, lockfiles or git state. Never commit, push, or install packages.
- The runtime scan presses Tab only. Do not click, press Enter, type into a field, or submit a form. Use test data
  only, and never use a control that deletes or sends something.
- Never claim a page is accessible or WCAG-compliant. Say which sources ran, what they found, and which manual
  checks remain.
- Report a finding only with evidence: a rule id and a target, a measured ratio, a focus stop, or a code location.
- Never print secret values, tokens or the contents of `.env` or key files.
