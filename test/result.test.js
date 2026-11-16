/**
 * --output-json result recorder and atomic writer (unit tests, no I/O
 * outside throwaway temp directories).
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { StepError } = require('../lib/errors');
const { SCHEMA_VERSION, createRecorder, writeJsonAtomic, prepareOutputPath, readGitInfo, errorInfo } = require('../lib/result');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ship-result-test-'));
}

function successfulRecorder(outputPath) {
  const rec = createRecorder({ outputPath });
  rec.setProject({ name: 'DemoApp', root: '/tmp/demo', commitSha: 'a'.repeat(40), workingTreeDirty: false });
  rec.setRequest({ platforms: ['android'], provider: 'shareipa', ci: true });
  rec.setEnvironment('--uat');
  rec.setVersion('android', { versionName: '8.9', versionCode: 199 });
  rec.buildDone('android', 1200);
  rec.setArtifact('android', { name: 'app-release.apk', sizeBytes: 10, sha256: 'b'.repeat(64), signature: { verified: true, schemes: ['v2'] } });
  rec.uploadDone('android', { url: 'https://install.example.test/X', ms: 300 });
  rec.succeed();
  return rec;
}

test('successful run serializes the documented fields', () => {
  const doc = successfulRecorder('/unused.json').toJSON(0);
  assert.equal(doc.schemaVersion, SCHEMA_VERSION);
  assert.equal(doc.tool.name, 'rn-build-upload');
  assert.equal(doc.tool.version, require('../package.json').version);
  assert.equal(doc.outcome, 'success');
  assert.equal(doc.exitCode, 0);
  assert.equal(doc.error, null);
  assert.deepEqual(doc.project, { name: 'DemoApp', root: '/tmp/demo', commitSha: 'a'.repeat(40), workingTreeDirty: false });
  assert.deepEqual(doc.request, { platforms: ['android'], environment: 'uat', provider: 'shareipa', ci: true, expiresInDays: null });
  assert.equal(doc.platforms.length, 1);
  const [android] = doc.platforms;
  assert.equal(android.status, 'success');
  assert.deepEqual(android.version, { name: '8.9', code: '199' });
  assert.equal(android.artifact.sha256, 'b'.repeat(64));
  assert.equal(android.artifactUrl, 'https://install.example.test/X');
  assert.deepEqual(android.durations, { buildMs: 1200, uploadMs: 300 });
  assert.equal(android.adminUrl, undefined, 'the ShareIPA admin link is never reported');
  assert.ok(Date.parse(doc.startedAt) <= Date.parse(doc.finishedAt));
  assert.equal(typeof doc.durationMs, 'number');
  /* round-trips as JSON */
  assert.deepEqual(JSON.parse(JSON.stringify(doc)), doc);
});

test('failure output carries an error code and no install URL', () => {
  const rec = createRecorder({ outputPath: '/unused.json' });
  rec.setRequest({ platforms: ['android'], provider: 'shareipa', ci: true });
  rec.buildDone('android', 10);
  rec.fail(new StepError('Upload failed.', { code: 'UPLOAD_FAILED' }), { phase: 'upload', platform: 'android' });
  const doc = rec.toJSON(1);
  assert.equal(doc.outcome, 'failure');
  assert.equal(doc.exitCode, 1);
  assert.deepEqual(doc.error, { code: 'UPLOAD_FAILED', message: 'Upload failed.', phase: 'upload', platform: 'android' });
  assert.equal(doc.platforms[0].status, 'failure');
  assert.equal(doc.platforms[0].artifactUrl, null);
});

test('phase supplies the error code when the error has none', () => {
  assert.equal(errorInfo(new Error('boom'), 'build', 'ios').code, 'BUILD_FAILED');
  assert.equal(errorInfo(new StepError('x', { usage: true }), 'env').code, 'USAGE');
  const cancelled = Object.assign(new StepError('Operation cancelled.'), { cancelled: true });
  assert.equal(errorInfo(cancelled, 'upload').code, 'CANCELLED');
  assert.equal(errorInfo(new Error('?'), null).code, 'INTERNAL');
  /* raw Node error codes are not part of the documented contract */
  assert.equal(errorInfo(Object.assign(new Error('x'), { code: 'ENOENT' }), 'upload').code, 'UPLOAD_FAILED');
  assert.equal(errorInfo(Object.assign(new Error('x'), { code: 'ABORT_ERR' }), null).code, 'INTERNAL');
});

