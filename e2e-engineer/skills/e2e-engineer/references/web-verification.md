# Web verification (e2e-ui)

The browser legs of each journey are verified in a real Chromium, driven through the interface. A test case with the `web` or `mobile-web` layer and the `implemented` automation status lists its steps. The runner runs them in order, at the viewport the test case names.

## Steps

A step is one user action or one check. Each finds its control the way a user does: by its accessible role and name, or by its label. A test never clicks by a CSS selector or a page position.

| Act | Does | Passes when |
| --- | --- | --- |
| `signIn` | Signs in through the sign-in form as a role | The orders page opens. Uses the role's credentials from the environment |
| `goto` | Opens a page by hash or path | The navigation starts. The next step checks the result |
| `fill` | Types into the field with this label | The field accepts the value |
| `click` | Clicks the control with this role and name | The control can be clicked |
| `expectVisible` | Shows a control with this role and name | The control is visible within the timeout |
| `expectText` | Shows this text | The text is visible within the timeout |
| `expectUrl` | Reaches this part of the address | The page reaches it within the timeout |
| `expectTestId` | Shows this text in the element with this test ID | The element's text includes the text |
| `expectDownload` | Clicks a control and starts a download with this file name | A download starts, and its name matches |
| `interceptNext` | Makes the next request to this path fail | The next matching request gets this status |
| `expectNotClipped` | Shows the element in full, not cut off by a container | No container that hides overflow cuts it off |
| `expectMinTarget` | Gives a control at least this many CSS pixels in both directions | The control's size meets the minimum |
| `scanA11y` | Runs the named built-in accessibility rules | No violation is found |

The timeout for each step is five seconds. A step that does not pass within it is a failure, and the message says what did not happen.

## Viewports

A test case names its viewport: `desktop`, `phone` or `narrow`, or any name the config declares under `viewports`. A test case with no viewport runs at `desktop`. Mobile web runs in the same Chromium, with the viewport set to the phone width. This is device emulation, not a phone.

## Isolation

Each test case runs in its own browser context, so no cookie, session or storage is shared. When the config allows reset, the database is reset before each test case, so every test starts from the seed. Without reset, a mutating test case is blocked, as it is for the API suite.

## Evidence and redaction

Each test case stores a screenshot and a log under the run folder, `.claude/e2e-engineer/evidence/<run>/`. The log holds the steps, the requests and responses with their statuses, and the errors the page logged.

Every stored value is redacted before it is written:

- a header that names a credential (`Authorization`, `Cookie`, `Set-Cookie`) is replaced whole,
- a JSON key that names a credential (`password`, `token`, `secret`) is replaced whole, at any depth,
- a bearer token, a token-shaped string or a credential in a query string is replaced,
- every password value the run was given is replaced wherever it appears.

Playwright traces are not stored. A trace records the full network traffic, including credentials, and redacting it reliably is not possible. The log is a redacted record of the same traffic.

## Accessibility

The built-in rules are limited. `input-label` checks that each form field has an accessible name. `button-name` checks that each button has a name. These two rules are what the plan's oracles for labels and names need. A fuller scan, such as a complete accessibility engine, is a later addition with its own dependency.

## What a result means

- `passed`: every step held on the current build, at its viewport.
- `failed`: a step did not hold. The failure names the step and says what did not happen. A defect is opened, unless the failing requirements are derived and unconfirmed, in which case the result is `needs-confirmation`.
- `blocked`: a step could not run. A missing Playwright, a missing browser, a missing credential or an undeclared viewport blocks the test case. Blocked is never a pass.

## Limits

- Chromium only. Firefox and WebKit are not run.
- Test cases run one at a time. Parallel browser lanes need a database with per-worker tenants, which the fixture does not have.
- A visual comparison against a design is not run here. It is the design-reference work of a later phase.
