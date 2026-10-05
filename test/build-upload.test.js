/**
 * CLI wiring tests: --provider parsing and the --ci (plain) output contract.
 *
 * The provider itself is stubbed — these tests verify the core passes the
 * right options through and keeps the line-oriented CI contract intact.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { parseArgs, runPlain, PROVIDERS, ENVS, StepError } = require('../lib/build-upload');

/* ---------------------------------------------------------------- */
/* --provider parsing                                                */
/* ---------------------------------------------------------------- */

test('parseArgs defaults to the betadrop provider', () => {
  assert.equal(parseArgs([], { allowPlatform: true }).provider, 'betadrop');
  assert.equal(parseArgs(['--platform', 'android', '--uat'], { allowPlatform: true }).provider, 'betadrop');
});

test('parseArgs accepts --provider shareipa in both forms, case-insensitively', () => {
  assert.equal(parseArgs(['--provider', 'shareipa'], { allowPlatform: true }).provider, 'shareipa');
  assert.equal(parseArgs(['--provider=SHAREIPA'], { allowPlatform: true }).provider, 'shareipa');
  assert.equal(parseArgs(['--provider', 'ShareIPA', '--ci'], { allowPlatform: true }).provider, 'shareipa');
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
      out.includes('DemoApp: [Android Stag Build](https://install.shareipa.com/TESTID)'),
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

test('runPlain still defaults to BetaDrop when no provider is given', async () => {
  const calls = [];
  const original = PROVIDERS.betadrop.upload;
  PROVIDERS.betadrop.upload = async (profile, filePath, name, notes, opts) => {
    calls.push({ name, notes, opts });
    return { url: 'https://betadrop.app/i/TESTID', timing: null };
  };

  const adapter = {
    appName: 'DemoApp',
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

  try {
    const { stdout } = await captureConsole(() =>
      runPlain(adapter, {
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
    assert.match(out, /Uploading to BetaDrop\.\.\./);
    assert.ok(out.includes('https://betadrop.app/i/TESTID'));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].opts.ci, true);
  } finally {
    PROVIDERS.betadrop.upload = original;
  }
});
