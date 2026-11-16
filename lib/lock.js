/**
 * Exclusive per-project lock for the whole build/upload lifecycle.
 *
 * `ship` builds in the caller's checkout and patches src/Helper/APPConfig.js
 * in place, so two runs in the same project would race on that file and on
 * android/app/build. The lock makes the second run fail fast instead.
 *
 * The lock is a file created with O_EXCL ('wx') under
 *   $TMPDIR/rn-build-upload-locks/<sha256(realpath(project root))>.lock
 * so nothing is written into the checkout. It holds JSON: owner pid, host,
 * start time, a random token and (while patched) the APPConfig state.
 *
 * A lock whose owner pid is gone on this host (e.g. after SIGKILL) is stale
 * and is taken over (serialised by an O_EXCL <lock>.takeover mutex, see
 * acquireProjectLock); the previous owner's APPConfig state is returned so
 * the caller can warn that the file may still be patched. Release only
 * removes the file while it still carries this run's token.
 *
 * Scope: the lock lives in $TMPDIR, so it only coordinates runs that share
 * the same TMPDIR (normally: the same macOS user).
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StepError } = require('./errors');

/* An unreadable lock this old is treated as abandoned (a live owner writes
 * its JSON immediately after creating the file). */
const CORRUPT_LOCK_GRACE_MS = 60_000;

function defaultLockDir() {
  return path.join(os.tmpdir(), 'rn-build-upload-locks');
}

function lockPathFor(root, { dir = defaultLockDir() } = {}) {
  let real;
  try {
    real = fs.realpathSync(root);
  } catch (err) {
    real = path.resolve(root);
  }
  const digest = crypto.createHash('sha256').update(real).digest('hex').slice(0, 32);
  return path.join(dir, `${digest}.lock`);
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

function readLock(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { missing: true };
    return { corrupt: true };
  }
  try {
    return { info: JSON.parse(text), text };
  } catch (err) {
    return { corrupt: true, text };
  }
}

function isStale(file, current, { isAlive, hostname, now }) {
  if (current.corrupt) {
    try {
      return now() - fs.statSync(file).mtimeMs > CORRUPT_LOCK_GRACE_MS;
    } catch (err) {
      return false;
    }
  }
  const info = current.info || {};
  if (info.hostname && info.hostname !== hostname) return false;
  return !isAlive(info.pid);
}

function lockedError(file, info) {
  const owner = info && info.pid ? `pid ${info.pid}${info.startedAt ? `, started ${info.startedAt}` : ''}` : 'another process';
  return new StepError('Another ship run is already using this project.', {
    code: 'LOCKED',
    details: `This checkout is locked by ${owner}.\nLock file: ${file}\nTwo runs in one checkout would overwrite each other's APPConfig.js and build outputs.`,
    hint: 'Wait for the other run to finish (or cancel it). If no ship process is running, remove the lock file above and retry.',
  });
}

/**
 * Acquire the lock or throw StepError(code LOCKED).
 * Returns { path, staleOwner, update(fields), release() }.
 */
function acquireProjectLock(root, { dir = defaultLockDir(), pid = process.pid, hostname = os.hostname(), isAlive = pidAlive, now = Date.now } = {}) {
  const file = lockPathFor(root, { dir });
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const token = crypto.randomBytes(16).toString('hex');
  const base = { pid, hostname, token, root: path.resolve(root), startedAt: new Date(now()).toISOString() };
  const create = (staleOwner) => {
    const fd = fs.openSync(file, 'wx', 0o600);
    try {
      fs.writeSync(fd, JSON.stringify(base));
    } finally {
      fs.closeSync(fd);
    }
    return makeHandle(file, base, staleOwner);
  };
  const createOrNull = (staleOwner) => {
    try {
      return create(staleOwner);
    } catch (err) {
      if (err.code === 'EEXIST') return null;
      throw new StepError('Could not create the project lock.', {
        code: 'LOCK_FAILED',
        details: `${file}: ${err.message}`,
      });
    }
  };

  /* Fast path: plain O_EXCL create. It never deletes anything, so it can
   * never remove another run's lock. */
  const fresh = createOrNull(null);
  if (fresh) return fresh;

  const current = readLock(file);
  if (!current.missing && !isStale(file, current, { isAlive, hostname, now })) {
    throw lockedError(file, current.info);
  }

  /* Takeover of a stale (or vanished) lock. Deleting is only ever done while
   * holding the exclusive <lock>.takeover mutex, and the stale verdict is
   * re-checked under it, so two runs can never both delete-and-recreate (the
   * second sees the first one's live lock). A mutex left behind by a run
   * killed inside this tiny window is not guessed about: the caller is told
   * to remove it. */
  const mutex = `${file}.takeover`;
  let mutexFd;
  try {
    mutexFd = fs.openSync(mutex, 'wx', 0o600);
  } catch (err) {
    if (err.code !== 'EEXIST') {
      throw new StepError('Could not create the project lock.', { code: 'LOCK_FAILED', details: `${mutex}: ${err.message}` });
    }
    const error = lockedError(file, current.info);
    error.details += `\nAnother run is taking over a stale lock right now (${mutex}).`;
    throw error;
  }
  try {
    const again = readLock(file);
    if (again.missing) {
      const handle = createOrNull(null);
      if (handle) return handle;
      throw lockedError(file, readLock(file).info);
    }
    if (!isStale(file, again, { isAlive, hostname, now })) throw lockedError(file, again.info);
    try {
      fs.unlinkSync(file);
    } catch (err) {
      if (err.code !== 'ENOENT') throw lockedError(file, again.info);
    }
    const handle = createOrNull(again.info || { corrupt: true });
    if (handle) return handle;
    throw lockedError(file, readLock(file).info);
  } finally {
    fs.closeSync(mutexFd);
    try {
      fs.unlinkSync(mutex);
    } catch (err) {
      /* already gone */
    }
  }
}

function makeHandle(file, base, staleOwner) {
  let state = { ...base };
  let released = false;
  const ownsFile = () => {
    const current = readLock(file);
    return Boolean(current.info && current.info.token === base.token);
  };
  return {
    path: file,
    staleOwner,
    /** Merge fields into the lock JSON (e.g. the APPConfig patch state). */
    update(fields) {
      if (released || !ownsFile()) return;
      state = { ...state, ...fields };
      fs.writeFileSync(file, JSON.stringify(state), { mode: 0o600 });
    },
    release() {
      if (released) return;
      released = true;
      if (!ownsFile()) return;
      try {
        fs.unlinkSync(file);
      } catch (err) {
        /* already gone */
      }
    },
  };
}

module.exports = { acquireProjectLock, lockPathFor, defaultLockDir, pidAlive };
