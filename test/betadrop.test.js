/**
 * BetaDrop CLI pinning. No test here talks to BetaDrop: the process-level
 * test puts a fake `npx` first on PATH that records its arguments.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { BETADROP_CLI_VERSION, BETADROP_CLI_PACKAGE, betadropCommand, uploadToBetaDrop } = require('../lib/build-upload');
const { writeExecutable } = require('./helpers/fixture');

const EXACT_SEMVER = /^\d+\.\d+\.\d+$/;

test('the BetaDrop CLI version is an exact pin', () => {
  assert.match(BETADROP_CLI_VERSION, EXACT_SEMVER);
  assert.equal(BETADROP_CLI_VERSION, '0.4.0');
  assert.equal(BETADROP_CLI_PACKAGE, '@betadrop/cli@0.4.0');
});

test('betadropCommand always runs the pinned package (CI and PTY forms)', () => {
  const ci = betadropCommand(['publish', 'a.apk', '--ci'], { ci: true });
  assert.deepEqual(ci, { command: 'npx', args: ['-y', '@betadrop/cli@0.4.0', 'publish', 'a.apk', '--ci'] });

  const pty = betadropCommand(['publish', 'a.apk'], { ci: false, platform: 'darwin' });
  assert.deepEqual(pty, { command: 'script', args: ['-q', '/dev/null', 'npx', '-y', '@betadrop/cli@0.4.0', 'publish', 'a.apk'] });

  const linux = betadropCommand(['publish', 'a.apk'], { ci: false, platform: 'linux' });
  assert.equal(linux.command, 'npx');
  for (const { args } of [ci, pty, linux]) {
    assert.ok(!args.includes('@betadrop/cli'), 'never the bare (latest) package');
  }
});

test('no source file invokes @betadrop/cli without an exact version', () => {
  const files = ['bin/rn-build-upload.js', 'lib/build-upload.js', 'README.md'].map((f) => path.join(__dirname, '..', f));
  for (const file of files) {
    const text = fs.readFileSync(file, 'utf8');
    for (const m of text.matchAll(/npx\s+(?:-y\s+)?(@betadrop\/cli\S*)/g)) {
      assert.match(m[1], /^@betadrop\/cli@(\d+\.\d+\.\d+|\$\{BETADROP_CLI_PACKAGE\})?/, `${path.basename(file)}: ${m[0]}`);
      assert.notEqual(m[1], '@betadrop/cli', `${path.basename(file)} has an unpinned invocation: ${m[0]}`);
    }
  }
});

test('uploadToBetaDrop spawns npx with the pinned package (fake npx, no network)', async () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-betadrop-test-'));
  const argsFile = path.join(base, 'args');
  writeExecutable(path.join(base, 'npx'), `#!/bin/sh\nprintf '%s\\n' "$@" > "${argsFile}"\necho "https://betadrop.app/i/FAKE"\n`);
  const savedPath = process.env.PATH;
  process.env.PATH = `${base}${path.delimiter}${savedPath}`;
  try {
    const result = await uploadToBetaDrop({ root: base }, '/tmp/x/app-release.apk', 'Demo Android Staging', 'notes', { ci: true });
    assert.equal(result.url, 'https://betadrop.app/i/FAKE');
    const args = fs.readFileSync(argsFile, 'utf8').trim().split('\n');
    assert.deepEqual(args.slice(0, 3), ['-y', '@betadrop/cli@0.4.0', 'publish']);
    assert.ok(args.includes('--ci'));
    assert.ok(args.includes('--expires-in-days'));
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
