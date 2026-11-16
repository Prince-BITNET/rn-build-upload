/**
 * APK signature verification (lib/apk-signature.js).
 *
 * Unit tests mock the command runner with real apksigner output shapes
 * (captured from build-tools 36.0.0). The last test runs the real apksigner
 * against throwaway files when the SDK is present; nothing is ever signed.
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { StepError } = require('../lib/errors');
const { classifyVerifyOutput, verifyApkSignature, findApksigner, compareVersions } = require('../lib/apk-signature');
const { runCommand } = require('../lib/build-upload');
const { createAndroidAdapter } = require('../lib/platforms/android');
const { makeZip } = require('./helpers/fixture');

const SIGNED = [
  'Verifies',
  'Verified using v1 scheme (JAR signing): false',
  'Verified using v2 scheme (APK Signature Scheme v2): true',
  'Verified using v3 scheme (APK Signature Scheme v3): true',
  'Verified using v3.1 scheme (APK Signature Scheme v3.1): false',
  'Verified using v4 scheme (APK Signature Scheme v4): false',
  'Number of signers: 1',
].join('\n');
const UNSIGNED = 'DOES NOT VERIFY\nERROR: Missing META-INF/MANIFEST.MF\n';
const BAD_SIGNATURE = 'DOES NOT VERIFY\nERROR: APK Signature Scheme v2 signer #1: Malformed additional attribute\n';
const MALFORMED =
  'Exception in thread "main" com.android.apksig.apk.ApkFormatException: Malformed APK: not a ZIP archive\n\tat com.android.apksig.ApkVerifier.verify(ApkVerifier.java:191)\n';
const MALFORMED_MANIFEST =
  'Exception in thread "main" com.android.apksig.apk.MinSdkVersionException: Failed to determine APK\'s minimum supported platform version. Use --min-sdk-version to override\n';
const NO_JAVA = 'The operation couldn’t be completed. Unable to locate a Java Runtime.\n';

const TOOL = { command: '/sdk/build-tools/36.0.0/apksigner', source: 'sdk', buildTools: '36.0.0' };
const locate = () => TOOL;
const runner = (result) => {
  const calls = [];
  const run = async (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    return { code: 0, signal: null, stdout: '', stderr: '', ...result };
  };
  return { run, calls };
};

test('classifyVerifyOutput recognises the apksigner outcomes', () => {
  assert.deepEqual(classifyVerifyOutput({ code: 0, stdout: SIGNED }), { status: 'verified', schemes: ['v2', 'v3'] });
  assert.equal(classifyVerifyOutput({ code: 1, stdout: UNSIGNED }).status, 'unsigned');
  assert.equal(classifyVerifyOutput({ code: 1, stdout: BAD_SIGNATURE }).status, 'invalid');
  assert.equal(classifyVerifyOutput({ code: 1, stderr: MALFORMED }).status, 'invalid');
  assert.equal(classifyVerifyOutput({ code: 1, stderr: MALFORMED_MANIFEST }).status, 'invalid');
  assert.equal(classifyVerifyOutput({ code: 1, stderr: NO_JAVA }).status, 'unavailable');
  /* exit 0 alone is not enough */
  assert.equal(classifyVerifyOutput({ code: 0, stdout: 'Verifies\n' }).status, 'unavailable');
  assert.equal(classifyVerifyOutput({ code: 0, stdout: '' }).status, 'unavailable');
});

