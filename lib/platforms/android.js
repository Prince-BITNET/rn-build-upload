/**
 * Android platform adapter for the shared build & upload core
 * (lib/build-upload.js): Gradle release APK -> BetaDrop.
 */

const fs = require('node:fs');
const path = require('node:path');
const { StepError, runCommand, throwIfCancelled, assertZipMagic, formatMB } = require('../build-upload');

function createAndroidAdapter(profile) {
  const android = profile.android;
  if (!android) {
    throw new StepError('No Android project found.', {
      details: `Expected android/app/build.gradle under ${profile.root}.`,
    });
  }
  const { dir: androidDir, gradleFile, gradleTasks, releaseDir, expectedApkName } = android;

  function readVersionInfo() {
    try {
      const content = fs.readFileSync(gradleFile, 'utf8');
      const versionCode = (content.match(/versionCode\s+(\d+)/) || [])[1] || 'unknown';
      const versionName = (content.match(/versionName\s+["']([^"']+)["']/) || [])[1] || 'unknown';
      return { versionCode, versionName };
    } catch (err) {
      return { versionCode: 'unknown', versionName: 'unknown' };
    }
  }

  async function build({ verbose, onOutput }) {
    const res = await runCommand('./gradlew', gradleTasks, { cwd: androidDir, streamOutput: verbose, onOutput });
    throwIfCancelled();
    if (res.spawnError) {
      const err = res.spawnError;
      throw new StepError('Could not start the Gradle build.', {
        details: err.code === 'ENOENT' ? `./gradlew not found in ${androidDir}.` : err.message,
      });
    }
    if (res.signal) {
      const err = new StepError('Operation cancelled.');
      err.cancelled = true;
      throw err;
    }
    if (res.code !== 0) {
      throw new StepError('Android build failed.', {
        details: `Gradle exited with code ${res.code}.`,
        buildFailed: true,
        verbose,
      });
    }
  }

  /** Deterministic release-APK selection. Never silently picks from ambiguity. */
  function findReleaseApk() {
    if (!fs.existsSync(releaseDir)) {
      throw new StepError('Release APK not found.', {
        details: `Expected a release APK in:\n${releaseDir}\nThe Gradle build did not produce it; not attempting an upload.`,
      });
    }
    const apkFiles = fs
      .readdirSync(releaseDir)
      .filter((f) => f.endsWith('.apk'))
      .map((name) => {
        const fullPath = path.join(releaseDir, name);
        const stat = fs.statSync(fullPath);
        return { name, fullPath, size: stat.size, mtimeMs: stat.mtimeMs };
      })
      .filter((f) => f.size > 0);

    if (apkFiles.length === 0) {
      throw new StepError('Release APK not found.', {
        details: `Expected a release APK in:\n${releaseDir}\nSearched ${releaseDir}/*.apk — nothing to upload.`,
      });
    }

    const expected = apkFiles.find((f) => f.name === expectedApkName);
    if (expected) {
      return { apk: expected, fallback: false };
    }
    if (apkFiles.length === 1) {
      return { apk: apkFiles[0], fallback: true };
    }
    const list = apkFiles
      .sort((a, b) => b.mtimeMs - a.mtimeMs)
      .map((f) => `- ${f.name} (${formatMB(f.size)})`)
      .join('\n');
    throw new StepError('Release APK not found.', {
      details:
        `Multiple APKs in ${releaseDir} and no ${expectedApkName} to choose deterministically. ` +
        `Clean the directory or restore the standard build output, then retry.\n${list}`,
    });
  }

  async function produceArtifact() {
    const { apk, fallback } = findReleaseApk();
    assertZipMagic(apk.fullPath, 'APK');
    return { file: apk, fallback };
  }

  return {
    key: 'android',
    label: 'Android',
    appName: profile.appName,
    shareName: profile.shareName,
    profile,
    artifactWord: 'APK',
    expectedName: expectedApkName,
    entry: {
      command: 'ship --platform android',
      label: 'Android',
      appName: profile.appName,
      shareName: profile.shareName,
      allowPlatform: false,
      verboseHint: 'Stream full Gradle output (default shows a compact live view)',
    },
    verboseBuildStart: 'Building Android release (full Gradle output below)',
    buildLogTitle: 'Building Android release APK',
    buildFailedTitle: 'Android build failed',
    readVersionInfo,
    build,
    produceArtifact,
  };
}

module.exports = { createAndroidAdapter };
