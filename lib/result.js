/**
 * Machine-readable run result for --output-json <path>.
 *
 * The schema is documented in README.md ("CI result JSON"); bump
 * SCHEMA_VERSION on any incompatible change. Rules the recorder enforces:
 *
 *   - outcome is "success" only when the process exits 0 AND every selected
 *     platform was built, verified and uploaded with an install URL;
 *   - a platform's artifactUrl is set only after its upload returned one;
 *   - nothing secret goes in: no environment dump, no tokens, no provider
 *     output (error messages pass through the provider sanitizer), and no
 *     ShareIPA admin link (it grants management of the upload);
 *   - the file is written atomically (temp file in the same directory, then
 *     rename), so readers see the complete JSON or nothing. A stale file at
 *     the path is removed when the run starts.
 */

const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { sanitize } = require('./providers/shareipa');

const SCHEMA_VERSION = 1;

/* Default error code per phase, when the thrown error carries none. */
const PHASE_CODES = {
  args: 'USAGE',
  detect: 'PROJECT_NOT_FOUND',
  platform: 'PLATFORM_UNAVAILABLE',
  lock: 'LOCK_FAILED',
  preflight: 'UPLOAD_AUTH_FAILED',
  version: 'PROJECT_SETTINGS_FAILED',
  env: 'ENV_CONFIG_INVALID',
  build: 'BUILD_FAILED',
  artifact: 'ARTIFACT_INVALID',
  upload: 'UPLOAD_FAILED',
};

const ENV_KEYS = { '--uat': 'uat', '--prod': 'prod' };

function toolVersion() {
  try {
    return require('../package.json').version;
  } catch (err) {
    return null;
  }
}

/** HEAD SHA and dirty flag of the project's git checkout; nulls when unknown. */
function readGitInfo(root, { spawn = spawnSync } = {}) {
  const git = (args) => spawn('git', ['-C', root, ...args], { encoding: 'utf8', timeout: 10_000 });
  const head = git(['rev-parse', '--verify', 'HEAD']);
  if (head.error || head.status !== 0) return { commitSha: null, workingTreeDirty: null };
  const sha = String(head.stdout || '').trim();
  if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha)) return { commitSha: null, workingTreeDirty: null };
  const status = git(['status', '--porcelain']);
  const dirty = status.error || status.status !== 0 ? null : String(status.stdout || '').trim() !== '';
  return { commitSha: sha, workingTreeDirty: dirty };
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

/**
 * Write `data` as JSON to `file` atomically. Throws on failure after removing
 * its own temp file; never leaves a partial file at `file`.
 */
function writeJsonAtomic(file, data, { fsImpl = fs } = {}) {
  const text = `${JSON.stringify(data, null, 2)}\n`;
  JSON.parse(text); /* guard: only ever write what parses back */
  const dir = path.dirname(path.resolve(file));
  const tmp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  let fd = null;
  try {
    fd = fsImpl.openSync(tmp, 'wx', 0o644);
    fsImpl.writeSync(fd, text);
    fsImpl.fsyncSync(fd);
    fsImpl.closeSync(fd);
    fd = null;
    fsImpl.renameSync(tmp, file);
  } catch (err) {
    if (fd !== null) {
      try {
        fsImpl.closeSync(fd);
      } catch (closeErr) {
        /* ignore */
      }
    }
    try {
      fsImpl.unlinkSync(tmp);
    } catch (unlinkErr) {
      /* never created */
    }
    throw err;
  }
}

/**
 * Validate the --output-json target before any work starts and remove a
 * stale result from an earlier run. Throws a usage StepError-shaped Error.
 */
