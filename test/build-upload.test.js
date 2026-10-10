/**
 * CLI wiring tests: provider selection/parsing and the --ci (plain) output
 * contract.
 *
 * The providers themselves are stubbed — these tests verify the core
 * dispatches to the right provider and keeps the line-oriented CI contract
 * intact.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { parseArgs, runPlain, PROVIDERS, DEFAULT_PROVIDER, resolvePlatforms, resolveMode, ENVS, StepError } = require('../lib/build-upload');

/* ---------------------------------------------------------------- */
/* --provider parsing                                                */
/* ---------------------------------------------------------------- */

test('parseArgs defaults to the ShareIPA provider (single source of truth)', () => {
  assert.equal(DEFAULT_PROVIDER, 'shareipa');
  assert.equal(parseArgs([], { allowPlatform: true }).provider, DEFAULT_PROVIDER);
  assert.equal(parseArgs(['--platform', 'android', '--uat'], { allowPlatform: true }).provider, 'shareipa');
  assert.equal(parseArgs(['--ci'], { allowPlatform: true }).provider, 'shareipa');
});

test('parseArgs accepts --provider shareipa in both forms, case-insensitively', () => {
  assert.equal(parseArgs(['--provider', 'shareipa'], { allowPlatform: true }).provider, 'shareipa');
  assert.equal(parseArgs(['--provider=SHAREIPA'], { allowPlatform: true }).provider, 'shareipa');
  assert.equal(parseArgs(['--provider', 'ShareIPA', '--ci'], { allowPlatform: true }).provider, 'shareipa');
});

test('parseArgs accepts --provider betadrop in both forms, case-insensitively', () => {
  assert.equal(parseArgs(['--provider', 'betadrop'], { allowPlatform: true }).provider, 'betadrop');
  assert.equal(parseArgs(['--provider=betadrop'], { allowPlatform: true }).provider, 'betadrop');
  assert.equal(parseArgs(['--provider', 'BetaDrop', '--ci'], { allowPlatform: true }).provider, 'betadrop');
});

test('parseArgs rejects unknown and missing provider values as usage errors', () => {
  for (const argv of [['--provider', 'dropbox'], ['--provider'], ['--provider=']]) {
    assert.throws(
      () => parseArgs(argv, { allowPlatform: true }),
      (err) => err instanceof StepError && err.usage === true && /provider/i.test(err.message),
      `expected usage error for ${JSON.stringify(argv)}`,
    );
  }
});

test('parseArgs accepts one or both platforms via --platform (comma-separated)', () => {
  assert.equal(parseArgs([], { allowPlatform: true }).platforms, null);
  assert.deepEqual(parseArgs(['--platform', 'android'], { allowPlatform: true }).platforms, ['android']);
  assert.deepEqual(parseArgs(['--platform', 'ios'], { allowPlatform: true }).platforms, ['ios']);
  assert.deepEqual(parseArgs(['--platform', 'android,ios'], { allowPlatform: true }).platforms, ['android', 'ios']);
  assert.deepEqual(parseArgs(['--platform=ios,android'], { allowPlatform: true }).platforms, ['ios', 'android']);
  assert.deepEqual(parseArgs(['--platform', 'android', '--platform', 'ios'], { allowPlatform: true }).platforms, ['android', 'ios']);
  assert.deepEqual(parseArgs(['--platform', 'Android , ios '], { allowPlatform: true }).platforms, ['android', 'ios']);
  assert.deepEqual(parseArgs(['--platform', 'android,android'], { allowPlatform: true }).platforms, ['android']);
});

test('parseArgs rejects invalid or missing platform values as usage errors', () => {
  for (const argv of [['--platform', 'web'], ['--platform', 'android,web'], ['--platform'], ['--platform='], ['--platform', ',']]) {
    assert.throws(
      () => parseArgs(argv, { allowPlatform: true }),
      (err) => err instanceof StepError && err.usage === true && /platform/i.test(err.message),
      `expected usage error for ${JSON.stringify(argv)}`,
    );
  }
});

test('resolvePlatforms passes --platform through and refuses to guess non-interactively', async () => {
  assert.deepEqual(await resolvePlatforms({}, ['android', 'ios'], true), ['android', 'ios']);
  assert.deepEqual(await resolvePlatforms({}, ['ios'], true), ['ios']);
  await assert.rejects(
    () => resolvePlatforms({ android: {}, ios: {} }, null, true),
    (err) => err instanceof StepError && err.usage === true && /platform/i.test(err.message),
  );
  /* tests run without a TTY — that counts as non-interactive too */
  await assert.rejects(
    () => resolvePlatforms({ android: {}, ios: {} }, null, false),
    (err) => err instanceof StepError && err.usage === true,
  );
});

test('resolveMode defaults to sequential for one platform and for --ci', async () => {
  assert.equal(await resolveMode([{ label: 'Android' }], false), 'sequential');
  assert.equal(await resolveMode([{ label: 'Android' }, { label: 'iOS' }], true), 'sequential');
  /* two platforms + no TTY (tests) also resolves without asking */
  assert.equal(await resolveMode([{ label: 'Android' }, { label: 'iOS' }], false), 'sequential');
});

