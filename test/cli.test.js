/**
 * Spawn-level tests of the real `ship` entry point in throwaway projects.
 *
 * MOCKED: gradlew / xcodebuild / apksigner / pbcopy are shell stand-ins and
 * every upload provider is stubbed (test/helpers/ship-harness.js). These
 * tests prove the CLI contract — exit codes, --output-json, locking,
 * APPConfig restoration, cleanup, cancellation, no clipboard in CI — not
 * that a real Gradle/Xcode build or upload works.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');

const { makeSandbox, spawnShip, waitForFile } = require('./helpers/fixture');

const ANDROID_CI = ['--platform', 'android', '--ci'];

function assertClean(sb, label = '') {
  assert.equal(sb.readAppConfig(), sb.originalAppConfig, `${label}APPConfig.js restored byte-for-byte`);
  assert.deepEqual(sb.locks(), [], `${label}project lock released`);
  assert.deepEqual(sb.leftoverTemp(), [], `${label}no rn-build-upload temp dirs left`);
  assert.equal(fs.existsSync(sb.pbcopyMarker), false, `${label}pbcopy never called`);
}

test('CI success: exit 0, JSON success with URL + sha256, share message last, no clipboard', async () => {
  const sb = makeSandbox({ git: true });
  try {
    const { done } = spawnShip(sb, [...ANDROID_CI, '--prod', '--output-json', sb.resultPath]);
    const r = await done;
    assert.equal(r.code, 0, r.stderr);
    const lines = r.stdout.trim().split('\n');
    assert.equal(lines[lines.length - 1], 'Demo-App (PROD): [Android Build Link](https://install.example.test/shareipa/app-release.apk)');
    assert.doesNotMatch(r.stdout, /clipboard/i);
    assert.equal(r.stderr, '');

    const doc = sb.readResult();
    assert.equal(doc.outcome, 'success');
    assert.equal(doc.exitCode, 0);
    assert.equal(doc.request.environment, 'prod');
    assert.equal(doc.request.provider, 'shareipa');
    assert.match(doc.project.commitSha, /^[0-9a-f]{40}$/);
    assert.equal(doc.project.workingTreeDirty, false, 'git state is read before APPConfig.js is patched');
    const [android] = doc.platforms;
    assert.equal(android.artifactUrl, 'https://install.example.test/shareipa/app-release.apk');
    assert.match(android.artifact.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(android.artifact.signature.schemes, ['v2']);
    assert.deepEqual(android.version, { name: '1.2.3', code: '7' });
    assert.equal(typeof android.durations.buildMs, 'number');
    assert.equal(typeof android.durations.uploadMs, 'number');
    assert.deepEqual(sb.uploadCalls().map((c) => c.ci), [true]);
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('CI upload failure: exit 1, JSON failure without URL, APK kept, state restored', async () => {
  const sb = makeSandbox();
  try {
    const { done } = spawnShip(sb, [...ANDROID_CI, '--prod', '--output-json', sb.resultPath], { upload: 'fail' });
    const r = await done;
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Upload failed\./);
    assert.match(r.stderr, /APK built successfully: android\/app\/build\/outputs\/apk\/release\/app-release\.apk/);
    assert.doesNotMatch(r.stdout, /Build Link\]\(/, 'no share message on failure');
    const doc = sb.readResult();
    assert.equal(doc.outcome, 'failure');
    assert.equal(doc.exitCode, 1);
    assert.equal(doc.error.code, 'UPLOAD_FAILED');
    assert.equal(doc.error.platform, 'android');
    assert.equal(doc.platforms[0].status, 'failure');
    assert.equal(doc.platforms[0].artifactUrl, null);
    assert.ok(fs.existsSync(path.join(sb.project, 'android/app/build/outputs/apk/release/app-release.apk')), 'the build output (not a temp file) is kept');
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

for (const [mode, code] of [
  ['unsigned', 'APK_UNSIGNED'],
  ['invalid', 'APK_SIGNATURE_INVALID'],
  ['nojava', 'APK_VERIFY_UNAVAILABLE'],
]) {
  test(`APK signature "${mode}" fails closed before any upload (${code})`, async () => {
    const sb = makeSandbox();
    try {
      const { done } = spawnShip(sb, [...ANDROID_CI, '--uat', '--output-json', sb.resultPath], { env: { SHIP_TEST_APKSIGNER: mode } });
      const r = await done;
      assert.equal(r.code, 1);
      assert.match(r.stderr, /not uploading/);
      assert.deepEqual(sb.uploadCalls(), [], 'the upload provider was never called');
      const doc = sb.readResult();
      assert.equal(doc.outcome, 'failure');
      assert.equal(doc.error.code, code);
      assert.equal(doc.error.phase, 'artifact');
      assert.equal(doc.platforms[0].artifactUrl, null);
      assertClean(sb);
    } finally {
      sb.cleanup();
    }
  });
}

test('apksigner missing entirely: APK_VERIFY_UNAVAILABLE, nothing uploaded', async () => {
  const sb = makeSandbox();
  try {
    const { done } = spawnShip(sb, [...ANDROID_CI, '--uat', '--output-json', sb.resultPath], {
      /* empty SDK locations, PATH without apksigner (but with node's dir for the shebang-less tools) */
      env: { SHIP_APKSIGNER: '', ANDROID_HOME: path.join(sb.base, 'no-sdk'), ANDROID_SDK_ROOT: '', PATH: `${sb.bin}${path.delimiter}/usr/bin${path.delimiter}/bin` },
    });
    const r = await done;
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /apksigner was not found/);
    assert.deepEqual(sb.uploadCalls(), []);
    assert.equal(sb.readResult().error.code, 'APK_VERIFY_UNAVAILABLE');
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('build failure: exit 1 with BUILD_FAILED and APPConfig restored', async () => {
  const sb = makeSandbox();
  try {
    const { done } = spawnShip(sb, [...ANDROID_CI, '--prod', '--output-json', sb.resultPath], { env: { SHIP_TEST_GRADLE_FAIL: '1' } });
    const r = await done;
    assert.equal(r.code, 1);
    const doc = sb.readResult();
    assert.equal(doc.error.code, 'BUILD_FAILED');
    assert.equal(doc.error.phase, 'build');
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('usage errors exit 2 and are still reported in the JSON', async () => {
  const sb = makeSandbox();
  try {
    /* --ci without an environment flag no longer falls back to APPConfig.js */
    let r = await spawnShip(sb, [...ANDROID_CI, '--output-json', sb.resultPath]).done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /Missing environment flag/);
    assert.equal(sb.readResult().error.code, 'USAGE');
    assert.equal(sb.readResult().outcome, 'failure');

    /* bad option */
    r = await spawnShip(sb, ['--ci', '--bogus', '--output-json', sb.resultPath]).done;
    assert.equal(r.code, 2);
    assert.equal(sb.readResult().error.code, 'USAGE');

    /* --ci without --platform */
    r = await spawnShip(sb, ['--ci', '--uat', '--output-json', sb.resultPath]).done;
    assert.equal(r.code, 2);
    assert.equal(sb.readResult().error.code, 'USAGE');
    assert.deepEqual(sb.uploadCalls(), []);
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('an unwritable --output-json path is rejected before building', async () => {
  const sb = makeSandbox();
  try {
    const r = await spawnShip(sb, [...ANDROID_CI, '--uat', '--output-json', path.join(sb.base, 'missing-dir', 'r.json')]).done;
    assert.equal(r.code, 2);
    assert.match(r.stderr, /--output-json directory is missing or not writable/);
    assert.doesNotMatch(r.stdout, /Building/);
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('a stale result file from an earlier run never survives a failed run', async () => {
  const sb = makeSandbox();
  try {
    fs.writeFileSync(sb.resultPath, JSON.stringify({ outcome: 'success', platforms: [{ artifactUrl: 'https://old' }] }));
    const r = await spawnShip(sb, [...ANDROID_CI, '--uat', '--output-json', sb.resultPath], { upload: 'fail' }).done;
    assert.equal(r.code, 1);
    const doc = sb.readResult();
    assert.equal(doc.outcome, 'failure');
    assert.ok(!JSON.stringify(doc).includes('https://old'));
  } finally {
    sb.cleanup();
  }
});

test('concurrent runs: the second fails fast with LOCKED (exit 3) and touches nothing', async () => {
  const sb = makeSandbox({ isUAT: true });
  const gate = path.join(sb.base, 'gate');
  try {
    const first = spawnShip(sb, [...ANDROID_CI, '--prod', '--output-json', sb.resultPath], { env: { SHIP_TEST_GATE: gate } });
    await waitForFile(`${gate}.waiting`);
    /* the first run holds the lock and has APPConfig patched to prod */
    assert.match(sb.readAppConfig(), /const isUAT = false;/);
    assert.equal(sb.locks().length, 1);

    const secondResult = path.join(sb.base, 'second.json');
    const second = await spawnShip(sb, [...ANDROID_CI, '--uat', '--output-json', secondResult]).done;
    assert.equal(second.code, 3, second.stderr);
    assert.match(second.stderr, /Another ship run is already using this project/);
    assert.doesNotMatch(second.stdout, /Building/);
    const secondDoc = JSON.parse(fs.readFileSync(secondResult, 'utf8'));
    assert.equal(secondDoc.error.code, 'LOCKED');
    assert.equal(secondDoc.exitCode, 3);
    assert.match(sb.readAppConfig(), /const isUAT = false;/, 'the second run did not touch the first run\'s APPConfig');
    assert.equal(sb.locks().length, 1, 'the second run did not remove the first run\'s lock');

    fs.writeFileSync(gate, '');
    const r = await first.done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(sb.readResult().outcome, 'success');
    assertClean(sb);
  } finally {
    fs.writeFileSync(gate, '');
    sb.cleanup();
  }
});

test('SIGTERM during the build: exit 130, cancelled JSON, APPConfig restored, unlocked', async () => {
  const sb = makeSandbox();
  const gate = path.join(sb.base, 'gate');
  try {
    const run = spawnShip(sb, [...ANDROID_CI, '--prod', '--output-json', sb.resultPath], { env: { SHIP_TEST_GATE: gate } });
    await waitForFile(`${gate}.waiting`);
    run.child.kill('SIGTERM');
    const r = await run.done;
    assert.equal(r.code, 130, r.stderr);
    const doc = sb.readResult();
    assert.equal(doc.outcome, 'cancelled');
    assert.equal(doc.error.code, 'CANCELLED');
    assert.equal(doc.platforms[0].artifactUrl, null);
    assert.deepEqual(sb.uploadCalls(), []);
    assertClean(sb);
  } finally {
    fs.writeFileSync(gate, '');
    sb.cleanup();
  }
});

test('iOS: the staged IPA dir is removed after a failed upload (and the message says so)', async () => {
  const sb = makeSandbox({ android: false, ios: true });
  try {
    const r = await spawnShip(sb, ['--platform', 'ios', '--ci', '--prod', '--output-json', sb.resultPath], { upload: 'fail' }).done;
    assert.equal(r.code, 1, r.stderr);
    assert.deepEqual(sb.uploadCalls().map((c) => [c.file, c.existed]), [['Demo.ipa', true]], 'the IPA existed while uploading');
    assert.match(r.stderr, /the staged IPA was removed/);
    assert.equal(sb.readResult().error.code, 'UPLOAD_FAILED');
    assert.match(sb.readResult().platforms[0].artifact.sha256, /^[0-9a-f]{64}$/);
    assert.ok(fs.existsSync(path.join(sb.products, 'Demo.app')), 'the build output in DerivedData is not touched');
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('iOS: SIGTERM during the upload removes the staged IPA and exits 130', async () => {
  const sb = makeSandbox({ android: false, ios: true });
  try {
    const run = spawnShip(sb, ['--platform', 'ios', '--ci', '--prod', '--output-json', sb.resultPath], { upload: 'hang' });
    await run.waitFor(/Uploading to ShareIPA/);
    assert.equal(sb.leftoverTemp().length, 1, 'the staged IPA dir exists during the upload');
    run.child.kill('SIGTERM');
    const r = await run.done;
    assert.equal(r.code, 130, r.stderr);
    assert.equal(sb.readResult().outcome, 'cancelled');
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('iOS success removes the staged IPA too; both platforms report their own results', async () => {
  const sb = makeSandbox({ android: true, ios: true });
  try {
    const r = await spawnShip(sb, ['--platform', 'android,ios', '--ci', '--uat', '--output-json', sb.resultPath]).done;
    assert.equal(r.code, 0, r.stderr);
    const doc = sb.readResult();
    assert.equal(doc.outcome, 'success');
    assert.deepEqual(doc.platforms.map((p) => [p.platform, p.status]), [['android', 'success'], ['ios', 'success']]);
    assert.equal(doc.platforms[1].artifact.signature, null, 'IPA signatures are not checked by ship');
    const lines = r.stdout.trim().split('\n');
    assert.deepEqual(lines.slice(-2), [
      'Demo-App (STAG): [Android Build Link](https://install.example.test/shareipa/app-release.apk)',
      'Demo-App (STAG): [iOS Build Link](https://install.example.test/shareipa/Demo.ipa)',
    ]);
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('without --output-json nothing is written and CI output is unchanged otherwise', async () => {
  const sb = makeSandbox();
  try {
    const r = await spawnShip(sb, [...ANDROID_CI, '--uat']).done;
    assert.equal(r.code, 0, r.stderr);
    assert.equal(fs.existsSync(sb.resultPath), false);
    assert.match(r.stdout, /Demo-App \(STAG\): \[Android Build Link\]/);
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('regression: --provider betadrop is routed to the BetaDrop provider in CI', async () => {
  const sb = makeSandbox();
  try {
    const r = await spawnShip(sb, [...ANDROID_CI, '--uat', '--provider', 'betadrop', '--output-json', sb.resultPath]).done;
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Uploading to BetaDrop\.\.\./);
    assert.deepEqual(sb.uploadCalls().map((c) => c.provider), ['betadrop']);
    assert.equal(sb.readResult().request.provider, 'betadrop');
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

/* ---------------------------------------------------------------- */
/* Release-readiness review regressions                              */
/* ---------------------------------------------------------------- */

const pidAlive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
};

test('review #1: a cancel during the checksum never starts the upload', async () => {
  const sb = makeSandbox();
  const marker = path.join(sb.base, 'hashing');
  try {
    const run = spawnShip(sb, [...ANDROID_CI, '--uat', '--output-json', sb.resultPath], { env: { SHIP_TEST_SLOW_HASH: marker } });
    await waitForFile(marker);
    run.child.kill('SIGTERM');
    const r = await run.done;
    assert.equal(r.code, 130, r.stderr);
    assert.deepEqual(sb.uploadCalls(), [], 'no upload may start after the cancel');
    assert.doesNotMatch(r.stdout, /Uploading to/);
    assert.equal(sb.readResult().outcome, 'cancelled');
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('review #3: a build killed by a signal without a cancel is BUILD_FAILED (exit 1), not cancelled', async () => {
  const sb = makeSandbox();
  try {
    const r = await spawnShip(sb, [...ANDROID_CI, '--prod', '--output-json', sb.resultPath], { env: { SHIP_TEST_GRADLE_KILL: '1' } }).done;
    assert.equal(r.code, 1, r.stderr);
    assert.match(r.stderr, /Gradle was killed by SIGKILL/);
    const doc = sb.readResult();
    assert.equal(doc.outcome, 'failure');
    assert.equal(doc.error.code, 'BUILD_FAILED');
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});

test('review #4: descendants of a cancelled build (even ones ignoring INT/TERM) do not survive', async () => {
  const sb = makeSandbox();
  const gate = path.join(sb.base, 'gate');
  const pidFile = path.join(sb.base, 'grandchild.pid');
  let grandchild = null;
  try {
    const run = spawnShip(sb, [...ANDROID_CI, '--uat', '--output-json', sb.resultPath], { env: { SHIP_TEST_GATE: gate, SHIP_TEST_GRANDCHILD: pidFile } });
    await waitForFile(`${gate}.waiting`);
    grandchild = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.ok(pidAlive(grandchild), 'grandchild running before the cancel');
    const killedAt = Date.now();
    run.child.kill('SIGTERM');
    const r = await run.done;
    assert.equal(r.code, 130, r.stderr);
    /* The grandchild holds ship's stdout pipe and ignores INT/TERM: ship must
     * neither wait for it (it sleeps 31.7s) nor for the 20s SIGKILL escalation. */
    assert.ok(Date.now() - killedAt < 8000, `cancel took ${Date.now() - killedAt}ms`);
    /* reaped by the exit hook (SIGTERM ignored -> SIGKILL within ~1s) */
    const deadline = Date.now() + 3000;
    while (pidAlive(grandchild) && Date.now() < deadline) await new Promise((res) => setTimeout(res, 50));
    assert.equal(pidAlive(grandchild), false, 'the grandchild must not outlive the cancelled run');
    assertClean(sb);
  } finally {
    if (grandchild && pidAlive(grandchild)) process.kill(grandchild, 'SIGKILL');
    fs.writeFileSync(gate, '');
    sb.cleanup();
  }
});

test('review #5: --check and --help remove a stale result instead of leaving it', async () => {
  const sb = makeSandbox();
  try {
    for (const args of [['--check'], ['--help']]) {
      fs.writeFileSync(sb.resultPath, JSON.stringify({ outcome: 'success' }));
      const r = await spawnShip(sb, [...args, '--output-json', sb.resultPath]).done;
      assert.equal(r.code, 0, `${args}: ${r.stderr}`);
      assert.equal(fs.existsSync(sb.resultPath), false, `${args} must not leave a stale result`);
    }
  } finally {
    sb.cleanup();
  }
});

test('review: --ci argument errors are rejected before locking or reading project settings', async () => {
  const sb = makeSandbox({ android: false, ios: true });
  try {
    /* a fake xcodebuild that would leave a marker if -showBuildSettings ran */
    const marker = path.join(sb.base, 'xcodebuild-ran');
    fs.writeFileSync(path.join(sb.bin, 'xcodebuild'), `#!/bin/sh\ntouch "${marker}"\nexit 1\n`, { mode: 0o755 });
    const r = await spawnShip(sb, ['--platform', 'ios', '--ci', '--output-json', sb.resultPath]).done;
    assert.equal(r.code, 2);
    assert.equal(fs.existsSync(marker), false, 'xcodebuild must not run');
    assert.equal(fs.existsSync(sb.lockDir), false, 'no lock taken');
    assert.equal(sb.readResult().error.code, 'USAGE');
  } finally {
    sb.cleanup();
  }
});

test('review #6: the uploaded APK is a private snapshot; the build output stays in place', async () => {
  const sb = makeSandbox();
  try {
    const r = await spawnShip(sb, [...ANDROID_CI, '--uat', '--output-json', sb.resultPath]).done;
    assert.equal(r.code, 0, r.stderr);
    const [call] = sb.uploadCalls();
    assert.equal(call.file, 'app-release.apk');
    assert.equal(call.existed, true);
    assert.match(r.stdout, /APK: android\/app\/build\/outputs\/apk\/release\/app-release\.apk \(/, 'CI output names the build output, not the temp copy');
    assert.ok(fs.existsSync(path.join(sb.project, 'android/app/build/outputs/apk/release/app-release.apk')));
    assertClean(sb);
  } finally {
    sb.cleanup();
  }
});
