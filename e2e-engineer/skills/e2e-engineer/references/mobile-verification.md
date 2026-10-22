# Mobile verification (mobile-runner)

The mobile legs of each journey are verified in two ways: on the app's files, which needs no device, and on the installed app, through a Maestro flow, which needs a device or a simulator. Mobile web is verified by the browser runner, through device emulation (see `web-verification.md`).

## The build under test

A commit SHA does not identify a native binary. The ledger records each binary by its SHA-256, its version name and its build number, computed by the ledger itself. A native test case runs only against the binary recorded for its target.

The build handover is the expected hash. When the config sets `targets.<platform>.binarySha256`, a native test case is blocked unless the recorded binary has that hash. A rebuilt binary, or a store build that differs from the debug build, does not match and is not run.

## Static checks

A static test case reads the mobile project's files, named in `mobileProjects.android`. It needs no device, so it runs on any machine. Two check kinds exist:

- `manifest-attribute`: an attribute of the application element must equal the stated value. An attribute that is not declared is a failure, not a pass. The clean fixture declares its attributes explicitly.
- `no-hardcoded-secret`: a string resource whose name suggests a credential (`key`, `secret`, `token`, `password`) must not hold a literal value. A placeholder such as `${...}` or `@...` is not a secret. The finding names the file and the string, never the value.

## Native checks

A native test case lists checks of three kinds. The config maps each flow name to its file, under `targets.<platform>.flows`. A flow reads credentials from the environment, so no credential is in the flow file.

| Kind | Does |
| --- | --- |
| `flow` | Installs the build under test, then runs the Maestro flow |
| `compat` | Previous-version compatibility (M6): uninstalls the app, installs the previous release, runs the flow, installs the build under test over it (keeping its data), and runs the flow again. Record the previous release with `ledger.mjs binary <ledger> <target> <file> --version <v> --build <n> --previous true` |
| `a11y-tree` | Android: runs the flow to the screen when one is named, then reads the accessibility tree with `uiautomator dump` and the density with `wm density`. A control that can be clicked with no text and no content description, or one smaller than `minDp` (48 by default) in either direction, fails. iOS needs XCUITest, so it is blocked here |

Each check runs in this order, and each step blocks with its reason if it cannot run:

1. The target is in scope, and its flow is declared.
2. A binary is recorded for the target, and it matches the handover, when one is declared. `compat` also needs the previous release.
3. The devices are attached. The device matrix is `targets.<platform>.devices`: every serial (Android) or UDID (iOS) listed must be attached, and the check runs on each. Without a list, it runs on the first attached Android device, or the booted simulator.
4. Maestro is installed.
5. The binary is installed: `adb -s <device> install -r` on Android; `xcrun simctl install <device>` on iOS, which takes the simulator build (`.app`). An `.ipa` is for a device, so it is blocked on a simulator.
6. The flow runs with `maestro --device <device> test`. Exit status 0 passes. Any other status fails, with the device and the first line that names an assertion, a failure or an error. A flow that exceeds five minutes is blocked, not failed.
7. Evidence: a screenshot pulled from each device, and on Android the last 300 lines of `logcat`, redacted. Video is not recorded: it is large and can hold personal data (M9).

After a failed install or flow, the devices are probed again. A device that is gone makes the check blocked as infrastructure, not failed, and the run stops (see the stop conditions in `SKILL.md`).

Output and device logs are redacted with the run's credential values before they are stored.

## What is not covered

- **The iOS accessibility tree.** VoiceOver labels and sizes need XCUITest inside the app's own UI tests. The `a11y-tree` check is blocked on iOS, with that reason.
- **Real devices from a device farm.** The matrix runs on attached devices and simulators. A cloud device farm is a connector the tester adds; its devices then appear to `adb` or `simctl`.
- **This environment.** No emulator or simulator runs here, so every native path is tested with a stand-in command runner. The static checks run everywhere.

## What a result means

- `passed`: every check held on the recorded build, on the device that ran it.
- `failed`: a static check did not hold, or the flow reported a failed assertion. A defect is opened, unless the failing requirements are derived and unconfirmed.
- `blocked`: a check could not run here. Blocked is never a pass, and a blocked P0 case keeps the gate at BLOCKED.
