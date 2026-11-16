/**
 * Throwaway React Native-shaped projects for spawn-level CLI tests.
 *
 * Nothing here builds or signs anything real: `gradlew`, `xcodebuild`,
 * `apksigner` and `pbcopy` are small shell stand-ins. Uploads are stubbed by
 * test/helpers/ship-harness.js, so no test reaches ShareIPA or BetaDrop.
 */

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const HARNESS = path.join(__dirname, 'ship-harness.js');

function writeExecutable(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode: 0o755 });
}

/** A ZIP whose first bytes are the PK\x03\x04 magic (APK/IPA shaped). */
function makeZip(file) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-test-zip-'));
  fs.writeFileSync(path.join(dir, 'AndroidManifest.xml'), 'fixture');
  const res = spawnSync('zip', ['-q', file, 'AndroidManifest.xml'], { cwd: dir });
  fs.rmSync(dir, { recursive: true, force: true });
  if (res.status !== 0) throw new Error(`zip failed: ${res.stderr}`);
  return file;
}

const APPCONFIG = (isUAT) => `// fixture\nconst isUAT = ${isUAT};\nexport default { isUAT };\n`;

/**
 * Create a sandbox: { base, tmp, project, bin, env, appConfig, lockDir, … }.
 * `env` is the environment for spawned CLI runs (TMPDIR isolated so locks and
 * IPA staging dirs land inside the sandbox).
 */
