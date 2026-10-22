# Mobile verification (mobile-runner)

The mobile legs of each journey are verified in two ways: on the app's files, which needs no device, and on the installed app, through a Maestro flow, which needs a device or a simulator. Mobile web is verified by the browser runner, through device emulation (see `web-verification.md`).

## The build under test

A commit SHA does not identify a native binary. The ledger records each binary by its SHA-256, its version name and its build number, computed by the ledger itself. A native test case runs only against the binary recorded for its target.

The build handover is the expected hash. When the config sets `targets.<platform>.binarySha256`, a native test case is blocked unless the recorded binary has that hash. A rebuilt binary, or a store build that differs from the debug build, does not match and is not run.

## Static checks

A static test case reads the mobile project's files, named in `mobileProjects.android`. It needs no device, so it runs on any machine. Two check kinds exist:

- `manifest-attribute`: an attribute of the application element must equal the stated value. An attribute that is not declared is a failure, not a pass. The clean fixture declares its attributes explicitly.
- `no-hardcoded-secret`: a string resource whose name suggests a credential (`key`, `secret`, `token`, `password`) must not hold a literal value. A placeholder such as `${...}` or `@...` is not a secret. The finding names the file and the string, never the value.

## Native flows

A native test case runs a Maestro flow named in the plan's check, `{ "kind": "flow", "target": "android", "flow": "sign-in-and-list" }`. The config maps the flow name to its file, under `targets.<platform>.flows`. The flow reads credentials from the environment, so no credential is in the flow file.

The flow runs in this order, and each step blocks with its reason if it cannot run:

1. The target is in scope, and its flow is declared.
2. A binary is recorded for the target, and it matches the handover, when one is declared.
3. A device is attached (Android: `adb devices`; iOS: a booted simulator).
4. Maestro is installed.
5. Android only: the recorded binary is installed on the device with `adb install -r`. An iOS install is not implemented in this version, so an iOS flow is blocked until the app is installed on the simulator by other means.
6. The flow runs. Exit status 0 passes. Any other status fails, and the first line that names an assertion, a failure or an error is the message. A flow that exceeds five minutes is blocked, not failed.

Output is redacted with the run's credential values before it is stored.

## What this version does not do

- **Previous-version compatibility** (install the last release, log in, then install the new build against the same backend) is not implemented. It needs two binaries and a device.
- **Mobile accessibility on the platform tree** (TalkBack and VoiceOver labels, touch-target sizes from the accessibility tree) is not implemented. The web touch-target check covers mobile web only.
- **Device evidence** for native runs is the flow's own result. Screenshots and video of the device are not stored yet.
- **Native test matrix** across OS versions and device classes is planned, not run. The plan records each device a case needs.
- **Android is the only platform installed by the runner.** iOS flows run only on a simulator where the app is already installed.

## What a result means

- `passed`: every check held on the recorded build, on the device that ran it.
- `failed`: a static check did not hold, or the flow reported a failed assertion. A defect is opened, unless the failing requirements are derived and unconfirmed.
- `blocked`: a check could not run here. Blocked is never a pass, and a blocked P0 case keeps the gate at BLOCKED.
