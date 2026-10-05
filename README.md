# rn-build-upload → `ship`

Build a React Native **release APK / IPA** (staging or production) and upload it to
[BetaDrop](https://betadrop.app) (default) or [ShareIPA](https://www.shareipa.com)
(with `--provider shareipa`), then copy the share message to the clipboard.

Installs the short `ship` command (`rn-build-upload` stays available as an alias).

One command, asks for the platform first — Android or iOS — then the environment —
Staging or Production.

```text
◆  Select build platform
│  ● Android
│  ○ iOS
│
◆  Select build environment
│  ● Staging
│  ○ Production
│
◇  Android build ready — paste it anywhere with ⌘V
```

## Requirements

- macOS (uses `pbcopy`, Xcode tools and `zip`)
- Node 18+
- Android: `android/gradlew` and the Android SDK
- iOS: Xcode + CocoaPods (`npm run pod` once, so `ios/*.xcworkspace` exists)

## Install (once per machine)

```bash
npm i -g github:Prince-BITNET/rn-build-upload
```

This installs `ship` (and the `rn-build-upload` alias).

One-time BetaDrop auth (pick one):

```bash
npx -y @betadrop/cli login              # interactive, recommended locally
export BETADROP_TOKEN=bd_live_xxxx      # or a token from betadrop.app -> Settings -> Developer
```

## Usage

Run it from anywhere inside a project:

```bash
ship                                  # ask platform, then environment
ship --platform ios                   # skip the platform question
ship --platform android --uat --ci    # non-interactive (CI)
ship --platform ios --prod --provider shareipa   # upload to ShareIPA
ship --check                          # show what the tool detects, build nothing
```

| Flag | Meaning |
| --- | --- |
| `--platform android\|ios` | Skip the platform prompt (required with `--ci`) |
| `--uat` / `--prod` | Staging (`isUAT=true`) / Production (`isUAT=false`) backend |
| `--provider betadrop\|shareipa` | Upload provider (default: `betadrop`) |
| `--verbose` | Stream the full Gradle / xcodebuild output |
| `--ci` | Plain, line-oriented output for scripts and CI |
| `--check` | Print the detected project profile and exit |

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

| Provider | Setup | Upload |
| --- | --- | --- |
| `betadrop` (default) | one-time `npx -y @betadrop/cli login` (or `BETADROP_TOKEN`) | official CLI, official API |
| `shareipa` | none | ShareIPA website flow, **unofficial** |

### BetaDrop (default)

Uploads through `npx -y @betadrop/cli publish` and mirrors the CLI's own
progress bar live. No change from previous versions.

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

- BetaDrop uploads through the official `npx -y @betadrop/cli publish`,
  mirroring the CLI's own progress bar live (percentage, MB sent, speed) and
  switching to "Processing on BetaDrop…" while the server finalizes the build;
  the **link expires after 7 days**.
- ShareIPA (`--provider shareipa`) shows the same live bar with real byte
  progress from its direct HTTP PUT, switches to "Processing on ShareIPA…"
  while the build is registered, and produces a 7-day install link.
- `--ci` keeps the machine contract instead: no spinners, install link as the
  last stdout line.
- The build label/notes come from the detected app label, e.g.
  `AlfaPTE Android Staging Build — v8.5 (build 193)`.
- The share message copied to the clipboard is
  `AlfaPTE: [Android Stag Build](LINK)` (or `iOS`).
- iOS builds reuse Xcode's own DerivedData, so caches are shared with manual
  Xcode builds. The generated `.ipa` lives in a temp staging folder that is
  removed again only after a successful upload.

## Tests

```bash
npm test
```

Runs the mocked test suite — it never touches ShareIPA or BetaDrop (API calls
use fake fetch implementations, the presigned PUT runs against a local HTTP
server). The one live ShareIPA test is opt-in and clearly labelled:

```bash
SHIP_SHAREIPA_E2E=1 SHIP_SHAREIPA_E2E_FILE=/path/to/app-release.apk npm test
```

It performs a single real anonymous upload and checks that the install URL
resolves; the created link simply expires after 7 days.