function makeSandbox({ android = true, ios = false, isUAT = true, git = false } = {}) {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ship-test-')));
  const tmp = path.join(base, 'tmp');
  const project = path.join(base, 'project');
  const bin = path.join(base, 'bin');
  const products = path.join(base, 'DerivedData', 'Release-iphoneos');
  fs.mkdirSync(tmp);
  fs.mkdirSync(project);
  fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name: 'demo-app' }));
  fs.mkdirSync(path.join(project, 'src', 'Helper'), { recursive: true });
  const appConfig = path.join(project, 'src', 'Helper', 'APPConfig.js');
  fs.writeFileSync(appConfig, APPCONFIG(isUAT));

  const fixtureApk = makeZip(path.join(base, 'fixture.apk'));

  if (android) {
    const appDir = path.join(project, 'android', 'app');
    fs.mkdirSync(path.join(appDir, 'src', 'main', 'res', 'values'), { recursive: true });
    fs.writeFileSync(path.join(appDir, 'build.gradle'), 'android {\n  defaultConfig {\n    versionCode 7\n    versionName "1.2.3"\n  }\n}\n');
    fs.writeFileSync(path.join(appDir, 'src', 'main', 'res', 'values', 'strings.xml'), '<resources><string name="app_name">Demo App</string></resources>');
    writeExecutable(
      path.join(project, 'android', 'gradlew'),
      [
        '#!/bin/sh',
        '# like the real tools, exit when asked to stop',
        "trap 'exit 130' INT TERM",
        'echo "fake gradle: $*"',
        '# an OOM-killer style death: no cancel was requested',
        'if [ "$SHIP_TEST_GRADLE_KILL" = "1" ]; then kill -9 $$; fi',
        '# a descendant that ignores INT and TERM (orphaned when gradlew exits)',
        'if [ -n "$SHIP_TEST_GRANDCHILD" ]; then',
        '  sh -c \'trap "" INT TERM; exec sleep 31.7\' &',
        '  echo $! > "$SHIP_TEST_GRANDCHILD"',
        'fi',
        'if [ -n "$SHIP_TEST_GATE" ]; then',
        '  touch "$SHIP_TEST_GATE.waiting"',
        '  while [ ! -f "$SHIP_TEST_GATE" ]; do sleep 0.05; done',
        'fi',
        'if [ "$SHIP_TEST_GRADLE_FAIL" = "1" ]; then exit 1; fi',
        'mkdir -p app/build/outputs/apk/release',
        `cp "${fixtureApk}" app/build/outputs/apk/release/app-release.apk`,
        '',
      ].join('\n'),
    );
  }

  if (ios) {
    const iosDir = path.join(project, 'ios');
    fs.mkdirSync(path.join(iosDir, 'Demo.xcworkspace'), { recursive: true });
    fs.mkdirSync(path.join(iosDir, 'Demo.xcodeproj', 'xcshareddata', 'xcschemes'), { recursive: true });
    fs.writeFileSync(path.join(iosDir, 'Demo.xcodeproj', 'xcshareddata', 'xcschemes', 'release-demo.xcscheme'), '<Scheme/>');
    const settings = JSON.stringify([
      { buildSettings: { BUILT_PRODUCTS_DIR: products, FULL_PRODUCT_NAME: 'Demo.app', MARKETING_VERSION: '2.0', CURRENT_PROJECT_VERSION: '5' } },
    ]);
    writeExecutable(
      path.join(bin, 'xcodebuild'),
      [
        '#!/bin/sh',
        'case "$*" in',
        `  *-showBuildSettings*) echo '${settings}' ;;`,
        `  *) mkdir -p "${products}/Demo.app" && echo fixture > "${products}/Demo.app/Info.plist" && echo "fake xcodebuild: build" ;;`,
        'esac',
        '',
      ].join('\n'),
    );
  }

  /* apksigner stand-in; behaviour picked per run with SHIP_TEST_APKSIGNER. */
  const apksigner = path.join(bin, 'apksigner-fake');
  writeExecutable(
    apksigner,
    [
      '#!/bin/sh',
      'case "$SHIP_TEST_APKSIGNER" in',
      '  unsigned) echo "DOES NOT VERIFY"; echo "ERROR: Missing META-INF/MANIFEST.MF"; exit 1 ;;',
      '  invalid) echo "DOES NOT VERIFY"; echo "ERROR: APK Signature Scheme v2 signer #1: Bad signature"; exit 1 ;;',
      '  nojava) echo "The operation couldn\'t be completed. Unable to locate a Java Runtime." >&2; exit 1 ;;',
      '  *) echo "Verifies"; echo "Verified using v1 scheme (JAR signing): false"; echo "Verified using v2 scheme (APK Signature Scheme v2): true"; echo "Number of signers: 1" ;;',
      'esac',
      '',
    ].join('\n'),
  );

  /* pbcopy stand-in: leaves a marker if anything ever calls it. */
  const pbcopyMarker = path.join(base, 'pbcopy-called');
  writeExecutable(path.join(bin, 'pbcopy'), `#!/bin/sh\ncat > /dev/null\ntouch "${pbcopyMarker}"\n`);

  if (git) {
    const g = (...args) => spawnSync('git', ['-c', 'user.name=ship-test', '-c', 'user.email=ship-test@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: project, encoding: 'utf8' });
    g('init', '-q');
    g('add', '-A');
    g('commit', '-q', '-m', 'fixture');
  }

  const env = {
    PATH: `${bin}${path.delimiter}${process.env.PATH}`,
    HOME: base,
    TMPDIR: tmp,
    SHIP_APKSIGNER: apksigner,
    NO_COLOR: '1',
  };

  return {
    base,
    tmp,
    project,
    bin,
    products,
    appConfig,
    pbcopyMarker,
    lockDir: path.join(tmp, 'rn-build-upload-locks'),
    resultPath: path.join(base, 'result.json'),
    callsFile: path.join(base, 'upload-calls.jsonl'),
    env,
    readAppConfig: () => fs.readFileSync(appConfig, 'utf8'),
    originalAppConfig: APPCONFIG(isUAT),
    uploadCalls() {
      try {
        return fs.readFileSync(this.callsFile, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
      } catch (err) {
        return [];
      }
    },
    readResult() {
      return JSON.parse(fs.readFileSync(this.resultPath, 'utf8'));
    },
    leftoverTemp() {
      return fs.readdirSync(tmp).filter((n) => n.startsWith('rn-build-upload-') && n !== 'rn-build-upload-locks');
    },
    locks() {
      try {
        return fs.readdirSync(this.lockDir);
      } catch (err) {
        return [];
      }
    },
    cleanup() {
      fs.rmSync(base, { recursive: true, force: true });
    },
  };
}

/**
 * Spawn the real CLI (through the harness) inside the sandbox project.
 * Returns { child, done } where done resolves { code, signal, stdout, stderr }.
 */
function spawnShip(sandbox, args, { env = {}, upload = 'success' } = {}) {
  const child = spawn(process.execPath, [HARNESS, ...args], {
    cwd: sandbox.project,
    env: { ...sandbox.env, SHIP_TEST_UPLOAD: upload, SHIP_TEST_UPLOAD_CALLS: sandbox.callsFile, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  const waiters = [];
  const check = () => {
    for (const w of [...waiters]) {
      if (w.re.test(stdout)) {
        waiters.splice(waiters.indexOf(w), 1);
        w.resolve();
      }
    }
  };
  child.stdout.on('data', (d) => {
    stdout += d.toString();
    check();
  });
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });
  const done = new Promise((resolve) => {
    child.on('close', (code, signal) => {
      for (const w of waiters) w.reject(new Error(`process exited before ${w.re}:\n${stdout}\n${stderr}`));
      resolve({ code, signal, stdout, stderr });
    });
  });
  /** Resolve once stdout matches `re` (rejects if the process exits first). */
  const waitFor = (re) =>
    new Promise((resolve, reject) => {
      waiters.push({ re, resolve, reject });
      check();
    });
  return { child, done, waitFor };
}

/** Resolve once `file` exists (the fake gradlew touches <gate>.waiting). */
async function waitForFile(file, { timeoutMs = 15_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (!fs.existsSync(file)) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${file}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

module.exports = { makeSandbox, spawnShip, makeZip, writeExecutable, waitForFile, HARNESS };