/* ---------------------------------------------------------------- */
/* --ci output contract (runPlain)                                   */
/* ---------------------------------------------------------------- */

function captureConsole(fn) {
  const stdout = [];
  const stderr = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args) => stdout.push(args.join(' '));
  console.error = (...args) => stderr.push(args.join(' '));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = originalLog;
      console.error = originalError;
    })
    .then(() => ({ stdout, stderr }));
}

test('runPlain --ci keeps line-oriented output and routes through the selected provider', async () => {
  const providerCalls = [];
  const builds = [];
  const original = PROVIDERS.shareipa.upload;
  PROVIDERS.shareipa.upload = async (profile, filePath, name, notes, opts) => {
    providerCalls.push({ profile, filePath, name, notes, opts });
    opts.onProcessing();
    return { url: 'https://install.shareipa.com/TESTID', adminUrl: 'https://dashboard.shareipa.com/admin/ADMIN', timing: { transferMs: 1000, serverMs: 500 } };
  };

  const adapter = {
    appName: 'DemoApp',
    label: 'Android',
    artifactWord: 'APK',
    expectedName: 'app-release.apk',
    entry: { command: 'ship --platform android', label: 'Android', appName: 'DemoApp', allowPlatform: false, verboseHint: 'verbose' },
    profile: { root: '/tmp/demo-project' },
    async build({ verbose }) {
      builds.push(verbose);
    },
    async produceArtifact() {
      return {
        file: {
          name: 'app-release.apk',
          fullPath: '/tmp/demo-project/android/app/build/outputs/apk/release/app-release.apk',
          size: 2 * 1024 * 1024,
        },
        fallback: false,
      };
    },
  };

  try {
    const { stdout, stderr } = await captureConsole(() =>
      runPlain(adapter, {
        env: ENVS['--uat'],
        verbose: false,
        version: { versionName: '8.5', versionCode: '193' },
        notes: 'DemoApp Android Staging Build — v8.5 (build 193)',
        backend: { restore() {} },
        finishRestore() {},
        startedAt: Date.now(),
        provider: 'shareipa',
      }),
    );

    const out = stdout.join('\n');
    assert.match(out, /DemoApp Android Staging build \(v8\.5, build 193\)/);
    assert.match(out, /Building Android release\.\.\./);
    assert.match(out, /Build complete in /);
    assert.match(out, /APK: .*app-release\.apk \(2\.0 MB\)/);
    assert.match(out, /Uploading to ShareIPA\.\.\./);
    assert.match(out, /Processing on ShareIPA\.\.\./);
    assert.ok(
      out.includes('DemoApp (STAG): [Android Build Link](https://install.shareipa.com/TESTID)'),
      `share message missing from CI output:\n${out}`,
    );
    assert.match(out, /(Copied to clipboard|Clipboard unavailable)/);
    assert.ok(!out.includes('\u001b['), 'CI output must not contain ANSI escape codes');
    assert.equal(stderr.join(''), '');
    assert.deepEqual(builds, [false]);
    assert.equal(providerCalls.length, 1);
    assert.equal(providerCalls[0].opts.ci, true);
    assert.equal(providerCalls[0].opts.onProgress, undefined);
    assert.equal(typeof providerCalls[0].opts.signal.aborted, 'boolean');
  } finally {
    PROVIDERS.shareipa.upload = original;
  }
});

/** Minimal iOS adapter stub used by the provider-dispatch tests. */
function iosAdapter() {
  return {
    appName: 'DemoApp',
    shareName: 'Demo-App',
    label: 'iOS',
    artifactWord: 'IPA',
    expectedName: 'app.ipa',
    entry: { command: 'ship --platform ios', label: 'iOS', appName: 'DemoApp', allowPlatform: false, verboseHint: 'verbose' },
    profile: { root: '/tmp/demo-project' },
    async build() {},
    async produceArtifact() {
      return { file: { name: 'app.ipa', fullPath: '/tmp/demo-project/app.ipa', size: 1024 }, fallback: false };
    },
  };
}

test('runPlain uses ShareIPA (the default) when no provider is given', async () => {
  const calls = [];
  const original = PROVIDERS.shareipa.upload;
  PROVIDERS.shareipa.upload = async (profile, filePath, name, notes, opts) => {
    calls.push({ name, notes, opts });
    return { url: 'https://install.shareipa.com/TESTID', timing: { transferMs: 5, serverMs: 1 } };
  };

  try {
    const { stdout, stderr } = await captureConsole(() =>
      runPlain(iosAdapter(), {
        env: ENVS['--prod'],
        verbose: false,
        version: { versionName: '1.0', versionCode: '1' },
        notes: 'DemoApp iOS Production Build',
        backend: { restore() {} },
        finishRestore() {},
        startedAt: Date.now(),
      }),
    );
    const out = stdout.join('\n');
    assert.match(out, /Uploading to ShareIPA\.\.\./);
    assert.ok(out.includes('Demo-App (PROD): [iOS Build Link](https://install.shareipa.com/TESTID)'));
    assert.match(out, /(Copied to clipboard|Clipboard unavailable)/);
    assert.ok(!out.includes('\u001b['), 'CI output must not contain ANSI escape codes');
    assert.equal(stderr.join(''), '');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.ci, true);
  } finally {
    PROVIDERS.shareipa.upload = original;
  }
});

