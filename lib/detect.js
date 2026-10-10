/**
 * Project detection — no config file.
 *
 * Everything is inferred from the React Native project layout and the
 * conventions used by our apps:
 *
 *   - project root: nearest ancestor of the CWD with package.json next to
 *                   android/ or ios/
 *   - app label:    native display name with whitespace stripped
 *                   ("Alfa PTE" -> "AlfaPTE", "PTE Now" -> "PTENow"),
 *                   then app.json displayName, then package.json name
 *   - iOS:          ios/*.xcworkspace + the shared scheme matching
 *                   /^release[-_]/i (e.g. release-alfapte, Release-PTENow)
 *   - Android:      android/app/build.gradle; gradle.properties
 *                   newArchEnabled=true adds :app:generatePackageList and
 *                   generateCodegenArtifactsFromSchema before assembleRelease
 *   - backend:      src/Helper/APPConfig.js with `const isUAT = true|false`
 */

const fs = require('node:fs');
const path = require('node:path');
const { StepError } = require('./build-upload');

function readFileSafe(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (err) {
    return null;
  }
}

function readdirSafe(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (err) {
    return [];
  }
}

/** Nearest ancestor of startDir with package.json next to android/ or ios/. */
function findProjectRoot(startDir) {
  let dir = path.resolve(startDir);
  for (;;) {
    const hasPackage = fs.existsSync(path.join(dir, 'package.json'));
    const hasNative =
      fs.existsSync(path.join(dir, 'android')) || fs.existsSync(path.join(dir, 'ios'));
    if (hasPackage && hasNative) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

const stripSpace = (name) => (name || '').replace(/\s+/g, '');

/**
 * Name used in the share message (clipboard / --ci link line).
 *
 * Hyphenates spaces and camelCase word boundaries, so the human display name
 * maps to a readable link label on every machine regardless of which source
 * (iOS plist, Android strings.xml, app.json) provided it:
 *   "Alfa PTE" / "AlfaPTE" -> "Alfa-PTE"
 *   "PTE Now"  / "PTENow"  -> "PTE-Now"
 *   "MyApp"                -> "My-App"
 */
function hyphenateName(name) {
  return String(name || '')
    .trim()
    .replace(/\s+/g, '-')
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2') /* Alfa|PTE */
    .replace(/([A-Z])([A-Z][a-z])/g, '$1-$2') /* PTE|Now */
    .replace(/-{2,}/g, '-');
}

function plistDisplayName(file) {
  const text = readFileSafe(file);
  if (!text) return null;
  const m = text.match(/<key>CFBundleDisplayName<\/key>\s*<string>([^<]+)<\/string>/);
  return m ? m[1].trim() : null;
}

/** iOS app display name: the app folder's Info.plist (extension plists skipped). */
function readIosDisplayName(ios) {
  if (!ios || !ios.workspaceBase) return null;
  const candidates = [path.join(ios.dir, ios.workspaceBase, 'Info.plist')];
  for (const entry of readdirSafe(ios.dir)) {
    if (entry === ios.workspaceBase || /extension/i.test(entry) || entry === 'Pods') continue;
    candidates.push(path.join(ios.dir, entry, 'Info.plist'));
  }
  for (const file of candidates) {
    const name = plistDisplayName(file);
    if (name) return name;
  }
  return null;
}

function readAndroidAppName(android) {
  if (!android) return null;
  const text = readFileSafe(path.join(android.dir, 'app', 'src', 'main', 'res', 'values', 'strings.xml'));
  if (!text) return null;
  const m = text.match(/<string\s+name="app_name"[^>]*>([^<]+)<\/string>/);
  return m ? m[1].trim() : null;
}

function readAppJsonName(root) {
  const text = readFileSafe(path.join(root, 'app.json'));
  if (!text) return null;
  try {
    const json = JSON.parse(text);
    return json.displayName || json.name || null;
  } catch (err) {
    return null;
  }
}

function readPackageName(root) {
  const text = readFileSafe(path.join(root, 'package.json'));
  if (!text) return null;
  try {
    return JSON.parse(text).name || null;
  } catch (err) {
    return null;
  }
}

function detectIos(root) {
  const dir = path.join(root, 'ios');
  if (!fs.existsSync(dir)) return null;
  const entries = readdirSafe(dir);
  const workspace = entries.find((e) => e.endsWith('.xcworkspace')) || null;
  const workspaceBase = workspace ? workspace.replace(/\.xcworkspace$/, '') : null;

  const schemes = [];
  for (const entry of entries) {
    if (!entry.endsWith('.xcodeproj')) continue;
    const schemeDir = path.join(dir, entry, 'xcshareddata', 'xcschemes');
    for (const file of readdirSafe(schemeDir)) {
      if (file.endsWith('.xcscheme')) schemes.push(file.replace(/\.xcscheme$/, ''));
    }
  }
  const releaseSchemes = schemes.filter((s) => /^release[-_]/i.test(s));
  let scheme = null;
  if (releaseSchemes.length === 1) {
    scheme = releaseSchemes[0];
  } else if (releaseSchemes.length > 1) {
    scheme =
      releaseSchemes.find((s) => workspaceBase && s.toLowerCase().endsWith(workspaceBase.toLowerCase())) ||
      null;
  }
  return {
    dir,
    workspace,
    workspaceBase,
    scheme,
    schemes,
    configuration: 'Release',
    destination: 'generic/platform=iOS',
  };
}

function detectAndroid(root) {
  const dir = path.join(root, 'android');
  const gradleFile = path.join(dir, 'app', 'build.gradle');
  if (!fs.existsSync(gradleFile)) return null;
  const properties = readFileSafe(path.join(dir, 'gradle.properties')) || '';
  const newArch = /newArchEnabled\s*=\s*true/.test(properties);
  const gradleTasks = newArch
    ? [':app:generatePackageList', 'generateCodegenArtifactsFromSchema', 'assembleRelease']
    : ['assembleRelease'];
  return {
    dir,
    gradleFile,
    gradleTasks,
    releaseDir: path.join(dir, 'app', 'build', 'outputs', 'apk', 'release'),
    expectedApkName: 'app-release.apk',
  };
}

function detectProject(startDir) {
  const root = findProjectRoot(startDir);
  if (!root) {
    throw new StepError('Not inside a React Native project.', {
      details: `Walked up from ${path.resolve(startDir)} looking for a package.json next to android/ or ios/.`,
      hint: 'Run rn-build-upload from a project directory.',
    });
  }
  const ios = detectIos(root);
  const android = detectAndroid(root);
  if (!ios && !android) {
    throw new StepError('No android/ or ios/ project found.', {
      details: `Looked under ${root} for android/app/build.gradle and ios/*.xcworkspace.`,
    });
  }
  const candidates = [readIosDisplayName(ios), readAndroidAppName(android), readAppJsonName(root), readPackageName(root)];
  let appName = null;
  for (const candidate of candidates) {
    appName = stripSpace(candidate);
    if (appName) break;
  }
  appName = appName || path.basename(root);
  return {
    root,
    appName,
    /* Human-readable label for the share message ("AlfaPTE" -> "Alfa-PTE"). */
    shareName: hyphenateName(appName),
    ios,
    android,
    envFile: path.join(root, 'src', 'Helper', 'APPConfig.js'),
  };
}

module.exports = { detectProject, findProjectRoot, hyphenateName };
