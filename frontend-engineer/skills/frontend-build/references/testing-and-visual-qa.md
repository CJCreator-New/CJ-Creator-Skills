# Testing and visual QA

## Test layers

Use the layers the project already has. Add a layer only when the project has no equivalent for a requirement that needs one.

| Layer           | Verifies                                                                 | Typical tool                       |
| --------------- | ------------------------------------------------------------------------ | ---------------------------------- |
| Static          | format, lint, types, build                                               | project scripts                    |
| Component       | rendering, required text and elements, props, conditional states, user interactions, validation messages, loading and error states, keyboard use | React Testing Library, Vue Test Utils, or the project's equivalent |
| Integration     | components with application state, forms with API clients, routes with page components, shared components with consumers | project test runner with mocked network |
| End-to-end      | user journeys: navigation, submission, filtering, sorting, dialogs, persistence | Playwright or Cypress, if configured |
| Visual          | rendered page against the reference at matching viewports                | visual-qa with the browser         |
| Regression      | existing tests in the changed area, then the full suite                  | project scripts                    |

## Test rules

- Test behavior that a user or caller can observe. Do not test private state or implementation details.
- Each test traces to one or more matrix rows. Name the row in the test title or a comment.
- Do not write a test that passes regardless of the implementation. Check that it fails when the behavior is removed.
- Reuse existing fixtures, mocks and helpers. Do not add a test dependency without a stated reason.
- Cover validation, error and loading states for every form and async action the matrix lists.
- Include keyboard operation for every interactive control the matrix lists.

## Running tests

- During development: run only the focused files for the changed components.
- At Stage 9: run the full configured suite once, and the build.
- Record the exact command and the actual result. A command that could not run is recorded as `not run` with the reason.
- A failing test is pre-existing only if it also fails at the base commit. Verify that in a temporary worktree.

## Visual QA

visual-qa compares the running page with the reference. It does not rely on pixel-difference scores alone. Dynamic content, anti-aliasing and font rendering make a raw diff noisy, so each difference is judged in context.

Checklist:
- Every element in the design spec is present.
- Layout geometry: regions, order, alignment, widths. Measure with DOM boxes where the reference gives dimensions.
- Spacing between elements matches the design within a few pixels, or the difference is explained.
- Typography: size, weight, line height, and text wrapping.
- Colors, borders, radii and shadows.
- Image and icon fidelity: the correct asset, not a placeholder.
- Responsive behavior at each configured viewport.
- Overflow, clipping and horizontal scrolling.
- Interactive visual states: hover, focus, disabled, error.

Evidence: each significant defect gets a screenshot path (or a clipped crop) and the measured values that show it.

Browser checks:
- Open the configured route at each configured viewport.
- Wait for network idle and fonts before capturing.
- Check the browser console for errors and report them.
- Run an accessibility inspection where the tooling exists: accessible names, focus order, and contrast of text against its background.

If no browser can run, visual-qa reports `visual verification: not performed` with the reason. It does not describe the page from the code alone.

## Defect severity

- **critical**: required functionality is missing or broken; a page does not render; data is lost or exposed.
- **high**: a major structural or layout defect; the wrong component or asset is used; a control does nothing.
- **medium**: responsive or accessibility failures, such as overflow, unreachable controls or missing accessible names; a wrong state is shown.
- **low**: typography, spacing or color differences within tolerance; minor decorative differences.

Fix in that order. Group defects by root cause, so that one fix covers several symptoms.

## Correction loop

```
REFERENCE ANALYSIS -> IMPLEMENTATION -> AUTOMATED TESTS -> BROWSER RENDERING
  -> VISUAL COMPARISON -> DEFECT TRIAGE -> CORRECTION -> REGRESSION TESTS -> RE-VERIFICATION
```

- Stop when the acceptance criteria are met. Do not keep polishing low-severity differences past the criteria.
- Stop at `maxVisualIterations` (default 3). Report what remains and ask for a decision.
- Each iteration records a `defect` entry per defect found and per defect fixed, through `scripts/telemetry.mjs`.