function prepareOutputPath(file) {
  const resolved = path.resolve(file);
  const dir = path.dirname(resolved);
  let stat = null;
  try {
    stat = fs.statSync(resolved);
  } catch (err) {
    /* does not exist yet: fine */
  }
  if (stat && !stat.isFile()) {
    throw new Error(`--output-json path is not a regular file: ${resolved}`);
  }
  try {
    if (!fs.statSync(dir).isDirectory()) throw new Error('not a directory');
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (err) {
    throw new Error(`--output-json directory is missing or not writable: ${dir}`);
  }
  if (stat) fs.unlinkSync(resolved);
  return resolved;
}

/* The documented error codes (README "CI result JSON"). Anything else — e.g.
 * a raw Node error code such as ENOENT — is mapped to the phase's code. */
const KNOWN_CODES = new Set([
  ...Object.values(PHASE_CODES),
  'LOCKED',
  'ARTIFACT_NOT_FOUND',
  'APK_UNSIGNED',
  'APK_SIGNATURE_INVALID',
  'APK_VERIFY_UNAVAILABLE',
  'UPLOAD_NO_URL',
  'CANCELLED',
  'INCOMPLETE',
  'INTERNAL',
]);

function errorInfo(err, phase, platform) {
  if (!err) return null;
  const code = err.cancelled ? 'CANCELLED' : KNOWN_CODES.has(err.code) ? err.code : PHASE_CODES[phase] || 'INTERNAL';
  return {
    code,
    message: sanitize(err.message || String(err), { limit: 300 }),
    phase: phase || null,
    platform: platform || null,
  };
}

/**
 * Accumulates the result in memory. `enabled` is false without
 * --output-json; callers use it to skip optional work (git, sha256).
 */
function createRecorder({ outputPath = null, now = Date.now } = {}) {
  const startedAt = now();
  const state = {
    project: null,
    request: { platforms: null, environment: null, provider: null, ci: false, expiresInDays: null },
    platforms: new Map(),
    outcome: 'pending',
    error: null,
    warnings: [],
  };

  function platform(key) {
    if (!state.platforms.has(key)) {
      state.platforms.set(key, {
        platform: key,
        status: 'pending',
        version: null,
        artifact: null,
        artifactUrl: null,
        durations: { buildMs: null, uploadMs: null },
        error: null,
      });
    }
    return state.platforms.get(key);
  }

  const recorder = {
    enabled: Boolean(outputPath),
    outputPath,
    setProject(project) {
      state.project = project;
    },
    setRequest(request) {
      state.request = { ...state.request, ...request };
      for (const key of request.platforms || []) platform(key);
    },
    setEnvironment(envName) {
      state.request.environment = ENV_KEYS[envName] || null;
    },
    setVersion(key, version) {
      platform(key).version = version ? { name: String(version.versionName), code: String(version.versionCode) } : null;
    },
    buildDone(key, ms) {
      platform(key).durations.buildMs = ms;
    },
    setArtifact(key, artifact) {
      platform(key).artifact = artifact;
    },
    uploadDone(key, { url, ms }) {
      const p = platform(key);
      p.durations.uploadMs = ms;
      p.artifactUrl = url;
      p.status = 'success';
    },
    /** Record a failure; the first one becomes the top-level error. */
    fail(err, { phase = null, platform: key = null } = {}) {
      const info = errorInfo(err, phase, key);
      if (key) {
        const p = platform(key);
        p.status = err && err.cancelled ? 'cancelled' : 'failure';
        p.error = info;
      }
      if (!state.error) state.error = info;
      state.outcome = err && err.cancelled ? 'cancelled' : 'failure';
    },
    cancel() {
      if (state.outcome !== 'failure') state.outcome = 'cancelled';
      if (!state.error) state.error = { code: 'CANCELLED', message: 'Operation cancelled.', phase: null, platform: null };
    },
    succeed() {
      if (state.outcome === 'pending') state.outcome = 'success';
    },
    warn(message) {
      state.warnings.push(sanitize(message, { limit: 300 }));
    },
    /** The final document for `exitCode`; success is downgraded if inconsistent. */
    toJSON(exitCode, { extraWarnings = [] } = {}) {
      const platforms = [...state.platforms.values()].map((p) => ({
        ...p,
        status: p.status === 'pending' ? (state.outcome === 'cancelled' ? 'cancelled' : 'skipped') : p.status,
      }));
      let outcome = state.outcome;
      let error = state.error;
      const complete = platforms.length > 0 && platforms.every((p) => p.status === 'success' && p.artifactUrl);
      if (outcome === 'success' && (exitCode !== 0 || !complete)) {
        outcome = 'failure';
        error = { code: exitCode !== 0 ? 'INTERNAL' : 'INCOMPLETE', message: 'The run did not finish every selected platform.', phase: null, platform: null };
      }
      if (outcome === 'pending') {
        outcome = exitCode === 130 ? 'cancelled' : 'failure';
        error = error || { code: exitCode === 130 ? 'CANCELLED' : 'INCOMPLETE', message: 'The run ended before reporting a result.', phase: null, platform: null };
      }
      const finishedAt = now();
      return {
        schemaVersion: SCHEMA_VERSION,
        tool: { name: 'rn-build-upload', version: toolVersion() },
        outcome,
        exitCode,
        error: outcome === 'success' ? null : error,
        project: state.project,
        request: state.request,
        startedAt: new Date(startedAt).toISOString(),
        finishedAt: new Date(finishedAt).toISOString(),
        durationMs: finishedAt - startedAt,
        platforms,
        warnings: [...state.warnings, ...extraWarnings.map((w) => sanitize(w, { limit: 300 }))],
      };
    },
    /**
     * Write the result; returns the exit code the process should use
     * (EXIT_RESULT_WRITE when an otherwise successful run cannot report).
     */
    write(exitCode, { extraWarnings = [], writeFailedCode = 4, stderr = process.stderr, fsImpl = fs } = {}) {
      if (!outputPath) return exitCode;
      const doc = recorder.toJSON(exitCode, { extraWarnings });
      if (doc.outcome !== 'success' && exitCode === 0) {
        doc.exitCode = 1;
      }
      try {
        writeJsonAtomic(outputPath, doc, { fsImpl });
      } catch (err) {
        try {
          stderr.write(`ship: could not write --output-json ${outputPath}: ${err.message}\n`);
        } catch (writeErr) {
          /* stderr gone */
        }
        return exitCode === 0 ? writeFailedCode : exitCode;
      }
      return doc.exitCode;
    },
  };
  return recorder;
}

module.exports = {
  SCHEMA_VERSION,
  PHASE_CODES,
  KNOWN_CODES,
  createRecorder,
  writeJsonAtomic,
  prepareOutputPath,
  readGitInfo,
  sha256File,
  toolVersion,
  errorInfo,
};