test('a signed APK verifies and the exact command is apksigner verify --verbose <apk>', async () => {
  const { run, calls } = runner({ code: 0, stdout: SIGNED });
  const result = await verifyApkSignature('/out/app-release.apk', { run, locate });
  assert.deepEqual(result, { verified: true, schemes: ['v2', 'v3'], verifier: 'build-tools 36.0.0' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, TOOL.command);
  assert.deepEqual(calls[0].args, ['verify', '--verbose', '/out/app-release.apk']);
  assert.ok(!calls[0].args.includes('--print-certs'), 'certificates are never printed');
});

test('an unsigned APK is rejected with APK_UNSIGNED', async () => {
  const { run } = runner({ code: 1, stdout: UNSIGNED });
  await assert.rejects(verifyApkSignature('/out/app-release.apk', { run, locate }), (err) => {
    assert.ok(err instanceof StepError);
    assert.equal(err.code, 'APK_UNSIGNED');
    assert.match(err.message, /not signed; not uploading/);
    assert.match(err.details, /Missing META-INF\/MANIFEST\.MF/);
    return true;
  });
});

test('an invalid signature or malformed APK is rejected with APK_SIGNATURE_INVALID', async () => {
  for (const result of [{ code: 1, stdout: BAD_SIGNATURE }, { code: 1, stderr: MALFORMED }]) {
    const { run } = runner(result);
    await assert.rejects(verifyApkSignature('/out/app-release.apk', { run, locate }), (err) => err.code === 'APK_SIGNATURE_INVALID');
  }
});

test('verification that cannot run fails closed with APK_VERIFY_UNAVAILABLE', async () => {
  /* no apksigner anywhere */
  await assert.rejects(
    verifyApkSignature('/out/app-release.apk', { run: async () => assert.fail('must not run'), locate: () => null }),
    (err) => err.code === 'APK_VERIFY_UNAVAILABLE' && /apksigner was not found/.test(err.details),
  );
  /* binary vanished between lookup and spawn */
  const missing = runner({ code: null, spawnError: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) });
  await assert.rejects(verifyApkSignature('/out/a.apk', { run: missing.run, locate }), (err) => err.code === 'APK_VERIFY_UNAVAILABLE');
  /* no Java runtime */
  const noJava = runner({ code: 1, stderr: NO_JAVA });
  await assert.rejects(verifyApkSignature('/out/a.apk', { run: noJava.run, locate }), (err) => err.code === 'APK_VERIFY_UNAVAILABLE' && /Java/.test(err.hint));
  /* exit 0 without a verified scheme */
  const odd = runner({ code: 0, stdout: 'Verifies\n' });
  await assert.rejects(verifyApkSignature('/out/a.apk', { run: odd.run, locate }), (err) => err.code === 'APK_VERIFY_UNAVAILABLE');
});

test('a cancelled verification surfaces as a cancellation', async () => {
  const { run } = runner({ code: null, signal: 'SIGINT' });
  await assert.rejects(verifyApkSignature('/out/a.apk', { run, locate, isCancelled: () => true }), (err) => err.cancelled === true);
});

test('apksigner killed without a cancel request fails closed (not a cancellation)', async () => {
  const { run } = runner({ code: null, signal: 'SIGKILL' });
  await assert.rejects(verifyApkSignature('/out/a.apk', { run, locate }), (err) => {
    assert.equal(err.cancelled, undefined);
    assert.equal(err.code, 'APK_VERIFY_UNAVAILABLE');
    assert.match(err.details, /killed by SIGKILL/);
    return true;
  });
});

test('findApksigner prefers SHIP_APKSIGNER, then the newest SDK build-tools, then PATH', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-sdk-test-'));
  try {
    const sdk = path.join(base, 'sdk');
    for (const v of ['30.0.3', '34.0.0', '36.0.0', '9.0.0']) {
      fs.mkdirSync(path.join(sdk, 'build-tools', v), { recursive: true });
      fs.writeFileSync(path.join(sdk, 'build-tools', v, 'apksigner'), '#!/bin/sh\n', { mode: 0o755 });
    }
    /* newest dir without an executable apksigner is skipped */
    fs.mkdirSync(path.join(sdk, 'build-tools', '37.0.0-rc1'), { recursive: true });
    const env = { ANDROID_HOME: sdk, PATH: '' };
    assert.deepEqual(findApksigner({ env, homedir: base }), { command: path.join(sdk, 'build-tools', '36.0.0', 'apksigner'), source: 'sdk', buildTools: '36.0.0' });
    assert.equal(findApksigner({ env: { ...env, SHIP_APKSIGNER: '/opt/apksigner' }, homedir: base }).command, '/opt/apksigner');

    /* sdk.dir from android/local.properties (escaped path) */
    const androidDir = path.join(base, 'android');
    fs.mkdirSync(androidDir);
    fs.writeFileSync(path.join(androidDir, 'local.properties'), `sdk.dir=${sdk.replace(/:/g, '\\:')}\n`);
    assert.equal(findApksigner({ androidDir, env: { PATH: '' }, homedir: base }).buildTools, '36.0.0');

    const pathDir = path.join(base, 'pathbin');
    fs.mkdirSync(pathDir);
    fs.writeFileSync(path.join(pathDir, 'apksigner'), '#!/bin/sh\n', { mode: 0o755 });
    assert.deepEqual(findApksigner({ env: { PATH: pathDir }, homedir: base }), { command: path.join(pathDir, 'apksigner'), source: 'PATH', buildTools: null });
    assert.equal(findApksigner({ env: { PATH: '' }, homedir: base }), null);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
  assert.ok(compareVersions('36.0.0', '9.0.0') > 0);
  assert.ok(compareVersions('35.0.1', '35.0.0') > 0);
});

