/**
 * Process lifecycle: temp-path registry and ordered exit hooks.
 *
 * Every exit path of `ship` ends in process.exit() (or a natural exit), so
 * one synchronous 'exit' listener is the last line of defence that always
 * runs: it restores what the run changed, removes the temp files it created,
 * releases the project lock and only then writes the result JSON (which can
 * then report cleanup warnings and the final exit code).
 *
 *   cleanup hooks   run first, newest first (restore APPConfig, unlock, …)
 *   temp paths      removed next (only paths this process created)
 *   finalizers      run last, in order; may return a replacement exit code
 *
 * Hooks must be synchronous (Node runs 'exit' listeners synchronously) and
 * idempotent: the normal flow usually runs them earlier, the exit listener
 * only catches what is left.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/* Only directories made by fs.mkdtemp with this prefix, inside os.tmpdir(),
 * are ever removed — never user files or anything that pre-existed the run. */
const TEMP_PREFIX = 'rn-build-upload-';

const tempPaths = new Set();
const cleanupHooks = [];
const finalizers = [];
const warnings = [];
let installed = false;

function realpathOr(p) {
  try {
    return fs.realpathSync(p);
  } catch (err) {
    return path.resolve(p);
  }
}

/** True when `p` is a direct child of os.tmpdir() named with TEMP_PREFIX. */
function isOwnTempPath(p) {
  const resolved = path.resolve(p);
  if (!path.basename(resolved).startsWith(TEMP_PREFIX)) return false;
  return realpathOr(path.dirname(resolved)) === realpathOr(os.tmpdir());
}

/** mkdtemp in os.tmpdir() with the tool prefix, registered for cleanup. */
function makeTempDir(label) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `${TEMP_PREFIX}${label}-`));
  tempPaths.add(dir);
  install();
  return dir;
}

/**
 * Remove one registered temp path now. Returns null on success, or the error
 * (never thrown: a cleanup failure must not replace the build/upload error).
 */
function removeTempPath(dir) {
  if (!tempPaths.has(dir)) return null;
  tempPaths.delete(dir);
  if (!isOwnTempPath(dir)) {
    const err = new Error(`Refusing to remove ${dir}: not a temp path created by this run.`);
    warnings.push(err.message);
    return err;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  } catch (err) {
    warnings.push(`Could not remove temp directory ${dir}: ${err.message}`);
    return err;
  }
}

function cleanupTempPaths() {
  for (const dir of [...tempPaths]) removeTempPath(dir);
}

function addCleanup(fn) {
  cleanupHooks.push(fn);
  install();
}

function addFinalizer(fn) {
  finalizers.push(fn);
  install();
}

/** Non-fatal problems seen during cleanup (reported in the result JSON). */
function cleanupWarnings() {
  return [...warnings];
}

function runExitHooks(code) {
  while (cleanupHooks.length > 0) {
    const fn = cleanupHooks.pop();
    try {
      fn();
    } catch (err) {
      warnings.push(`Cleanup step failed: ${err.message}`);
    }
  }
  cleanupTempPaths();
  let exitCode = code;
  while (finalizers.length > 0) {
    const fn = finalizers.shift();
    try {
      const next = fn(exitCode);
      if (Number.isInteger(next)) exitCode = next;
    } catch (err) {
      /* a finalizer must never turn into an uncaught exception at exit */
      try {
        process.stderr.write(`ship: finalizer failed: ${err.message}\n`);
      } catch (writeErr) {
        /* stderr gone */
      }
    }
  }
  return exitCode;
}

function install() {
  if (installed) return;
  installed = true;
  process.on('exit', (code) => {
    const next = runExitHooks(code);
    if (next !== code) process.exitCode = next;
  });
}

/** Test helper: forget all registered state (does not touch the filesystem). */
function resetForTests() {
  tempPaths.clear();
  cleanupHooks.length = 0;
  finalizers.length = 0;
  warnings.length = 0;
}

module.exports = {
  TEMP_PREFIX,
  makeTempDir,
  removeTempPath,
  cleanupTempPaths,
  isOwnTempPath,
  addCleanup,
  addFinalizer,
  cleanupWarnings,
  runExitHooks,
  resetForTests,
};