test('success is never reported for a non-zero exit or an unfinished platform', () => {
  const nonZero = successfulRecorder('/unused.json').toJSON(1);
  assert.equal(nonZero.outcome, 'failure');
  assert.equal(nonZero.error.code, 'INTERNAL');

  const rec = createRecorder({ outputPath: '/unused.json' });
  rec.setRequest({ platforms: ['android', 'ios'], provider: 'shareipa', ci: true });
  rec.uploadDone('android', { url: 'https://install.example.test/A', ms: 1 });
  rec.succeed(); /* claims success although iOS never ran */
  const doc = rec.toJSON(0);
  assert.equal(doc.outcome, 'failure');
  assert.equal(doc.error.code, 'INCOMPLETE');
  assert.equal(doc.platforms.find((p) => p.platform === 'ios').status, 'skipped');
  assert.equal(doc.platforms.find((p) => p.platform === 'ios').artifactUrl, null);
  /* the platform that really uploaded keeps its link */
  assert.equal(doc.platforms.find((p) => p.platform === 'android').artifactUrl, 'https://install.example.test/A');
});

test('missing fields serialize as null rather than being guessed', () => {
  const rec = createRecorder({ outputPath: '/unused.json' });
  const doc = rec.toJSON(2);
  assert.equal(doc.outcome, 'failure');
  assert.equal(doc.project, null);
  assert.equal(doc.request.environment, null);
  assert.deepEqual(doc.platforms, []);
  assert.equal(doc.error.code, 'INCOMPLETE');

  const cancelled = createRecorder({ outputPath: '/unused.json' }).toJSON(130);
  assert.equal(cancelled.outcome, 'cancelled');
  assert.equal(cancelled.error.code, 'CANCELLED');
});

test('error messages are sanitized and no environment is dumped', () => {
  const rec = createRecorder({ outputPath: '/unused.json' });
  const token = 'eyJhbGciOiJIUzUxMiJ9.eyJ1aWQiOjAsIm10ZCI6e30xx.c2lnbmF0dXJlc2ln';
  rec.fail(new StepError(`Upload failed with Authorization: Bearer ${token}`), { phase: 'upload' });
  const text = JSON.stringify(rec.toJSON(1));
  assert.ok(!text.includes(token), text);
  assert.ok(!text.includes(process.env.PATH || '\u0000'), 'PATH must not appear');
  assert.ok(!/BETADROP_TOKEN|ANDROID_HOME/.test(text));
});

test('write() writes valid JSON atomically and reports the exit code', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'result.json');
    const rec = successfulRecorder(file);
    assert.equal(rec.write(0), 0);
    const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(doc.outcome, 'success');
    assert.deepEqual(fs.readdirSync(dir), ['result.json'], 'no temp files left behind');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('write() exits 1 instead of 0 when the outcome is not success', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'result.json');
    const rec = createRecorder({ outputPath: file });
    rec.setRequest({ platforms: ['android'] });
    assert.equal(rec.write(0), 1);
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).exitCode, 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a failed write leaves no partial file and turns success into a non-zero exit', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'result.json');
    const stderr = { text: '', write(t) { this.text += t; } };
    /* rename fails after the temp file was written */
    const fsImpl = { ...fs, renameSync() { throw Object.assign(new Error('EIO: simulated'), { code: 'EIO' }); } };
    const rec = successfulRecorder(file);
    assert.equal(rec.write(0, { fsImpl, stderr, writeFailedCode: 4 }), 4);
    assert.deepEqual(fs.readdirSync(dir), [], 'neither the result nor a temp file may remain');
    assert.match(stderr.text, /could not write --output-json/);

    /* a failure exit code is preserved, not replaced */
    assert.equal(rec.write(1, { fsImpl, stderr }), 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('writeJsonAtomic fails cleanly when the directory does not exist', () => {
  const dir = tmpDir();
  try {
    assert.throws(() => writeJsonAtomic(path.join(dir, 'missing', 'r.json'), { a: 1 }), /ENOENT/);
    assert.deepEqual(fs.readdirSync(dir), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('prepareOutputPath removes a stale result and rejects unusable paths', () => {
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'result.json');
    fs.writeFileSync(file, '{"outcome":"success"}');
    assert.equal(prepareOutputPath(file), file);
    assert.equal(fs.existsSync(file), false, 'stale success from an earlier run is removed up front');

    assert.throws(() => prepareOutputPath(dir), /not a regular file/);
    assert.throws(() => prepareOutputPath(path.join(dir, 'nope', 'r.json')), /missing or not writable/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('readGitInfo returns nulls outside a git checkout and validates the SHA', () => {
  const dir = tmpDir();
  try {
    assert.deepEqual(readGitInfo(dir), { commitSha: null, workingTreeDirty: null });
    const fake = (out) => () => ({ status: 0, stdout: out });
    assert.deepEqual(readGitInfo(dir, { spawn: fake('not-a-sha\n') }), { commitSha: null, workingTreeDirty: null });
    const calls = [];
    const spawn = (cmd, args) => {
      calls.push(args.slice(2).join(' '));
      return args.includes('rev-parse') ? { status: 0, stdout: `${'c'.repeat(40)}\n` } : { status: 0, stdout: ' M src/x.js\n' };
    };
    assert.deepEqual(readGitInfo(dir, { spawn }), { commitSha: 'c'.repeat(40), workingTreeDirty: true });
    assert.deepEqual(calls, ['rev-parse --verify HEAD', 'status --porcelain']);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
