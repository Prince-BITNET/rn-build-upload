/**
 * Per-project lock (lib/lock.js) — deterministic, in-process tests against a
 * throwaway lock directory.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { StepError } = require('../lib/errors');
const { acquireProjectLock, lockPathFor } = require('../lib/lock');

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-lock-test-'));
  const root = path.join(base, 'project');
  fs.mkdirSync(root);
  return { base, root, dir: path.join(base, 'locks'), cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('a second acquire for the same project fails with LOCKED until release', () => {
  const sb = sandbox();
  try {
    const first = acquireProjectLock(sb.root, { dir: sb.dir });
    assert.throws(
      () => acquireProjectLock(sb.root, { dir: sb.dir }),
      (err) => err instanceof StepError && err.code === 'LOCKED' && /already using this project/.test(err.message) && err.details.includes(`pid ${process.pid}`),
    );
    first.release();
    const again = acquireProjectLock(sb.root, { dir: sb.dir });
    again.release();
    assert.deepEqual(fs.readdirSync(sb.dir), []);
  } finally {
    sb.cleanup();
  }
});

test('different projects do not block each other; symlinked paths share one lock', () => {
  const sb = sandbox();
  try {
    const other = path.join(sb.base, 'other');
    fs.mkdirSync(other);
    const link = path.join(sb.base, 'link');
    fs.symlinkSync(sb.root, link);
    const a = acquireProjectLock(sb.root, { dir: sb.dir });
    const b = acquireProjectLock(other, { dir: sb.dir });
    assert.equal(lockPathFor(link, { dir: sb.dir }), a.path);
    assert.throws(() => acquireProjectLock(link, { dir: sb.dir }), (err) => err.code === 'LOCKED');
    a.release();
    b.release();
  } finally {
    sb.cleanup();
  }
});

test('a stale lock from a dead process is taken over and its APPConfig state reported', () => {
  const sb = sandbox();
  try {
    const file = lockPathFor(sb.root, { dir: sb.dir });
    fs.mkdirSync(sb.dir, { recursive: true });
    const stale = { pid: 999999, hostname: os.hostname(), token: 'old', appConfig: { file: 'APPConfig.js', patchedTo: false, previous: true } };
    fs.writeFileSync(file, JSON.stringify(stale));
    const lock = acquireProjectLock(sb.root, { dir: sb.dir, isAlive: (pid) => pid !== 999999 });
    assert.equal(lock.staleOwner.pid, 999999);
    assert.deepEqual(lock.staleOwner.appConfig, stale.appConfig);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, process.pid);
    lock.release();
  } finally {
    sb.cleanup();
  }
});

test('a live owner on this host is never taken over', () => {
  const sb = sandbox();
  try {
    const file = lockPathFor(sb.root, { dir: sb.dir });
    fs.mkdirSync(sb.dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 4242, hostname: os.hostname(), token: 'x' }));
    assert.throws(() => acquireProjectLock(sb.root, { dir: sb.dir, isAlive: () => true }), (err) => err.code === 'LOCKED');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 4242, 'the other run keeps its lock');
  } finally {
    sb.cleanup();
  }
});

test('release() only removes the lock while this run still owns it', () => {
  const sb = sandbox();
  try {
    const lock = acquireProjectLock(sb.root, { dir: sb.dir });
    /* someone replaced the lock (e.g. removed it by hand and started a new run) */
    fs.writeFileSync(lock.path, JSON.stringify({ pid: 1, token: 'someone-else' }));
    lock.release();
    assert.equal(fs.existsSync(lock.path), true);
  } finally {
    sb.cleanup();
  }
});

test('update() records state in the lock file; release() is idempotent', () => {
  const sb = sandbox();
  try {
    const lock = acquireProjectLock(sb.root, { dir: sb.dir });
    lock.update({ appConfig: { file: 'x', patchedTo: true, previous: false } });
    assert.deepEqual(JSON.parse(fs.readFileSync(lock.path, 'utf8')).appConfig, { file: 'x', patchedTo: true, previous: false });
    lock.release();
    lock.release();
    assert.equal(fs.existsSync(lock.path), false);
  } finally {
    sb.cleanup();
  }
});

test('an unreadable fresh lock counts as held; an old one as abandoned', () => {
  const sb = sandbox();
  try {
    const file = lockPathFor(sb.root, { dir: sb.dir });
    fs.mkdirSync(sb.dir, { recursive: true });
    fs.writeFileSync(file, '{not json');
    assert.throws(() => acquireProjectLock(sb.root, { dir: sb.dir }), (err) => err.code === 'LOCKED');
    const later = Date.now() + 120_000;
    const lock = acquireProjectLock(sb.root, { dir: sb.dir, now: () => later });
    assert.deepEqual(lock.staleOwner, { corrupt: true });
    lock.release();
  } finally {
    sb.cleanup();
  }
});

test('stale-lock takeover race: a takeover interleaved with another never yields two holders', () => {
  const sb = sandbox();
  const realUnlink = fs.unlinkSync;
  try {
    const file = lockPathFor(sb.root, { dir: sb.dir });
    fs.mkdirSync(sb.dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, hostname: os.hostname(), token: 'old' }));
    const dead = (pid) => pid === 999999;
    let inner = null;
    /* When B is about to delete the stale lock, run A's complete takeover. */
    fs.unlinkSync = function (p) {
      if (p === file && inner === null) {
        fs.unlinkSync = realUnlink;
        try {
          inner = acquireProjectLock(sb.root, { dir: sb.dir, pid: 1111, isAlive: (pid) => !dead(pid) && pid !== 2222 });
        } catch (err) {
          inner = err;
        }
      }
      return realUnlink.apply(this, arguments);
    };
    const outer = acquireProjectLock(sb.root, { dir: sb.dir, pid: 2222, isAlive: (pid) => !dead(pid) });
    fs.unlinkSync = realUnlink;
    assert.ok(inner instanceof StepError && inner.code === 'LOCKED', 'the interleaved takeover must be refused');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 2222);
    assert.deepEqual(outer.staleOwner.pid, 999999);
    outer.release();
    assert.deepEqual(fs.readdirSync(sb.dir), [], 'lock and takeover mutex both gone');
  } finally {
    fs.unlinkSync = realUnlink;
    sb.cleanup();
  }
});

test('an abandoned takeover mutex is reported, not guessed about', () => {
  const sb = sandbox();
  try {
    const file = lockPathFor(sb.root, { dir: sb.dir });
    fs.mkdirSync(sb.dir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ pid: 999999, hostname: os.hostname(), token: 'old' }));
    fs.writeFileSync(`${file}.takeover`, '');
    assert.throws(
      () => acquireProjectLock(sb.root, { dir: sb.dir, isAlive: () => false }),
      (err) => err.code === 'LOCKED' && err.details.includes('.takeover'),
    );
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).pid, 999999, 'the stale lock was not touched');
  } finally {
    sb.cleanup();
  }
});
