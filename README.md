# rn-build-upload → `ship`

Build a React Native **release APK / IPA** (staging or production) and upload it to
[BetaDrop](https://betadrop.app), then copy the share message to the clipboard.

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
ship --check                          # show what the tool detects, build nothing
```

| Flag | Meaning |
| --- | --- |
| `--platform android\|ios` | Skip the platform prompt (required with `--ci`) |
| `--uat` / `--prod` | Staging (`isUAT=true`) / Production (`isUAT=false`) backend |
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

- Uploads through `npx -y @betadrop/cli publish --ci`, so the install link is
  printed on the last stdout line; the **link expires after 7 days**.
- The build label/notes come from the detected app label, e.g.
  `AlfaPTE Android Staging Build — v8.5 (build 193)`.
- The share message copied to the clipboard is
  `AlfaPTE: [Android Stag Build](LINK)` (or `iOS`).
- iOS builds reuse Xcode's own DerivedData, so caches are shared with manual
  Xcode builds. The generated `.ipa` lives in a temp staging folder that is
  removed again only after a successful upload.
