---
name: rn-build-upload-ship-ci
description: Use when changing rn-build-upload ship --ci or result JSON.
category: tooling
---

# rn-build-upload `ship` CI contract

Keep the `--ci` contract stable: exit codes, the result JSON schema, and the no-clipboard rule are what GitLab CI depends on. Change them only together with the README tables and the tests.

- Exit codes: `0` success; `1` build, artifact, signature or upload failure; `2` usage error; `3` lock held by another run; `4` run succeeded but `--output-json` could not be written; `130` cancelled by Ctrl+C, SIGTERM or SIGHUP only.
- A build tool killed by a signal `ship` did not send (OOM killer, `kill -9`) is `BUILD_FAILED` with exit `1`, never a cancel.
- `--ci` requires `--platform` and `--uat`/`--prod`, and rejects them before the lock or any build tool runs. Never fall back to `APPConfig.js`.
- `--ci` never runs `pbcopy`. Every non-`--ci` run does, also without a TTY.
- The result file is removed at start on every path, including `--check` and `--help`, and is written atomically by the exit handler. `outcome: success` requires exit `0`, every selected platform `success`, and an `artifactUrl`.
- Android: copy the APK to a private temp dir, then verify, hash and upload that snapshot. `apksigner verify` proves a valid signature, not the expected key.
- Restore `APPConfig.js` from the snapshot taken at run start, and never clobber edits made during the build.
- Opt-in real-tool test: `SHIP_APKSIGNER_IT_SIGNED_APK=<apk> node --test --test-name-pattern=integration test/apk-signature.test.js`.

Details and the result JSON fields: [references/ci-contract.md](references/ci-contract.md).
