/**
 * Release-APK signature verification with the Android SDK's `apksigner`.
 *
 * Fail closed: an APK is only uploadable when `apksigner verify` exits 0,
 * prints "Verifies" and reports at least one scheme as verified. Unsigned,
 * invalidly signed or malformed APKs are rejected, and so is every case in
 * which verification could not run (no apksigner, no Java, crash).
 *
 * This only proves the APK carries a valid signature. It does not check
 * *which* key signed it (no certificate is printed, compared or stored).
 *
 * apksigner lookup order:
 *   1. $SHIP_APKSIGNER (explicit path, e.g. pinned by a CI template)
 *   2. <sdk>/build-tools/<highest version>/apksigner, where <sdk> is the
 *      first of $ANDROID_HOME, $ANDROID_SDK_ROOT, android/local.properties
 *      sdk.dir, ~/Library/Android/sdk
 *   3. `apksigner` on PATH
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StepError } = require('./errors');

function compareVersions(a, b) {
  const pa = a.split(/[.-]/).map((n) => (/^\d+$/.test(n) ? Number(n) : -1));
  const pb = b.split(/[.-]/).map((n) => (/^\d+$/.test(n) ? Number(n) : -1));
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

function readSdkDirFromLocalProperties(androidDir) {
  if (!androidDir) return null;
  try {
    const text = fs.readFileSync(path.join(androidDir, 'local.properties'), 'utf8');
    const m = text.match(/^\s*sdk\.dir\s*=\s*(.+?)\s*$/m);
    /* local.properties escapes ':' and '\' (Java properties format). */
    return m ? m[1].replace(/\\(.)/g, '$1') : null;
  } catch (err) {
    return null;
  }
}

function isExecutable(file) {
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch (err) {
    return false;
  }
}

/**
 * Locate apksigner. Returns { command, source, buildTools } or null.
 * `env`/`homedir` are injectable for tests.
 */
function findApksigner({ androidDir = null, env = process.env, homedir = os.homedir() } = {}) {
  if (env.SHIP_APKSIGNER) {
    return { command: env.SHIP_APKSIGNER, source: 'SHIP_APKSIGNER', buildTools: null };
  }
  const sdkDirs = [env.ANDROID_HOME, env.ANDROID_SDK_ROOT, readSdkDirFromLocalProperties(androidDir), path.join(homedir, 'Library', 'Android', 'sdk')].filter(Boolean);
  for (const sdk of sdkDirs) {
    let versions;
    try {
      versions = fs.readdirSync(path.join(sdk, 'build-tools'));
    } catch (err) {
      continue;
    }
    const sorted = versions.sort(compareVersions).reverse();
    for (const version of sorted) {
      const candidate = path.join(sdk, 'build-tools', version, 'apksigner');
      if (isExecutable(candidate)) return { command: candidate, source: 'sdk', buildTools: version };
    }
  }
  for (const dir of String(env.PATH || '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'apksigner');
    if (isExecutable(candidate)) return { command: candidate, source: 'PATH', buildTools: null };
  }
  return null;
}

const SCHEME_RE = /^Verified using (v[\d.]+) scheme[^:]*:\s*(true|false)\s*$/gim;

/** Pure classification of `apksigner verify --verbose` output. */
function classifyVerifyOutput({ code, stdout = '', stderr = '' }) {
  const out = `${stdout}\n${stderr}`;
  const schemes = [];
  let m;
  SCHEME_RE.lastIndex = 0;
  while ((m = SCHEME_RE.exec(stdout)) !== null) {
    if (m[2].toLowerCase() === 'true') schemes.push(m[1]);
  }
  if (code === 0 && /^Verifies\s*$/m.test(stdout) && schemes.length > 0) {
    return { status: 'verified', schemes };
  }
  const errors = out
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^ERROR\b|Exception:|DOES NOT VERIFY/.test(l))
    .slice(0, 6);
  if (/DOES NOT VERIFY/.test(out)) {
    const unsigned = /Missing META-INF\/MANIFEST\.MF|No JAR signatures|no signatures|No signers|not signed/i.test(out);
    return { status: unsigned ? 'unsigned' : 'invalid', errors };
  }
  /* Any apksig library exception means the file's contents were rejected
   * (not a ZIP, malformed manifest, …) — as opposed to the tool not running. */
  if (/com\.android\.apksig\.[\w.$]*Exception|Malformed APK/i.test(out)) {
    return { status: 'invalid', errors };
  }
  if (code === 0) {
    /* Exit 0 but no recognisable "Verifies" + verified scheme: never trust it. */
    return { status: 'unavailable', errors: ['apksigner exited 0 without reporting a verified signature scheme.'] };
  }
  return { status: 'unavailable', errors };
}

