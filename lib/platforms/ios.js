/**
 * iOS platform adapter for the shared build & upload core
 * (lib/build-upload.js): Xcode release build -> Payload/ zip -> .ipa
 * -> BetaDrop.
 *
 * Mirrors the manual flow: Xcode -> Any iOS Device (arm64) -> release-* scheme
 * -> Build -> <app>.app from DerivedData -> copy into a Payload folder -> zip
 * -> rename to <app>.ipa.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StepError, runCommand, throwIfCancelled, assertZipMagic } = require('../build-upload');

const IPA_NAME = 'app.ipa';

/* Resolved once per run by xcodebuild -showBuildSettings: authoritative for
 * the version string and for where the build writes the .app (the same
 * DerivedData Xcode uses, so caches are shared with manual builds). */
let cachedSettings = null;

function tail(text, limit = 1500) {
  const t = (text || '').trim();
  return t.length > limit ? `…${t.slice(-limit)}` : t;
}

function createIosAdapter(profile) {
  const ios = profile.ios;
  if (!ios) {
    throw new StepError('No iOS project found.', {
      details: `Expected an ios/ folder under ${profile.root}.`,
    });
  }
  if (!ios.workspace) {
    throw new StepError('iOS workspace not found.', {
      details: `Expected ios/*.xcworkspace under ${ios.dir}.`,
      hint: 'Install the CocoaPods dependencies first (e.g. `npm run pod`).',
    });
  }
  if (!ios.scheme) {
    const available = ios.schemes.length > 0 ? ios.schemes.join(', ') : 'none';
    throw new StepError('No release scheme found.', {
      details: `Expected a shared scheme matching release-* (e.g. release-alfapte) in ${ios.dir}/*.xcodeproj.\nAvailable schemes: ${available}`,
    });
  }
  const { dir: iosDir, workspace, scheme, configuration, destination } = ios;

  cachedSettings = null;

  async function loadBuildSettings() {
    if (cachedSettings) return cachedSettings;
    const res = await runCommand(
      'xcodebuild',
      [
        '-workspace',
        workspace,
        '-scheme',
        scheme,
        '-configuration',
        configuration,
        '-destination',
        destination,
        '-showBuildSettings',
        '-json',
      ],
      { cwd: iosDir },
    );
    throwIfCancelled();
    if (res.spawnError) {
      throw new StepError('Could not start the Xcode build.', {
        details:
          res.spawnError.code === 'ENOENT'
            ? 'Could not run `xcodebuild`. Install Xcode, then run: sudo xcode-select -s /Applications/Xcode.app'
            : res.spawnError.message,
      });
    }
    if (res.signal) {
      const err = new StepError('Operation cancelled.');
      err.cancelled = true;
      throw err;
    }
    if (res.code !== 0) {
      const output = `${res.stdout || ''}\n${res.stderr || ''}`;
      const podsMissing = /Pods-|pod install|No such file or directory|does not exist/i.test(output);
      throw new StepError('Could not read the iOS project settings.', {
        details: tail(res.stderr) || tail(res.stdout) || `xcodebuild -showBuildSettings exited with code ${res.code}.`,
        hint: podsMissing ? 'The CocoaPods workspace looks incomplete — run `npm run pod` first.' : '',
      });
    }
    let json;
    try {
      const start = (res.stdout || '').search(/[[{]/);
      json = JSON.parse((res.stdout || '').slice(start));
    } catch (err) {
      throw new StepError('Could not parse the iOS project settings.', {
        details: tail(res.stdout, 300),
      });
    }
    const settings = Array.isArray(json) ? json[0] && json[0].buildSettings : json.buildSettings;
    if (!settings) {
      throw new StepError('Could not read the iOS project settings.', {
        details: 'xcodebuild -showBuildSettings returned no build settings.',
      });
    }
    cachedSettings = {
      productsDir: settings.BUILT_PRODUCTS_DIR,
      productName: settings.FULL_PRODUCT_NAME || `${workspace.replace(/\.xcworkspace$/, '')}.app`,
      versionName: settings.MARKETING_VERSION || 'unknown',
      versionCode: settings.CURRENT_PROJECT_VERSION || 'unknown',
    };
    return cachedSettings;
  }

  async function readVersionInfo() {
    const settings = await loadBuildSettings();
    return { versionName: settings.versionName, versionCode: settings.versionCode };
  }

  /** The error lines worth keeping from an xcodebuild log (full logs are huge). */
  function errorExcerpt(output) {
    const hits = (output || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(
        (l) =>
          l &&
          /error:|fatal error:|\*\* BUILD FAILED|The following build commands failed|CodeSign|provisioning|requires a development team/i.test(l),
      );
    return hits.slice(-12).join('\n');
  }

  async function build({ verbose, onOutput }) {
    const res = await runCommand(
      'xcodebuild',
      ['-workspace', workspace, '-scheme', scheme, '-configuration', configuration, '-destination', destination, 'build'],
      { cwd: iosDir, streamOutput: verbose, onOutput },
    );
    throwIfCancelled();
    if (res.spawnError) {
      throw new StepError('Could not start the Xcode build.', {
        details:
          res.spawnError.code === 'ENOENT'
            ? 'Could not run `xcodebuild`. Install Xcode, then run: sudo xcode-select -s /Applications/Xcode.app'
            : res.spawnError.message,
      });
    }
    if (res.signal) {
      const err = new StepError('Operation cancelled.');
      err.cancelled = true;
      throw err;
    }
    if (res.code !== 0) {
      const output = `${res.stdout || ''}\n${res.stderr || ''}`;
      const signing = /CodeSign|provisioning profile|Signing for|requires a development team|No profiles for/i.test(output);
      const excerpt = verbose ? '' : errorExcerpt(output);
      throw new StepError('iOS build failed.', {
        details: `xcodebuild exited with code ${res.code}.${excerpt ? `\n\n${excerpt}` : ''}`,
        buildFailed: true,
        verbose,
        hint: signing
          ? `This looks like a signing/provisioning error. Open ${path.join(iosDir, workspace)} in Xcode, fix the signing of the "${scheme}" scheme target, then retry.`
          : '',
      });
    }
  }

  /** Wrap the built .app into Payload/ and zip it, producing the .ipa. */
  async function packageIpa(appPath, tmpDir) {
    const appName = path.basename(appPath);
    const ipaName = `${appName.replace(/\.app$/, '')}.ipa`;
    const payloadDir = path.join(tmpDir, 'Payload');
    fs.mkdirSync(payloadDir);
    fs.cpSync(appPath, path.join(payloadDir, appName), { recursive: true, verbatimSymlinks: true });
    const res = await runCommand('zip', ['-qry', ipaName, 'Payload'], { cwd: tmpDir });
    throwIfCancelled();
    if (res.spawnError) {
      throw new StepError('Could not package the IPA.', { details: res.spawnError.message });
    }
    if (res.code !== 0) {
      throw new StepError('Could not package the IPA.', {
        details: (res.stderr || '').trim() || `zip exited with code ${res.code}.`,
      });
    }
    const ipaPath = path.join(tmpDir, ipaName);
    const stat = fs.statSync(ipaPath);
    if (stat.size === 0) {
      throw new StepError('Packaged IPA is empty.', { details: `zip produced an empty file: ${ipaPath}` });
    }
    assertZipMagic(ipaPath, 'IPA');
    return { ipaPath, ipaName, stat };
  }

  async function produceArtifact() {
    const settings = await loadBuildSettings();
    const appBundle = settings.productName;
    const appPath = path.join(settings.productsDir, appBundle);
    if (!fs.existsSync(appPath)) {
      throw new StepError('Release app bundle not found.', {
        details: `Expected the built app at:\n${appPath}\nThe Xcode build did not produce it; not attempting an upload.`,
      });
    }
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-build-upload-ipa-'));
    try {
      const { ipaPath, ipaName, stat } = await packageIpa(appPath, tmpDir);
      return {
        file: { name: ipaName, fullPath: ipaPath, size: stat.size },
        fallback: false,
        cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
      };
    } catch (err) {
      try {
        fs.rmSync(tmpDir, { recursive: true, force: true });
      } catch (cleanupErr) {
        /* best-effort */
      }
      throw err;
    }
  }

  return {
    key: 'ios',
    label: 'iOS',
    appName: profile.appName,
    profile,
    artifactWord: 'IPA',
    expectedName: IPA_NAME,
    entry: {
      command: 'ship --platform ios',
      label: 'iOS',
      appName: profile.appName,
      allowPlatform: false,
      verboseHint: 'Stream full xcodebuild output (default shows a compact live view)',
    },
    settingsMessage: 'Reading Xcode build settings',
    settingsDone: 'Xcode build settings loaded',
    verboseBuildStart: 'Building iOS release (full xcodebuild output below)',
    buildLogTitle: 'Building iOS release IPA',
    buildFailedTitle: 'iOS build failed',
    readVersionInfo,
    build,
    produceArtifact,
  };
}

module.exports = { createIosAdapter };
