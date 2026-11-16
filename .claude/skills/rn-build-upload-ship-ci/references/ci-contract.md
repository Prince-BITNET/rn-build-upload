# CI contract detail

Exit codes, from the README CI table:

| Code | Meaning |
| --- | --- |
| `0` | every selected platform built, verified and uploaded |
| `1` | build, artifact, signature or upload failure |
| `2` | usage error (bad flags, missing `--platform`/environment in CI, unusable `--output-json` path) |
| `3` | another `ship` run holds this project's lock |
| `4` | the run succeeded but the `--output-json` file could not be written |
| `130` | cancelled (Ctrl+C, SIGTERM, SIGHUP) |

Result JSON fields to keep stable (schema version 1): `outcome`, `exitCode`, `error` (`{ code, message, phase, platform }`), `project.commitSha`, `project.workingTreeDirty`, `request`, `startedAt`, `finishedAt`, `durationMs`, `platforms[]` (`status`, `version`, `artifact.sha256`, `artifact.signature`, `artifactUrl`, `durations`), `warnings`.

Error codes emitted: `BUILD_FAILED`, `UPLOAD_FAILED`, `UPLOAD_NO_URL`, `CANCELLED`, `INCOMPLETE`, `INTERNAL`. A raw system code such as `ENOENT` is reported as the failing phase's code.

BetaDrop is pinned to an exact CLI version; bump it deliberately after a registry check.