test('runPlain --ci --provider betadrop uses BetaDrop and keeps the line-oriented contract', async () => {
  const calls = [];
  const original = PROVIDERS.betadrop.upload;
  PROVIDERS.betadrop.upload = async (profile, filePath, name, notes, opts) => {
    calls.push({ name, notes, opts });
    return { url: 'https://betadrop.app/i/TESTID', timing: null };
  };

  try {
    const { stdout, stderr } = await captureConsole(() =>
      runPlain(iosAdapter(), {
        env: ENVS['--prod'],
        verbose: false,
        version: { versionName: '1.0', versionCode: '1' },
        notes: 'DemoApp iOS Production Build',
        backend: { restore() {} },
        finishRestore() {},
        startedAt: Date.now(),
        provider: 'betadrop',
      }),
    );
    const out = stdout.join('\n');
    assert.match(out, /Uploading to BetaDrop\.\.\./);
    assert.ok(out.includes('Demo-App (PROD): [iOS Build Link](https://betadrop.app/i/TESTID)'));
    assert.match(out, /(Copied to clipboard|Clipboard unavailable)/);
    assert.ok(!out.includes('\u001b['), 'CI output must not contain ANSI escape codes');
    assert.equal(stderr.join(''), '');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.ci, true);
  } finally {
    PROVIDERS.betadrop.upload = original;
  }
});

/* ---------------------------------------------------------------- */
/* Both platforms in one run (--ci, sequential)                      */
/* ---------------------------------------------------------------- */

function makePlainAdapter(key, label, artifactWord, fileName) {
  return {
    key,
    label,
    appName: 'DemoApp',
    shareName: 'Demo-App',
    artifactWord,
    expectedName: fileName,
    entry: { command: `ship --platform ${key}`, label, appName: 'DemoApp', shareName: 'Demo-App', allowPlatform: false, verboseHint: 'verbose' },
    profile: { root: '/tmp/demo-project' },
    built: 0,
    async build() {
      this.built++;
    },
    async produceArtifact() {
      return {
        file: { name: fileName, fullPath: `/tmp/demo-project/${fileName}`, size: 1024 },
        fallback: false,
      };
    },
  };
}

test('runPlain builds both platforms sequentially and copies both links (--ci)', async () => {
  const calls = [];
  const original = PROVIDERS.shareipa.upload;
  let n = 0;
  PROVIDERS.shareipa.upload = async (profile, filePath, name, notes, opts) => {
    calls.push({ name, notes, opts });
    n++;
    return { url: `https://install.shareipa.com/LINK${n}`, timing: { transferMs: 1, serverMs: 1 } };
  };

  const android = makePlainAdapter('android', 'Android', 'APK', 'app-release.apk');
  const ios = makePlainAdapter('ios', 'iOS', 'IPA', 'app.ipa');
  let restores = 0;

  try {
    const { stdout, stderr } = await captureConsole(() =>
      runPlain([android, ios], {
        env: ENVS['--uat'],
        verbose: false,
        versions: [
          { versionName: '8.7', versionCode: '196' },
          { versionName: '8.2', versionCode: '3' },
        ],
        backend: { restore() {} },
        finishRestore() {
          restores++;
        },
        startedAt: Date.now(),
        provider: 'shareipa',
      }),
    );

    const out = stdout.join('\n');
    assert.ok(out.includes('DemoApp Android Staging build (v8.7, build 196)'));
    assert.ok(out.includes('DemoApp iOS Staging build (v8.2, build 3)'));
    assert.equal((out.match(/Uploading to ShareIPA\.\.\./g) || []).length, 2, 'both platforms upload');

    const first = out.indexOf('Demo-App (STAG): [Android Build Link](https://install.shareipa.com/LINK1)');
    const second = out.indexOf('Demo-App (STAG): [iOS Build Link](https://install.shareipa.com/LINK2)');
    assert.ok(first !== -1 && second !== -1 && first < second, `both links missing or out of order:\n${out}`);

    assert.match(out, /(Copied to clipboard|Clipboard unavailable)/);
    assert.ok(!out.includes('\u001b['), 'CI output must not contain ANSI escape codes');
    assert.equal(stderr.join(''), '');

    assert.equal(android.built, 1);
    assert.equal(ios.built, 1);
    assert.equal(calls.length, 2);
    assert.equal(restores, 1, 'APPConfig restored once, after the last build');
    assert.ok(calls[0].notes.includes('Android Staging'), calls[0].notes);
    assert.ok(calls[1].notes.includes('iOS Staging'), calls[1].notes);
    assert.equal(calls[0].opts.ci, true);
    assert.equal(calls[1].opts.ci, true);
  } finally {
    PROVIDERS.shareipa.upload = original;
  }
});
