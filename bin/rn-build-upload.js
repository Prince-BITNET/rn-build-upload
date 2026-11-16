#!/usr/bin/env node
/**
 * ship — build a React Native release APK/IPA and upload it to BetaDrop.
 * (Installed as `ship`, with `rn-build-upload` as an alias.)
 *
 * Usage:
 *   ship [--platform android|ios|android,ios] [--uat | --prod] [--provider appshare|shareipa|betadrop]
 *        [--expires-in-days <days|never>] [--verbose] [--ci] [--output-json <path>] [--check]
 *
 *     no flags   Ask which platform(s) first, then which environment
 *     --platform android|ios  Skip the platform prompt
 *     --platform android,ios  Both platforms in one run (Sequential or Parallel)
 *     --uat      Stag backend (isUAT=true)
 *     --prod     Prod backend (isUAT=false)
 *     --provider appshare|shareipa|betadrop  Upload provider (default: appshare)
 *     --expires-in-days <days|never>  AppShare link lifetime (default: 90)
 *     --verbose  Stream the full build output (default shows a compact live view)
 *     --ci       Plain non-interactive output for scripts/CI (requires --platform
 *                and --uat|--prod; never prompts, never uses the clipboard)
 *     --output-json <path>  Write the machine-readable run result (README)
 *     --check    Print the detected project profile and exit (no build, no upload)
 *
 * Flow: detect the project -> set isUAT in src/Helper/APPConfig.js (restored
 * after the build, even on Ctrl+C) -> build (Gradle release APK or Xcode
 * release IPA via the release-* scheme) -> verify (apksigner for Android
 * APKs, fail closed) -> upload (AppShare by default; ShareIPA / BetaDrop
 * with --provider; all with live upload progress) -> Markdown -> pbcopy
 * (never with --ci). One run per checkout at a time (project lock).
 *
 * Per-project convenience scripts, e.g.:
 *   "ship": "rn-build-upload",
 *   "androidBuild": "rn-build-upload --platform android"
 *
 * One-time setup per machine:
 *   npm i -g github:Prince-BITNET/rn-build-upload
 *
 * AppShare (the default) needs APPSHARE_EMAIL and APPSHARE_PASSWORD.
 * ShareIPA (--provider shareipa) needs no setup. BetaDrop (--provider
 * betadrop) needs one of:
 *   npx -y @betadrop/cli@0.4.0 login                (interactive, recommended)
 *   export BETADROP_TOKEN=bd_live_xxxx              (token from betadrop.app)
 */

const { detectProject } = require('../lib/detect');
const {
  EXIT_RESULT_WRITE,
  EXIT_USAGE,
  exitCodeFor,
  installSignalHandlers,
  p,
  parseArgs,
  peekOutputJson,
  plain,
  renderStepError,
  renderUsageError,
  resolvePlatforms,
  run,
  usageText,
} = require('../lib/build-upload');
const lifecycle = require('../lib/lifecycle');
const { StepError } = require('../lib/errors');
const { createRecorder, prepareOutputPath, readGitInfo } = require('../lib/result');
const { createAndroidAdapter } = require('../lib/platforms/android');
const { createIosAdapter } = require('../lib/platforms/ios');

const ENTRY = {
  command: 'ship',
  label: null,
  allowPlatform: true,
  verboseHint: 'Stream the full build output (default shows a compact live view)',
};

/* `rn-build-upload --check | head` should not crash with EPIPE. */
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE') process.exit(0);
});

const PLATFORMS = {
  android: { label: 'Android', artifactWord: 'APK', buildFailedTitle: 'Android build failed', create: createAndroidAdapter },
  ios: { label: 'iOS', artifactWord: 'IPA', buildFailedTitle: 'iOS build failed', create: createIosAdapter },
};

function failPlain(err) {
  plain.fail(err.message);
  if (err.details) plain.fail(err.details);
  if (err.hint) plain.fail(err.hint);
  process.exit(err.usage ? EXIT_USAGE : exitCodeFor(err));
}

/**
 * Result recorder for --output-json. The file is written by an 'exit'
 * finalizer, after APPConfig restore, temp cleanup and unlock, so it carries
 * the real exit code and any cleanup warnings — on every exit path.
 */
function removeStaleResult(outputJson) {
  if (!outputJson) return;
  try {
    prepareOutputPath(outputJson);
  } catch (err) {
    /* nothing usable at that path */
  }
}

function setUpRecorder(outputJson) {
  if (!outputJson) return createRecorder();
  const resolved = prepareOutputPath(outputJson);
  const recorder = createRecorder({ outputPath: resolved });
  lifecycle.addFinalizer((code) =>
    recorder.write(code, { extraWarnings: lifecycle.cleanupWarnings(), writeFailedCode: EXIT_RESULT_WRITE }),
  );
  return recorder;
}