/**
 * Verify `apkPath`. Resolves { verified: true, schemes, verifier } or throws
 * StepError with code APK_UNSIGNED | APK_SIGNATURE_INVALID |
 * APK_VERIFY_UNAVAILABLE (or a cancelled StepError).
 *
 * `run(cmd, args, opts)` must resolve like core runCommand():
 * { code, signal, stdout, stderr, spawnError? }.
 */
async function verifyApkSignature(apkPath, { run, androidDir = null, locate = findApksigner, env = process.env, isCancelled = () => false } = {}) {
  const name = path.basename(apkPath);
  const tool = locate({ androidDir, env });
  if (!tool) {
    throw new StepError('Cannot verify the APK signature; not uploading.', {
      code: 'APK_VERIFY_UNAVAILABLE',
      details: `apksigner was not found, so ${name} could not be checked. Unverified APKs are never uploaded.`,
      hint: 'Install Android SDK build-tools and set ANDROID_HOME (or point SHIP_APKSIGNER at apksigner), then retry.',
    });
  }
  const res = await run(tool.command, ['verify', '--verbose', apkPath], { cwd: path.dirname(apkPath) });
  /* Killed without a cancel request: falls through and fails closed below. */
  if (res.signal && isCancelled()) {
    const err = new StepError('Operation cancelled.');
    err.cancelled = true;
    throw err;
  }
  if (res.spawnError) {
    throw new StepError('Cannot verify the APK signature; not uploading.', {
      code: 'APK_VERIFY_UNAVAILABLE',
      details: `Could not run ${tool.command}: ${res.spawnError.code || res.spawnError.message}. Unverified APKs are never uploaded.`,
      hint: 'Check the Android SDK build-tools install (apksigner also needs a Java runtime), or set SHIP_APKSIGNER.',
    });
  }
  const verdict = classifyVerifyOutput(res);
  const errorLines = (verdict.errors || []).join('\n');
  if (verdict.status === 'verified') {
    return { verified: true, schemes: verdict.schemes, verifier: tool.buildTools ? `build-tools ${tool.buildTools}` : tool.source };
  }
  if (verdict.status === 'unsigned') {
    throw new StepError('Release APK is not signed; not uploading.', {
      code: 'APK_UNSIGNED',
      details: `apksigner found no valid signature in ${name}.${errorLines ? `\n${errorLines}` : ''}`,
      hint: 'Configure release signing for the app (signingConfigs.release) and rebuild. Unsigned APKs cannot be installed and are never uploaded.',
    });
  }
  if (verdict.status === 'invalid') {
    throw new StepError('Release APK signature is invalid; not uploading.', {
      code: 'APK_SIGNATURE_INVALID',
      details: `apksigner rejected ${name}.${errorLines ? `\n${errorLines}` : ''}`,
      hint: 'Rebuild the APK; if it was modified after signing, sign it again with the release key.',
    });
  }
  throw new StepError('Cannot verify the APK signature; not uploading.', {
    code: 'APK_VERIFY_UNAVAILABLE',
    details: `${tool.command} ${res.signal ? `was killed by ${res.signal}` : `exited with code ${res.code}`}.${errorLines ? `\n${errorLines}` : ''}\nUnverified APKs are never uploaded.`,
    hint: 'apksigner needs a working Java runtime (JDK 17). Check `apksigner --version`, or set SHIP_APKSIGNER.',
  });
}

module.exports = { findApksigner, classifyVerifyOutput, verifyApkSignature, compareVersions };
