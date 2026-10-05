#!/usr/bin/env node
/**
 * ship — build a React Native release APK/IPA and upload it to BetaDrop.
 * (Installed as `ship`, with `rn-build-upload` as an alias.)
 *
 * Usage:
 *   ship [--platform android|ios] [--uat | --prod] [--provider betadrop|shareipa] [--verbose] [--ci] [--check]
 *
 *     no flags   Ask which platform (Android / iOS) first, then which environment
 *     --platform android|ios  Skip the platform prompt
 *     --uat      Stag backend (isUAT=true)
 *     --prod     Prod backend (isUAT=false)
 *     --provider betadrop|shareipa  Upload provider (default: betadrop)
 *     --verbose  Stream the full build output (default shows a compact live view)
 *     --ci       Plain non-interactive output for scripts/CI (requires --platform)
 *     --check    Print the detected project profile and exit (no build, no upload)
 *
 * Flow: detect the project -> set isUAT in src/Helper/APPConfig.js (restored
 * after the build, even on Ctrl+C) -> build (Gradle release APK or Xcode
 * release IPA via the release-* scheme) -> upload (BetaDrop by default;
 * ShareIPA with --provider shareipa; both with live upload progress) ->
 * Markdown -> pbcopy.
 *
 * Per-project convenience scripts, e.g.:
 *   "ship": "rn-build-upload",
 *   "androidBuild": "rn-build-upload --platform android"
 *
 * One-time setup per machine:
 *   npm i -g github:Prince-BITNET/rn-build-upload
 *   npx -y @betadrop/cli login     (or export BETADROP_TOKEN=bd_live_xxxx)
 */

const { detectProject } = require('../lib/detect');
const {
  EXIT_FAILED,
  EXIT_USAGE,
  p,
  parseArgs,
  plain,
  renderStepError,
  renderUsageError,
  resolvePlatform,
  run,
  usageText,
} = require('../lib/build-upload');
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
  process.exit(err.usage ? EXIT_USAGE : EXIT_FAILED);
}

/** Print the detected profile (and version, when readable) — no side effects. */
async function check(profile, requestedPlatform) {
  console.log(`Project : ${profile.root}`);
  console.log(`App     : ${profile.appName}`);
  console.log(`Env     : ${profile.envFile}`);
  const platforms = requestedPlatform ? [requestedPlatform] : ['android', 'ios'];
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
  let parsed;
  try {
    parsed = parseArgs(process.argv.slice(2), { allowPlatform: true });
  } catch (err) {
    renderUsageError(err, ENTRY);
    return;
  }
  if (parsed.help) {
    console.log(usageText(ENTRY));
    process.exit(0);
  }

  let profile;
  try {
    profile = detectProject(process.cwd());
  } catch (err) {
    if (parsed.ci || parsed.check) failPlain(err);
    renderStepError(err, {}, {});
    return;
  }

  if (parsed.check) {
    await check(profile, parsed.platform);
    return;
  }

  /* Platform question comes first; the environment question follows inside
   * run() (or comes from --uat/--prod). */
  let platform;
  try {
    if (!parsed.ci) p.intro(`${profile.appName}  ·  Build & Distribution`);
    platform = await resolvePlatform(parsed.platform, parsed.ci);
  } catch (err) {
    if (parsed.ci) failPlain(err);
    renderUsageError(err, ENTRY);
    return;
  }

  let adapter;
  try {
    adapter = PLATFORMS[platform].create(profile);
  } catch (err) {
    if (parsed.ci) failPlain(err);
    renderStepError(err, {}, PLATFORMS[platform]);
    return;
  }

  await run(adapter, {
    envName: parsed.envName,
    verbose: parsed.verbose,
    ci: parsed.ci,
    introShown: !parsed.ci,
    provider: parsed.provider,
  });
}

main();
