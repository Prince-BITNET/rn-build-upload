/**
 * Android platform adapter for the shared build & upload core
 * (lib/build-upload.js): Gradle release APK -> signature check -> upload.
 *
 * The APK is only handed to the uploader after `apksigner verify` accepted
 * its signature (lib/apk-signature.js); every other outcome fails the run.
 */

const fs = require('node:fs');
const path = require('node:path');
const { StepError, runCommand, throwIfCancelled, isCancelRequested, exitText, assertZipMagic, formatMB } = require('../build-upload');
const { verifyApkSignature } = require('../apk-signature');
const { makeTempDir, removeTempPath } = require('../lifecycle');

function createAndroidAdapter(profile, { verifySignature = verifyApkSignature } = {}) {
  const android = profile.android;
  if (!android) {
    throw new StepError('No Android project found.', {
      details: `Expected android/app/build.gradle under ${profile.root}.`,
    });
  }
  const { dir: androidDir, gradleFile, gradleTasks, releaseDir, expectedApkName } = android;

  /**
   * The densest launcher bitmap named by the manifest's android:icon — what
   * AppShare's web page shows for an APK. null when there is none (e.g. a
   * vector-only icon); the upload then goes without one.
   */
  function findLauncherIcon() {
    try {
      const manifest = fs.readFileSync(path.join(androidDir, 'app', 'src', 'main', 'AndroidManifest.xml'), 'utf8');
      const m = /<application\b[^>]*?android:icon="@(mipmap|drawable)\/([\w.]+)"/.exec(manifest);
      if (!m) return null;
      const res = path.join(androidDir, 'app', 'src', 'main', 'res');
      for (const density of ['xxxhdpi', 'xxhdpi', 'xhdpi', 'hdpi', 'mdpi']) {
        for (const ext of ['.png', '.webp']) {
          const file = path.join(res, `${m[1]}-${density}`, `${m[2]}${ext}`);
          if (fs.existsSync(file)) return file;
        }
      }
    } catch (err) {
      /* no manifest: no icon */
    }
    return null;
  }

  function readVersionInfo() {
    try {
      const content = fs.readFileSync(gradleFile, 'utf8');
      const versionCode = (content.match(/versionCode\s+(\d+)/) || [])[1] || 'unknown';
      const versionName = (content.match(/versionName\s+["']([^"']+)["']/) || [])[1] || 'unknown';
      const bundleId = (content.match(/applicationId\s*=?\s*["']([^"']+)["']/) || [])[1] || null;
      return { versionCode, versionName, bundleId, iconPath: findLauncherIcon() };
    } catch (err) {
      return { versionCode: 'unknown', versionName: 'unknown', bundleId: null, iconPath: findLauncherIcon() };
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
    /* A signal without a cancel request (OOM killer, kill -9) is a build
     * failure; a requested cancel was already thrown above. */
    if (res.code !== 0) {
      throw new StepError('Android build failed.', {
        details: `Gradle ${exitText(res)}.`,
        buildFailed: true,
        verbose,
      });
    }
  }

  /** Deterministic release-APK selection. Never silently picks from ambiguity. */
  function findReleaseApk() {
    if (!fs.existsSync(releaseDir)) {
      throw new StepError('Release APK not found.', {
        code: 'ARTIFACT_NOT_FOUND',
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
        code: 'ARTIFACT_NOT_FOUND',
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
      code: 'ARTIFACT_NOT_FOUND',
      details:
        `Multiple APKs in ${releaseDir} and no ${expectedApkName} to choose deterministically. ` +
        `Clean the directory or restore the standard build output, then retry.\n${list}`,
    });
  }

  /**
   * Snapshot the APK into a private temp dir (0700, APFS clone when
   * possible) and verify, checksum and upload only that copy: the build
   * output can be replaced in the checkout at any time (IDE, another Gradle
   * run), so what was verified is exactly what gets hashed and uploaded.
   */
  async function produceArtifact() {
    const { apk, fallback } = findReleaseApk();
    const stageDir = makeTempDir('apk');
    try {
      const stagedPath = path.join(stageDir, apk.name);
      fs.copyFileSync(apk.fullPath, stagedPath, fs.constants.COPYFILE_FICLONE);
      const size = fs.statSync(stagedPath).size;
      assertZipMagic(stagedPath, 'APK');
      /* Fail closed: throws unless apksigner verified the signature. */
      const signature = await verifySignature(stagedPath, { run: runCommand, androidDir, isCancelled: isCancelRequested });
      throwIfCancelled();
      return {
        file: { name: apk.name, fullPath: stagedPath, size },
        fallback,
        signature,
        /* the build output itself stays in the checkout */
        source: apk.fullPath,
        sourceKept: true,
        cleanup: () => removeTempPath(stageDir),
      };
    } catch (err) {
      removeTempPath(stageDir);
      throw err;
    }
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
