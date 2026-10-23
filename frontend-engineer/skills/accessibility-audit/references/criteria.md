# Accessibility audit: criteria, severity and report

Target: WCAG 2.2 level AA, unless the project config names another level. Read by the orchestrator at
Stage 0, and by the two reviewers as the table of static checks.

## Coverage

Automated tools catch some failures, and code review catches others. A clean result does not mean the page
conforms. The report always lists what was automated, what was read in code, and what needs a person.

| Source | What it covers |
| --- | --- |
| axe-core (runtime) | many name, label, role, contrast and structure failures on the rendered page |
| Focus check (runtime) | focus visibility and order, read from the first Tab stops |
| Reflow (runtime) | horizontal overflow at 320 CSS px |
| Code review (static) | semantics, keyboard handlers, focus handling, ARIA use, motion, token contrast |
| Manual | meaning of alternative text, reading sense, error wording, screen reader behaviour, zoom to 200% |

## Static checks

| Check | WCAG | Look for in code |
| --- | --- | --- |
| Text alternatives | 1.1.1 | `<img>` without `alt`; decorative images with non-empty `alt`; `<svg>` with no name or `aria-hidden` when meaningful; icon-only buttons with no name |
| Semantics | 1.3.1 | clickable `div` or `span`; headings chosen for size; lists faked with `div`; tables with no `th` or `scope`; layout tables |
| Autocomplete | 1.3.5 | personal-data fields with no `autocomplete` token |
| Colour alone | 1.4.1 | errors, required fields or states shown only by colour |
| Text contrast | 1.4.3 | token pairs used for body text, below 4.5:1 (3:1 for text at 24px, or 18.66px bold and above) |
| Non-text contrast | 1.4.11 | input borders, icons, focus rings and state indicators below 3:1 |
| Reflow | 1.4.10 | fixed widths on containers, `overflow: hidden` that clips content at narrow widths |
| Text spacing | 1.4.12 | fixed heights on text containers; `!important` on line height or letter spacing |
| Hover and focus content | 1.4.13 | tooltips or popovers that cannot be dismissed or stay on hover |
| Keyboard | 2.1.1 | handlers for mouse only (`onClick` without key handling); custom widgets with no key support |
| Focus trap | 2.1.2 | modal or menu that traps focus and has no Escape or close route |
| Skip link | 2.4.1 | repeated header with no skip link to main content |
| Page title | 2.4.2 | route with no title, or the same title on every route |
| Focus order | 2.4.3 | `tabIndex` greater than 0; DOM order that differs from visual order |
| Labels and headings | 2.4.6 | empty or generic headings and labels ("Click here") |
| Focus visible | 2.4.7 | `outline: none` or `outline: 0` with no replacement on `:focus` or `:focus-visible` |
| Focus not obscured | 2.4.11 | sticky headers or footers that can cover a focused control |
| Label in name | 2.5.3 | accessible name that does not contain the visible label text |
| Pointer gestures | 2.5.1 | drag-only or path-based controls with no single-pointer alternative |
| Target size | 2.5.8 | controls under 24 by 24 CSS px with no spacing exception |
| Language | 3.1.1 | `<html>` with no `lang` |
| On input | 3.2.2 | a field change that submits or navigates without a warning |
| Error identification | 3.3.1 | errors shown with no text, or not tied to the field |
| Labels and instructions | 3.3.2 | fields with no visible label or instructions for required formats |
| Name, role, value | 4.1.2 | invalid `role`; ARIA attributes missing their required parent or state; `aria-hidden` on focusable content |
| Status messages | 4.1.3 | loading, success and error messages with no live region |
| Reduced motion (best practice) | 2.3.3 | animation with no `prefers-reduced-motion` alternative |

## Manual checks

These are listed in every report unless a person has recorded the result.

- Alternative text says what the image is for, not only what it shows.
- Link and button text makes sense out of context.
- Reading order makes sense when the CSS is off.
- Error messages say what to do next.
- A screen reader announces the important state changes, in a real reader on each platform the product targets.
- The page works at 200% zoom with no loss of content or function.
- Media has captions and, where needed, audio description.

## Severity

| Severity | Use when |
| --- | --- |
| critical | a core task cannot be completed by keyboard or screen reader, for example a form cannot be submitted, or a dialog traps focus |
| high | an A or AA failure on a common path, for example an unlabelled input in a main form, or focus that cannot be seen on a primary control |
| medium | an AA failure with a workaround or on a secondary path, for example grey secondary text below 4.5:1, a target below 24 px, or overflow at 320 px on a secondary page |
| low | best practice, AAA, or a cosmetic difference that does not block anyone |

Map an axe `impact` value only as a starting point. Set the final severity by the user effect.

## Finding format

```
- [severity] WCAG <criterion> — <issue> (path:line or viewport and target)
  Effect: <who is affected and how>
  Evidence: <rule id, measured value, focus stop index, or code location>
  Fix: <direction, not a patch>
```

## Report template

Write this to `.claude/frontend-engineer/accessibility/report.md`:

```
# Accessibility audit report

Date: <today>. Scope: <routes and components>. Target: WCAG 2.2 AA. Branch: <name> at <short sha>.

Status: findings | clear | not performed (reason)
Counts: critical <n>, high <n>, medium <n>, low <n>

## Coverage

| Source | Ran | Result |
| --- | --- | --- |
| axe-core, 2.0 A/AA, 2.1 A/AA, 2.2 AA | yes / not performed (reason) | <violations per viewport> |
| Focus order and visibility | yes / not performed | <stops checked> |
| Reflow at 320px | yes / not performed | <overflow px> |
| Code review | yes / not performed | <files> |
| Contrast of tokens | yes / not performed | <pairs checked> |

## Findings

| ID | Severity | WCAG | Issue | Location | Fix direction |
| --- | --- | --- | --- | --- | --- |
| A11Y-001 | critical | 4.1.2 | … | path:line | … |

(Detail for each critical and high finding, in the finding format above.)

## Needs review

- <axe incomplete rules, each with the element>

## Manual checks outstanding

- <each manual check from the criteria reference that was not recorded>

## Checked and fine

- <area>: <what was checked>

## Not reviewed

- <area>: <reason>
```

Status rules:

- `findings` when any finding survives verification.
- `not performed` when the runtime scan could not run and no static finding exists to report. Give the reason.
- `clear` only when every source ran, no finding survives, and the manual checks are listed as outstanding. Never write
  "accessible" or "WCAG compliant".