test('the Android adapter never returns an artifact whose signature did not verify', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-android-test-'));
  try {
    const releaseDir = path.join(base, 'android', 'app', 'build', 'outputs', 'apk', 'release');
    fs.mkdirSync(releaseDir, { recursive: true });
    makeZip(path.join(releaseDir, 'app-release.apk'));
    const profile = {
      root: base,
      appName: 'Demo',
      shareName: 'Demo',
      android: { dir: path.join(base, 'android'), gradleFile: path.join(base, 'android', 'app', 'build.gradle'), gradleTasks: ['assembleRelease'], releaseDir, expectedApkName: 'app-release.apk' },
    };
    const seen = [];
    const ok = createAndroidAdapter(profile, {
      verifySignature: async (apk, opts) => {
        seen.push({ apk, androidDir: opts.androidDir, run: opts.run });
        return { verified: true, schemes: ['v2'], verifier: 'mock' };
      },
    });
    const artifact = await ok.produceArtifact();
    const original = path.join(releaseDir, 'app-release.apk');
    assert.deepEqual(artifact.signature, { verified: true, schemes: ['v2'], verifier: 'mock' });
    /* verified, hashed and uploaded: one private snapshot, not the build output */
    assert.equal(seen[0].apk, artifact.file.fullPath);
    assert.notEqual(artifact.file.fullPath, original);
    assert.ok(path.basename(path.dirname(artifact.file.fullPath)).startsWith('rn-build-upload-apk-'));
    assert.equal(artifact.source, original);
    assert.equal(artifact.sourceKept, true);
    assert.equal(seen[0].androidDir, path.join(base, 'android'));
    assert.equal(seen[0].run, runCommand, 'uses the cancellable core runner');
    /* replacing the build output afterwards does not change what is uploaded */
    const before = fs.readFileSync(artifact.file.fullPath);
    fs.writeFileSync(original, 'replaced by someone else');
    assert.deepEqual(fs.readFileSync(artifact.file.fullPath), before);
    artifact.cleanup();
    assert.equal(fs.existsSync(path.dirname(artifact.file.fullPath)), false, 'snapshot removed by cleanup');
    fs.unlinkSync(original);
    makeZip(original);

    const rejected = createAndroidAdapter(profile, {
      verifySignature: async () => {
        throw new StepError('Release APK is not signed; not uploading.', { code: 'APK_UNSIGNED' });
      },
    });
    const tmpBefore = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('rn-build-upload-apk-')).length;
    await assert.rejects(rejected.produceArtifact(), (err) => err.code === 'APK_UNSIGNED');
    const tmpAfter = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('rn-build-upload-apk-')).length;
    assert.equal(tmpAfter, tmpBefore, 'a rejected snapshot is removed immediately');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

/* ---------------------------------------------------------------- */
/* Integration: the real apksigner (skipped when the SDK is absent)  */
/* ---------------------------------------------------------------- */

test('integration: real apksigner rejects an unsigned APK and a non-APK file', async (t) => {
  const tool = findApksigner({ env: { ...process.env, SHIP_APKSIGNER: '' } });
  if (!tool) {
    t.skip('apksigner not found (set ANDROID_HOME) — integration check skipped');
    return;
  }
  const probe = spawnSync(tool.command, ['--version'], { encoding: 'utf8' });
  if (probe.status !== 0) {
    t.skip(`apksigner cannot run here (${(probe.stderr || '').trim().slice(0, 80)}) — integration check skipped`);
    return;
  }
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-apksigner-it-'));
  try {
    const unsigned = makeZip(path.join(base, 'unsigned.apk'));
    const notApk = path.join(base, 'not.apk');
    fs.writeFileSync(notApk, 'not a zip');
    const env = { ...process.env, SHIP_APKSIGNER: '' };
    await assert.rejects(verifyApkSignature(unsigned, { run: runCommand, env }), (err) => err.code === 'APK_SIGNATURE_INVALID' || err.code === 'APK_UNSIGNED');
    await assert.rejects(verifyApkSignature(notApk, { run: runCommand, env }), (err) => err.code === 'APK_SIGNATURE_INVALID');

    /* Opt-in: a known-good signed APK (never one of ours), plus a copy with
     * its signature stripped (repacked without META-INF — not signed). */
    const signed = process.env.SHIP_APKSIGNER_IT_SIGNED_APK;
    if (signed) {
      const ok = await verifyApkSignature(signed, { run: runCommand, env });
      assert.equal(ok.verified, true);
      assert.ok(ok.schemes.length > 0);
      const x = path.join(base, 'x');
      fs.mkdirSync(x);
      spawnSync('unzip', ['-q', signed, '-d', x]);
      if (fs.existsSync(path.join(x, 'META-INF'))) {
        fs.rmSync(path.join(x, 'META-INF'), { recursive: true, force: true });
        spawnSync('zip', ['-qr', path.join(base, 'stripped.apk'), '.'], { cwd: x });
        await assert.rejects(verifyApkSignature(path.join(base, 'stripped.apk'), { run: runCommand, env }), (err) => err.code === 'APK_UNSIGNED');
      }
    }
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});
