# Classification and routing

## Task types

Classify the request as one or more of:

- New page or application screen.
- Existing page modification.
- Component implementation (including modal, form, dashboard card, section).
- Screenshot-to-code or Figma-to-code.
- Design system integration.
- Responsive redesign.
- Functional enhancement.
- Bug fix.
- Frontend refactoring.
- Visual defect correction.
- Performance or accessibility improvement.

For each, determine: affected routes, design references and assets, framework and component architecture, expected interactions and data behavior, backend dependencies, required browser and viewport coverage, applicable tests, and risk.

## Risk

Raise the mode by one level when any of these apply:

- Authentication, authorization, session handling or permissions.
- Money, personal data or any write to a backend resource.
- A component shared by several routes.
- Routing, global styles, or a shared type or API client.
- Unsafe HTML rendering or user-supplied URLs.

## Agent selection

| Agent            | Model  | Tools                                       | Writes files | Used in                |
| ---------------- | ------ | ------------------------------------------- | ------------ | ---------------------- |
| design-analyst   | sonnet | Read, Glob, Grep                            | no           | standard, full         |
| repo-intel       | haiku  | Read, Glob, Grep, Bash (read-only git)      | no           | all except quick       |
| implementer      | sonnet | Read, Glob, Grep, Edit, Write, Bash         | owned files  | standard, full, fixes  |
| test-author      | sonnet | Read, Glob, Grep, Edit, Write, Bash         | test files   | standard, full         |
| visual-qa        | sonnet | Read, Glob, Grep, Bash                      | no           | when a browser is available |
| code-reviewer    | opus   | Read, Glob, Grep, Bash                      | no           | full, and standard when risk is raised |

Dispatch only what the mode needs. Each agent is narrow. Agents that only read do not get write tools.

## Model routing

Use the cheapest model that can do the job reliably:

- **haiku**: repository search, file classification, component mapping, mechanical test enumeration, formatting checks, and summaries of deterministic output.
- **sonnet**: design interpretation from images, implementation, test writing, visual comparison.
- **opus**: architecture decisions, complex state or effect design, difficult debugging, security-sensitive logic, integration conflicts, and the independent review of full-mode or high-risk changes.

Escalate one level when an agent returns `blocked` twice on the same task, or when a check fails for a reason the agent cannot explain. Do not escalate on a first attempt.

Use deterministic tools for lint, types, format, build, tests, file search and screenshots. Never replace a tool result with model confidence.

## Efficiency rules

- Do not run two agents for the same search or the same design analysis unless one of them is an independent verification.
- Reuse outputs in the checkpoint. Re-read a file only when it changed.
- Do not rescan the whole repository after each change. Refresh only the index entries for changed paths.
- Do not run the full test suite after every edit. Run focused tests during development and the full suite once, at Stage 9.
- Stop an analysis as soon as a deterministic check has answered the question.
