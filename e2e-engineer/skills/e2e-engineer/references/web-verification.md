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
| `scanA11y` | Runs the named accessibility rules: `input-label`, `button-name`, and `axe` for the full axe-core scan | No violation is found, apart from the axe rules listed in `allow` |
| `expectKeyboardReach` | Presses Tab from the top of the page until the control with this role and name has focus | Focus reaches it within `maxTabs` presses (30 by default) |
| `expectMatchesDesign` | Compares a screenshot of the page with the reference image at `image` | At most `maxDiffRatio` of the pixels differ (0.02 by default); a diff image goes to the evidence |
| `expectResponse` | Clicks a control and waits for the request it sends to this method and path | The response has this status |
| `check` | e2e test cases only: runs an http or db check from `backend-verification.md` | The check passes |

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

`input-label` checks that each form field has an accessible name. `button-name` checks that each button has a name. `axe` runs axe-core with the WCAG 2.0, 2.1 and 2.2 A and AA tags (or `axeTags`). axe-core comes from the repository's dependencies, or from `browser.axeModule`; the skill never installs it, and without it the `axe` rule is blocked with the reason. `expectKeyboardReach` checks that a control can be reached with the keyboard alone (WCAG 2.1.1). Judgement items, such as whether the focus order makes sense, go to the human list.

## What a result means

- `passed`: every step held on the current build, at its viewport.
- `failed`: a step did not hold. The failure names the step and says what did not happen. A defect is opened, unless the failing requirements are derived and unconfirmed, in which case the result is `needs-confirmation`.
- `blocked`: a step could not run. A missing Playwright, a missing browser, a missing credential or an undeclared viewport blocks the test case. Blocked is never a pass.

## Limits

- Chromium only. Firefox and WebKit are not run.
- Test cases run one at a time. Parallel browser lanes need a database with per-worker tenants, which the fixture does not have.
- The design comparison is pixel by pixel, so the page and the reference must be the same size and rendered the same way. Fix the clock and the data, or dynamic content will differ. See `design-references.md`.

## Clock and time zone

A test case runs on the clock in its `clock` field, or `clock.fixedTime` in the config, and in its `timezone`, or the first of the config's `timezones` (G28). A fixed time freezes `Date` in the page. Without either, the page uses the machine's clock and zone, and date-dependent results can change from run to run. The API's server clock is the app's own; the skill cannot fix it.

## Cross-layer (e2e) test cases

A test case with the layer `e2e` mixes browser steps with backend `check` steps, so one test case acts as a user and then proves what the API serves and what the database stores:

```json
[
  { "act": "signIn", "as": "manager" },
  { "act": "goto", "path": "#/orders/o-2" },
  { "act": "expectResponse", "role": "button", "name": "Approve", "method": "POST", "path": "/api/orders/o-2/approve", "status": 403 },
  { "act": "check", "check": { "kind": "db", "query": "SELECT status, approvals FROM orders WHERE id = 'o-2'", "expectRows": [{ "status": "pending", "approvals": 0 }] } },
  { "act": "check", "check": { "kind": "http", "as": "admin", "request": { "method": "GET", "path": "/api/orders/o-2" }, "expect": { "status": 200, "json": [{ "path": "order.status", "equals": "pending" }] } } }
]
```

`run-e2e.mjs` runs them one at a time, each on a fresh database, with the same evidence as the browser runner. The failing step names the layer: `expectResponse` is the request the UI sent, `check` is the API or the database, and the other steps are the page. Backend check steps sign in by role through the API, with the same credentials as the browser.

