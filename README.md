# rn-build-upload → `ship`

Build a React Native **release APK / IPA** (staging or production) and upload it to
[AppShare](https://appshare.qubebiz.com) (the default — needs an AppShare login),
[ShareIPA](https://www.shareipa.com) (`--provider shareipa`, no setup) or
[BetaDrop](https://betadrop.app) (`--provider betadrop`), then copy the
share message to the clipboard.

Installs the short `ship` command (`rn-build-upload` stays available as an alias).

One command, asks which platform(s) — check Android, iOS, or both — then the
environment — Staging or Production.

```text
◆  Select build platform(s)
│  ◻ Android   Gradle release APK
│  ◻ iOS       Xcode release IPA
└  ↑/↓ move · space to check · enter to confirm
│
◆  Build Android + iOS how?          (asked only when both are checked)
│  ● Sequential   build + upload one, then the other
│  ○ Parallel     build + upload both at the same time
│
◆  Select build environment
│  ● Staging
│  ○ Production
│
◇  Android + iOS builds ready — paste them anywhere with ⌘V
```

## Requirements

- macOS (uses `pbcopy` interactively, Xcode tools and `zip`)
- Node 18+
- Android: `android/gradlew` and the Android SDK, including **build-tools with
  `apksigner`** and a Java runtime (every release APK is signature-checked
  before upload — see [Safety checks](#safety-checks))
- iOS: Xcode + CocoaPods (`npm run pod` once, so `ios/*.xcworkspace` exists)

## Install (once per machine)

```bash
npm i -g github:Prince-BITNET/rn-build-upload
```

This installs `ship` (and the `rn-build-upload` alias).

The default provider, AppShare, needs your AppShare login in two environment
variables (accounts are created by the AppShare admin; add these to
`~/.zshrc`, or to masked CI variables):

```bash
export APPSHARE_EMAIL=you@example.com
export APPSHARE_PASSWORD='your-appshare-password'
```

ShareIPA (`--provider shareipa`) needs nothing. BetaDrop
(`--provider betadrop`) needs one-time auth (pick one):

```bash
npx -y @betadrop/cli@0.4.0 login        # interactive, recommended locally
export BETADROP_TOKEN=bd_live_xxxx      # or a token from betadrop.app -> Settings -> Developer
```

## Usage

Run it from anywhere inside a project:

```bash
ship                                  # pick platform(s), then environment (AppShare by default)
ship --platform ios                   # skip the platform question
ship --platform android --uat --ci --output-json build.json   # non-interactive (CI)
ship --platform android,ios --uat     # both platforms in one run (asks Sequential/Parallel)
ship --platform android --uat --expires-in-days 30  # AppShare link that lasts 30 days
ship --platform android --uat --provider betadrop   # upload to BetaDrop instead
ship --check                          # show what the tool detects, build nothing
```

| Flag | Meaning |
| --- | --- |
| `--platform android\|ios\|android,ios` | Pick one or both platforms (required with `--ci`; CI runs both sequentially) |
| `--uat` / `--prod` | Staging (`isUAT=true`) / Production (`isUAT=false`) backend |
| `--provider appshare\|shareipa\|betadrop` | Upload provider — `appshare` (default), `shareipa` or `betadrop` |
| `--expires-in-days <days\|never>` | AppShare link lifetime: `1`, `3`, `7`, `14`, `30`, `90`, `365` or `never` (default **90**). AppShare only |
| `--verbose` | Stream the full Gradle / xcodebuild output (sequential/single; parallel uses the compact view) |
| `--ci` | Plain, line-oriented output for scripts and CI — needs `--platform` and `--uat`/`--prod`; never prompts, never uses the clipboard ([CI mode](#ci-mode)) |
| `--output-json <path>` | Write the machine-readable run result to `<path>` ([CI result JSON](#ci-result-json)) |
| `--check` | Print the detected project profile and exit (never writes a result file) |

### Building both platforms in one run

Check both boxes (or pass `--platform android,ios`) and pick how they run —
that question appears **only** when both are selected:

- **Sequential** (default) — Android builds and uploads, then iOS. One adapter
  at a time, full live progress for each; both links land at the end.
- **Parallel** — Gradle and Xcode run side by side, each upload starts as soon
  as its build finishes, and the view shows both streams prefixed
  (`[Android] …` / `[iOS] …`). Faster, but heavy — two toolchains at once need
  a lot of CPU/RAM.

Either way the clipboard gets **both** lines:

```text
Alfa-PTE (PROD): [Android Build Link](https://appshare.qubebiz.com/s/xxxxxxxxxx)
Alfa-PTE (PROD): [iOS Build Link](https://appshare.qubebiz.com/s/yyyyyyyyyy)
```

If only one checkbox is selected, `ship` behaves exactly like before — no
Sequential/Parallel question.

Per-project convenience scripts (optional):

```json
{
  "scripts": {
    "ship": "rn-build-upload",
    "build": "rn-build-upload",
    "androidBuild": "rn-build-upload --platform android"
  }
}
```

Then `bun ship` / `npm run ship` (note: `bun build` alone is Bun's bundler).

## Upload providers

`ship` uses **AppShare** unless `--provider shareipa` or `--provider betadrop`
is given.

| Provider | Setup | Upload |
| --- | --- | --- |
| `appshare` (default) | `APPSHARE_EMAIL` + `APPSHARE_PASSWORD` | AppShare web API (the same calls the web app makes) |
| `shareipa` | none | ShareIPA website flow, **unofficial** |
| `betadrop` | one-time `npx -y @betadrop/cli@0.4.0 login` (or `BETADROP_TOKEN`) | official CLI (pinned **0.4.0**), official API |

### AppShare (default)

Uploads to [appshare.qubebiz.com](https://appshare.qubebiz.com) through the
same API its web upload page uses:

1. Sign in (`POST /api/auth/login`) with `APPSHARE_EMAIL` / `APPSHARE_PASSWORD`.
   This happens **before the build starts**, so wrong or missing credentials
   fail in seconds (exit `1`, `UPLOAD_AUTH_FAILED`) instead of after a
   10-minute build.
2. Start a multipart upload, `PUT` the parts straight to AppShare's storage
   (4 at a time, 3 tries per part, live byte progress), then complete it.
3. Publish the build with its name (`AlfaPTE Android Staging`), version,
   build number, bundle/package ID (`applicationId` / `PRODUCT_BUNDLE_IDENTIFIER`),
   app icon, release notes and expiry. A failed or cancelled upload is deleted again.

Link: **`https://appshare.qubebiz.com/s/<slug>`** — copied in the share
message. Links expire after **90 days** by default; change it per run with
`--expires-in-days` (`1`, `3`, `7`, `14`, `30`, `90`, `365` or `never`, the
same choices as the AppShare upload form). Install pages are not
password-protected.

The app icon comes from the project itself: on Android the densest
`mipmap-*`/`drawable-*` bitmap named by `android:icon` in
`AndroidManifest.xml`, on iOS the largest image in
`<App>/Images.xcassets/AppIcon.appiconset`. macOS `sips` converts it to a PNG
of at most 256 px (never upscaled), the same as AppShare's web page sends. A
project without such an icon (e.g. vector-only) uploads with AppShare's
placeholder; a missing icon never fails an upload.
The credentials, session cookie and storage upload URLs are never printed.
Like ShareIPA, this API is not a documented public API: if AppShare changes
its web app, uploads can break until `ship` is updated.

### ShareIPA (`--provider shareipa`)

Uploads through the same public website flow the ShareIPA browser UI uses —
no account, no login, no token to configure:

1. `GET /website/api/v1/app/getSignedUrl?fileType=apk|ipa` — creates the
   application id and returns a presigned object-storage URL; the anonymous
   bearer token comes back in the response `token` header (15-minute expiry).
2. `PUT` the APK/IPA straight to the presigned URL — real byte progress.
3. `POST /website/api/v1/app/save` — registers the build and processes it
   (name/version/icon); there is no polling, the call returning means the
   app is live.

Links produced:
- **Install URL** `https://install.shareipa.com/<id>` — copied in the share message
- **Admin URL** `https://dashboard.shareipa.com/admin/<id>` — analytics/management

**This is unofficial.** ShareIPA's free tier has no public API — their own
FAQ says *"ShareIPA (free) doesn't offer API/CLI integrations"* (the paid
Zunoy **AppShare** product does). This provider drives the same
*undocumented website endpoints the browser calls*, so it can break without
notice. If it does, upload manually at
[shareipa.com](https://www.shareipa.com), use BetaDrop, or check for an
updated `ship`.

No credentials are stored or printed: every run gets a fresh anonymous token,
and tokens/browser ids/presigned URLs are scrubbed from all output. Free-tier
links expire after **7 days** (max upload 250 MB). A failed upload is retried
once with a fresh signed URL; a successful upload whose registration fails is
never silently re-sent.

### BetaDrop (`--provider betadrop`)

Uploads through the official BetaDrop CLI and mirrors the CLI's own progress
bar live; select it with `--provider betadrop` (one-time auth above).

The CLI is **pinned to exactly `@betadrop/cli@0.4.0`** (`BETADROP_CLI_VERSION`
in `lib/build-upload.js`): `ship` runs `npx -y @betadrop/cli@0.4.0 publish …`
and never an unpinned "latest". 0.4.0 (published 2026-09-16, the current
release at the time of pinning) was checked to provide `publish <file>
--name --notes --expires-in-days --ci`, with `--ci` printing the install URL
as the last stdout line, and has no install scripts. Bump the pin
deliberately, after re-checking that contract.

## What it detects (no config file)

| Thing | Convention |
| --- | --- |
| Project root | Nearest ancestor of the CWD with `package.json` next to `android/` or `ios/` |
| App label | Native display name with spaces stripped — `Alfa PTE` → `AlfaPTE`, `PTE Now` → `PTENow` (then `app.json`, then `package.json` name) |
| Backend switch | `src/Helper/APPConfig.js` with `const isUAT = true|false` (always restored after the build, even on Ctrl+C) |
| Android | `android/app/build.gradle`, `assembleRelease`; with `newArchEnabled=true` also `:app:generatePackageList` + `generateCodegenArtifactsFromSchema` |
| Android artifact | `android/app/build/outputs/apk/release/app-release.apk` |
| iOS | `ios/*.xcworkspace` + the shared scheme matching `release-*` (e.g. `release-alfapte`, `Release-PTENow`) |
| iOS artifact | `xcodebuild` release build → `<App>.app` from DerivedData → `Payload/` → zip → `.ipa` |

`--check` prints exactly what was detected, per platform — useful before the
first run in a project.

## Behaviour

- AppShare (the default) signs in before building, shows a live bar with real
  byte progress while the parts upload, then "Processing on AppShare…" while
  the build is published; links last 90 days unless `--expires-in-days` says
  otherwise.
- ShareIPA (`--provider shareipa`) shows a live bar with real byte progress from its
  direct HTTP PUT, switches to "Processing on ShareIPA…" while the build is
  registered, and produces a 7-day install link.
- BetaDrop (`--provider betadrop`) uploads through the official
  `npx -y @betadrop/cli@0.4.0 publish`, mirroring the CLI's own progress bar live
  (percentage, MB sent, speed) and switching to "Processing on BetaDrop…"
  while the server finalizes the build; the **link expires after 7 days**.
- `--ci` keeps the machine contract instead: no spinners, no prompts, no
  clipboard; the share message lines (one per platform, each containing the
  install link) are the last stdout lines. See [CI mode](#ci-mode).
- The build label/notes come from the detected app label, e.g.
  `AlfaPTE Android Staging Build — v8.5 (build 193)`.
- The share message copied to the clipboard is
  `Alfa-PTE (STAG): [Android Build Link](LINK)` — the app name is hyphenated
  (`AlfaPTE` → `Alfa-PTE`, `PTENow` → `PTE-Now`), the environment is `STAG`
  or `PROD`, and the link text is `Android`/`iOS Build Link`. A two-platform
  run copies both lines together.
- iOS builds reuse Xcode's own DerivedData, so caches are shared with manual
  Xcode builds. The generated `.ipa` lives in a temp staging folder that is
  removed after the upload — successful, failed or cancelled. After a failed
  upload the message points at the built `.app`; re-run to package and
  upload again.

## CI mode

`--ci` differs from the interactive mode as follows:

| | Interactive | `--ci` |
| --- | --- | --- |
| Platform / environment | asked (or flags) | **required**: `--platform …` and `--uat`/`--prod` (no fallback to the `APPConfig.js` value), checked before the lock is taken or any build tool runs |
| Two platforms | Sequential or Parallel (asked) | always sequential |
| Output | Clack UI, spinners, colours | plain lines; progress on stdout, errors on stderr; no ANSI codes |
| Success output | share message + `⌘V` hint | share message lines (one per platform) are the **last stdout lines** |
| Clipboard | share message copied with `pbcopy` (every non-`--ci` run, also without a TTY) | **never** touched |
| Result file | optional `--output-json` | optional `--output-json` (recommended) |

Exit codes (both modes):

| Code | Meaning |
| --- | --- |
| `0` | every selected platform built, verified and uploaded |
| `1` | build, artifact, signature or upload failure — including a build tool killed by a signal `ship` did not send (e.g. the OOM killer): that is `BUILD_FAILED`, not a cancellation |
| `2` | usage error (bad flags, missing `--platform`/environment in CI, unusable `--output-json` path) |
| `3` | another `ship` run holds this project's lock |
| `4` | the run succeeded but the `--output-json` file could not be written |
| `130` | cancelled (Ctrl+C, SIGTERM, SIGHUP) |

## CI result JSON

`--output-json <path>` writes one JSON document describing the run (schema
version `1`). The directory must exist and be writable — checked **before**
building (exit `2` otherwise). A file already at `<path>` is removed at start
(also by `--check` and `--help`, which never write a result), so a stale
result from an earlier run is not left behind for this one. The
file is written atomically (temp file in the same directory, then rename) by
the exit handler, after cleanup, so it reflects the real exit code on every
exit path, including failures and cancellation.

```json
{
  "schemaVersion": 1,
  "tool": { "name": "rn-build-upload", "version": "2.1.0" },
  "outcome": "success",
  "exitCode": 0,
  "error": null,
  "project": {
    "name": "AlfaPTE",
    "root": "/path/to/checkout",
    "commitSha": "5b20fc1…(40 hex)",
    "workingTreeDirty": false
  },
  "request": { "platforms": ["android"], "environment": "uat", "provider": "appshare", "ci": true, "expiresInDays": 90 },
  "startedAt": "2026-10-24T10:00:00.000Z",
  "finishedAt": "2026-10-24T10:09:12.345Z",
  "durationMs": 552345,
  "platforms": [
    {
      "platform": "android",
      "status": "success",
      "version": { "name": "8.9", "code": "199" },
      "artifact": {
        "name": "app-release.apk",
        "sizeBytes": 99614720,
        "sha256": "…(64 hex)",
        "signature": { "verified": true, "schemes": ["v2", "v3"], "verifier": "build-tools 36.0.0" }
      },
      "artifactUrl": "https://appshare.qubebiz.com/s/xxxxxxxxxx",
      "durations": { "buildMs": 480000, "uploadMs": 65000 },
      "error": null
    }
  ],
  "warnings": []
}
```

| Field | Notes |
| --- | --- |
| `outcome` | `success`, `failure` or `cancelled`. `success` only when the exit code is `0` **and** every selected platform has `status: "success"` and an `artifactUrl`; anything else is downgraded to `failure` |
| `exitCode` | the process exit code (table above) |
| `error` | `null` on success, else `{ code, message, phase, platform }` for the first failure |
| `project.commitSha` / `workingTreeDirty` | `git rev-parse HEAD` / `git status --porcelain` of the project, read before `APPConfig.js` is patched; `null` when not a git checkout |
| `request.environment` | `uat` / `prod` as requested (`null` if never resolved) |
| `request.expiresInDays` | AppShare link lifetime in days, or `"never"`; `null` for other providers |
| `platforms[].status` | `success`, `failure`, `cancelled`, or `skipped` (never started, e.g. iOS after an Android failure) |
| `platforms[].artifactUrl` | set **only** after that platform's upload returned a link; `null` otherwise. In a two-platform run, a platform that really uploaded keeps its link even if the other failed (overall `outcome` is then `failure`) |
| `platforms[].artifact.sha256` | SHA-256 of the exact file that was uploaded: a private snapshot of the APK (the same bytes apksigner verified) or the staged IPA |
| `platforms[].artifact.signature` | Android: the `apksigner` result (`null` for iOS — `ship` does not check IPA signatures) |
| `warnings` | non-fatal problems, e.g. an `APPConfig.js` edited during the build, or a temp dir that could not be removed |

`error.code` values: `USAGE`, `PROJECT_NOT_FOUND`, `PLATFORM_UNAVAILABLE`,
`LOCKED`, `LOCK_FAILED`, `PROJECT_SETTINGS_FAILED`, `ENV_CONFIG_INVALID`,
`BUILD_FAILED`, `ARTIFACT_NOT_FOUND`, `ARTIFACT_INVALID`, `APK_UNSIGNED`,
`APK_SIGNATURE_INVALID`, `APK_VERIFY_UNAVAILABLE`, `UPLOAD_FAILED`,
`UPLOAD_AUTH_FAILED` (AppShare sign-in, checked before the build),
`UPLOAD_NO_URL`, `CANCELLED`, `INCOMPLETE`, `INTERNAL`. Only these are emitted
(a raw system error code such as `ENOENT` is reported as the failing phase's
code); treat any unrecognised future code as a failure.

Never in the file: tokens, passwords, environment variables, provider
responses, and the ShareIPA admin link (it grants management of the upload).
Error messages pass through the same sanitizer as provider output.

## Safety checks

**Android signature verification (fail closed).** The release APK is first
copied into a private temp directory; that snapshot is what gets verified,
hashed and uploaded, so replacing the build output in the checkout midway
cannot slip an unverified file into the upload. Before any upload, the
snapshot is checked with the Android SDK's `apksigner verify --verbose`.
It is uploaded only if apksigner exits 0, prints `Verifies` and reports at
least one verified scheme. Unsigned APKs (`APK_UNSIGNED`), invalid or
malformed ones (`APK_SIGNATURE_INVALID`) and every case where verification
cannot run — no apksigner, no Java, unexpected output
(`APK_VERIFY_UNAVAILABLE`) — stop the run with exit `1`; nothing is uploaded.
apksigner is found via `$SHIP_APKSIGNER`, then the newest
`build-tools/*/apksigner` under `$ANDROID_HOME`, `$ANDROID_SDK_ROOT`,
`android/local.properties` `sdk.dir` or `~/Library/Android/sdk`, then `PATH`.
This proves the APK is signed and verifiable; it does **not** establish that
it was signed by the *expected* certificate. Any key — a debug key, a leaked
key, anyone's key — passes. No certificate is printed, compared or stored,
and no certificate pin exists yet; one must come from a trusted, non-exposed
UAT key, never from signing material that has been exposed.

**One run per checkout (lock).** `ship` builds in your checkout and patches
`src/Helper/APPConfig.js` in place, so it takes an exclusive per-project lock
for the whole run (`$TMPDIR/rn-build-upload-locks/<hash of the project
path>.lock`; nothing is written into the repo). A second run in the same
checkout fails immediately with exit `3`; it does not touch `APPConfig.js`,
build outputs or the other run's lock (it only replaces its own
`--output-json` file). Different checkouts (e.g. git worktrees) do not block
each other. A lock left by a killed run (pid gone on this host) is taken over
automatically, with a warning if that run had `APPConfig.js` patched;
takeovers are serialised by an exclusive `<lock>.takeover` file, so two runs
can never both take over the same stale lock. The lock lives in `$TMPDIR`,
so it only coordinates runs that share a TMPDIR (normally the same macOS
user); a reused pid makes a stale lock look alive (fails safe: exit `3`,
remove the file by hand).

**APPConfig.js restore.** The file is snapshotted as it is when the run
starts (including your uncommitted edits), patched atomically, and restored
after the last build — also on failure, Ctrl+C and SIGTERM. If you edit the
file during the build, only `isUAT` is put back and your other edits are
kept; if you changed `isUAT` yourself, the file is left alone with a warning.
**`SIGKILL` (`kill -9`, a runner's hard kill) cannot be intercepted: no
restore, cleanup or result write runs.** `APPConfig.js` may stay patched, the
staged APK/IPA stays in `$TMPDIR` and the result file is not written (which
is itself a failure signal). The next run in that checkout warns about the
stale lock, but it snapshots the still-patched file as its "original" — fix
the file (e.g. `git checkout src/Helper/APPConfig.js`) before trusting a
later build. A fresh CI checkout per job avoids this.

**Temp files and cancellation.** `ship` only removes temp directories it
created itself (`$TMPDIR/rn-build-upload-*`), after success, failure or
cancellation, plus a last-chance sweep at process exit. Build outputs in the
project and DerivedData are never deleted. A cleanup problem is reported as a
warning and never replaces the original error. On Ctrl+C / SIGTERM / SIGHUP,
every running child **and its descendants** get SIGINT (escalated to SIGTERM
after 10 s and SIGKILL after 20 s), no new upload is started, and `ship` does
not wait for descendants that hold its output pipes: once the direct child has
exited, the run ends and any remembered descendant still alive gets SIGTERM,
up to 1 s, then SIGKILL. A second signal kills immediately. Processes that
were already running before the build (e.g. an existing Gradle daemon) are not
descendants of the run and are not stopped. A remembered pid could in theory
be reused by an unrelated process within that second; this is accepted.

## Tests

```bash
npm test
```

Runs the mocked test suite — it never touches AppShare, ShareIPA or BetaDrop (API calls
use fake fetch implementations, the presigned PUT runs against a local HTTP
server, and the spawn-level CLI tests in `test/cli.test.js` run the real
`ship` entry point in throwaway projects with stand-in `gradlew`,
`xcodebuild`, `apksigner` and `pbcopy` and stubbed upload providers). Those
CLI tests prove exit codes, the JSON contract, locking, restore, cleanup and
cancellation; they do **not** prove that a real Gradle/Xcode build or upload
works.

When the Android SDK is installed, one integration test runs the **real**
`apksigner` against throwaway unsigned/non-APK files (skipped otherwise).
`SHIP_APKSIGNER_IT_SIGNED_APK=/path/to/known-good.apk` additionally checks a
signed APK and a copy with its signature stripped (nothing is signed). Use
an APK that is not one of your own release artifacts (e.g. one shipped in the
Android SDK); never point it at production-signed builds.

The one live ShareIPA test is opt-in and clearly labelled:

```bash
SHIP_SHAREIPA_E2E=1 SHIP_SHAREIPA_E2E_FILE=/path/to/app-release.apk npm test
```

It performs a single real anonymous upload and checks that the install URL
resolves; the created link simply expires after 7 days.

## Releases

Pin `ship` in CI by tag, not by branch. Install the current release with:

```bash
npm i -g github:Prince-BITNET/rn-build-upload#v2.1.0
```

- **2.1.0** — AppShare uploads include the app icon (from the project's
  launcher icon / AppIcon set).
- **2.0.0** — AppShare is the default provider (`--expires-in-days`, default
  90). Breaking for automation: unsigned APKs are rejected, `--ci` requires an
  environment flag and no longer copies to the clipboard, the iOS staging IPA
  is removed after a failed upload.

BetaDrop pin scope: `npx -y @betadrop/cli@0.4.0` always runs exactly 0.4.0
(verified: a different locally installed version is ignored, and an
unavailable version fails with `notarget` rather than falling back). The
CLI's own dependencies are resolved by npm within their semver ranges at
install time, and the project's `.npmrc` applies because npx runs from the
project root.

Known, not fixed (cosmetic): `StepError` ignores its `buildFailed` option
(also on `main`), so the interactive task log says "Failed" instead of
"Android build failed". It does not affect exit codes or `error.code`.