/** Print the detected profile (and version, when readable) — no side effects. */
async function check(profile, requestedPlatforms) {
  console.log(`Project : ${profile.root}`);
  console.log(`App     : ${profile.appName}`);
  console.log(`Link    : ${profile.shareName}`);
  console.log(`Env     : ${profile.envFile}`);
  const platforms = requestedPlatforms && requestedPlatforms.length > 0 ? requestedPlatforms : ['android', 'ios'];
  for (const key of platforms) {
    console.log('');
    console.log(`[${key}]`);
    if (!profile[key]) {
      console.log('  not found in this project');
      continue;
    }
    try {
      const adapter = PLATFORMS[key].create(profile);
      const version = await adapter.readVersionInfo();
      const info = profile[key];
      const rows =
        key === 'android'
          ? {
              dir: info.dir,
              gradleFile: info.gradleFile,
              gradleTasks: info.gradleTasks.join(' '),
              releaseDir: info.releaseDir,
              expectedApk: info.expectedApkName,
            }
          : {
              dir: info.dir,
              workspace: info.workspace || '(missing — run pod install)',
              scheme: info.scheme || `(none matching release-*, found: ${info.schemes.join(', ') || 'none'})`,
              configuration: info.configuration,
              destination: info.destination,
            };
      for (const [k, v] of Object.entries(rows)) console.log(`  ${`${k}:`.padEnd(14)}${v}`);
      console.log(`  ${'version:'.padEnd(14)}v${version.versionName} (build ${version.versionCode})`);
    } catch (err) {
      console.log(`  not usable: ${err.message}`);
      if (err.details) console.log(`  ${err.details.split('\n').join('\n  ')}`);
    }
  }
}

async function main() {
  /* Before anything else: a signal must still run the exit hooks. */
  installSignalHandlers();
  const argv = process.argv.slice(2);
  let parsed;
  try {
    parsed = parseArgs(argv, { allowPlatform: true });
  } catch (err) {
    /* Still report the usage error when the result path itself was readable. */
    const outputJson = peekOutputJson(argv);
    if (outputJson) {
      try {
        setUpRecorder(outputJson).fail(err, { phase: 'args' });
      } catch (setupErr) {
        /* unusable path: the usage error below is all we can report */
      }
    }
    if (argv.includes('--ci')) failPlain(err);
    renderUsageError(err, ENTRY);
    return;
  }
  if (parsed.help) {
    /* No result is written for --help, but a stale one must not survive. */
    removeStaleResult(peekOutputJson(argv));
    console.log(usageText(ENTRY));
    process.exit(0);
  }

  let recorder;
  try {
    if (parsed.check) {
      /* --check never writes a result; it only removes a stale one. */
      if (parsed.outputJson) prepareOutputPath(parsed.outputJson);
      recorder = createRecorder();
    } else {
      recorder = setUpRecorder(parsed.outputJson);
    }
  } catch (err) {
    const usageErr = Object.assign(new Error(err.message), { usage: true });
    if (parsed.ci) failPlain(usageErr);
    renderUsageError(usageErr, ENTRY);
    return;
  }
  recorder.setRequest({ platforms: parsed.platforms, provider: parsed.provider, ci: parsed.ci, expiresInDays: parsed.expiresInDays });

  /* CI argument validation up front: before any lock, git call or build
   * tool runs. (resolvePlatforms / resolveEnvName enforce the same.) */
  if (parsed.ci && !parsed.check && !parsed.envName) {
    const err = new StepError('Missing environment flag.', { usage: true, details: 'Pass --uat or --prod with --ci.' });
    recorder.fail(err, { phase: 'args' });
    failPlain(err);
  }

  let profile;
  try {
    profile = detectProject(process.cwd());
  } catch (err) {
    recorder.fail(err, { phase: 'detect' });
    if (parsed.ci || parsed.check) failPlain(err);
    renderStepError(err, {}, {});
    return;
  }
  if (recorder.enabled) {
    /* Read before APPConfig.js is patched, so "dirty" reflects the caller's tree. */
    recorder.setProject({ name: profile.appName, root: profile.root, ...readGitInfo(profile.root) });
  }

  if (parsed.check) {
    await check(profile, parsed.platforms);
    return;
  }

  /* Platform question comes first; the environment question follows inside
   * run() (or comes from --uat/--prod). */
  let platforms;
  try {
    if (!parsed.ci) p.intro(`${profile.appName}  ·  Build & Distribution`);
    platforms = await resolvePlatforms(profile, parsed.platforms, parsed.ci);
  } catch (err) {
    recorder.fail(err, { phase: 'args' });
    if (parsed.ci) failPlain(err);
    renderUsageError(err, ENTRY);
    return;
  }

  /* One adapter per selected platform (creation validates availability). */
  const adapters = [];
  let creating = null;
  try {
    for (const key of platforms) {
      creating = key;
      adapters.push(PLATFORMS[key].create(profile));
    }
  } catch (err) {
    recorder.fail(err, { phase: 'platform', platform: creating });
    if (parsed.ci) failPlain(err);
    renderStepError(err, {}, PLATFORMS[creating]);
    return;
  }

  await run(adapters, {
    envName: parsed.envName,
    verbose: parsed.verbose,
    ci: parsed.ci,
    introShown: !parsed.ci,
    provider: parsed.provider,
    expiresInDays: parsed.expiresInDays,
    recorder,
  });
}

main();
