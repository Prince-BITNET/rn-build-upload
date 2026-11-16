/**
 * APPConfig.js patch/restore (setIsUAT) and the lifecycle temp registry.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { setIsUAT } = require('../lib/build-upload');
const lifecycle = require('../lib/lifecycle');

function project(content) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-appconfig-test-'));
  const envFile = path.join(root, 'APPConfig.js');
  fs.writeFileSync(envFile, content, { mode: 0o640 });
  return { root, envFile, profile: { root, envFile }, read: () => fs.readFileSync(envFile, 'utf8'), cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const ORIGINAL = '// uncommitted user edit\nconst isUAT = true;\nexport const api = "x";\n';

test('patch then restore gives back the exact original, keeping pre-existing edits and mode', () => {
  const p = project(ORIGINAL);
  try {
    const backend = setIsUAT(p.profile, false);
    assert.equal(backend.patched, true);
    assert.equal(backend.previous, true);
    assert.match(p.read(), /const isUAT = false;/);
    assert.ok(p.read().includes('// uncommitted user edit'));
    assert.equal(backend.restore(), 'restored');
    assert.equal(p.read(), ORIGINAL);
    assert.equal(fs.statSync(p.envFile).mode & 0o777, 0o640);
    assert.equal(backend.restore(), 'restored', 'idempotent');
    assert.deepEqual(fs.readdirSync(p.root), ['APPConfig.js'], 'no temp file left next to APPConfig.js');
  } finally {
    p.cleanup();
  }
});

test('no patch is made when the file already selects the requested backend', () => {
  const p = project(ORIGINAL);
  try {
    const backend = setIsUAT(p.profile, true);
    assert.equal(backend.patched, false);
    assert.equal(backend.restore(), 'unchanged');
    assert.equal(p.read(), ORIGINAL);
  } finally {
    p.cleanup();
  }
});

test('edits made during the build are kept; only isUAT is put back', () => {
  const p = project(ORIGINAL);
  try {
    const backend = setIsUAT(p.profile, false);
    fs.writeFileSync(p.envFile, p.read().replace('export const api = "x";', 'export const api = "edited mid-build";'));
    assert.equal(backend.restore(), 'merged');
    assert.equal(p.read(), ORIGINAL.replace('"x"', '"edited mid-build"'));
  } finally {
    p.cleanup();
  }
});

test('if isUAT itself was changed during the build, the file is left untouched', () => {
  const p = project(ORIGINAL);
  try {
    const backend = setIsUAT(p.profile, false);
    const userVersion = p.read().replace('const isUAT = false', 'const isUAT = true').replace('"x"', '"y"');
    fs.writeFileSync(p.envFile, userVersion);
    assert.equal(backend.restore(), 'conflict');
    assert.equal(p.read(), userVersion);
  } finally {
    p.cleanup();
  }
});

test('missing file or missing isUAT is refused before anything is written', () => {
  const p = project('export default {};\n');
  try {
    assert.throws(() => setIsUAT(p.profile, true), (err) => err.code === 'ENV_CONFIG_INVALID');
    assert.equal(p.read(), 'export default {};\n');
    assert.throws(() => setIsUAT({ envFile: path.join(p.root, 'nope.js') }, true), (err) => err.code === 'ENV_CONFIG_INVALID');
  } finally {
    p.cleanup();
  }
});

test('lifecycle removes only temp dirs it created inside os.tmpdir()', () => {
  lifecycle.resetForTests();
  const dir = lifecycle.makeTempDir('ipa');
  fs.writeFileSync(path.join(dir, 'app.ipa'), 'x');
  assert.ok(path.basename(dir).startsWith('rn-build-upload-ipa-'));
  assert.equal(lifecycle.removeTempPath(dir), null);
  assert.equal(fs.existsSync(dir), false);
  assert.equal(lifecycle.removeTempPath(dir), null, 'second removal is a no-op');

  /* a path that was never registered is never touched */
  const user = fs.mkdtempSync(path.join(os.tmpdir(), 'rn-build-upload-user-'));
  try {
    assert.equal(lifecycle.removeTempPath(user), null);
    assert.equal(fs.existsSync(user), true);
    assert.equal(lifecycle.isOwnTempPath(user), true);
    assert.equal(lifecycle.isOwnTempPath(path.join(os.homedir(), 'rn-build-upload-x')), false);
    assert.equal(lifecycle.isOwnTempPath(path.join(os.tmpdir(), 'something-else')), false);
  } finally {
    fs.rmSync(user, { recursive: true, force: true });
  }
});

test('exit hooks: cleanups newest-first, then temp dirs, then finalizers with the exit code', () => {
  lifecycle.resetForTests();
  const order = [];
  const dir = lifecycle.makeTempDir('ipa');
  lifecycle.addCleanup(() => order.push('unlock'));
  lifecycle.addCleanup(() => order.push('restore'));
  lifecycle.addCleanup(() => {
    throw new Error('cleanup boom');
  });
  lifecycle.addFinalizer((code) => {
    order.push(`write:${code}:${fs.existsSync(dir)}`);
    return 4;
  });
  lifecycle.addFinalizer((code) => order.push(`after:${code}`));
  const code = lifecycle.runExitHooks(0);
  assert.deepEqual(order, ['restore', 'unlock', 'write:0:false', 'after:4']);
  assert.equal(code, 4);
  assert.ok(lifecycle.cleanupWarnings().some((w) => /cleanup boom/.test(w)), 'a failing cleanup becomes a warning, not an exception');
  lifecycle.resetForTests();
});
