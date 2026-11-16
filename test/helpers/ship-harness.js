/**
 * Test harness: runs the real `ship` entry point (bin/rn-build-upload.js)
 * with every upload provider replaced by an in-process stub, so spawn-level
 * tests exercise real argument parsing, locking, APPConfig patching, exit
 * codes, signals and --output-json without any network access.
 *
 *   SHIP_TEST_UPLOAD        success (default) | fail | hang (until cancelled)
 *   SHIP_TEST_UPLOAD_CALLS  append one JSON line per upload call to this file
 *   SHIP_TEST_SLOW_HASH     see below
 */

const fs = require('node:fs');
const path = require('node:path');

/* SHIP_TEST_SLOW_HASH=<marker>: the checksum step touches <marker> and then
 * takes 2s, giving tests a deterministic window to cancel in. Patched before
 * lib/build-upload.js is loaded (it destructures sha256File at load time). */
if (process.env.SHIP_TEST_SLOW_HASH) {
  const result = require('../../lib/result');
  const realSha = result.sha256File;
  result.sha256File = async (file) => {
    fs.writeFileSync(process.env.SHIP_TEST_SLOW_HASH, '');
    await new Promise((r) => setTimeout(r, 2000));
    return realSha(file);
  };
}

const core = require('../../lib/build-upload');
const { StepError } = require('../../lib/errors');

const mode = process.env.SHIP_TEST_UPLOAD || 'success';
const callsFile = process.env.SHIP_TEST_UPLOAD_CALLS;

for (const [key, provider] of Object.entries(core.PROVIDERS)) {
  provider.upload = async (profile, filePath, name, notes, opts = {}) => {
    if (callsFile) {
      fs.appendFileSync(callsFile, `${JSON.stringify({ provider: key, file: path.basename(filePath), existed: fs.existsSync(filePath), ci: Boolean(opts.ci) })}\n`);
    }
    if (mode === 'fail') {
      throw new StepError('Upload failed.', { code: 'UPLOAD_FAILED', details: 'mocked provider failure' });
    }
    if (mode === 'hang') {
      await new Promise((resolve, reject) => {
        const cancel = () => {
          const err = new StepError('Operation cancelled.');
          err.cancelled = true;
          reject(err);
        };
        if (opts.signal && opts.signal.aborted) cancel();
        else if (opts.signal) opts.signal.addEventListener('abort', cancel, { once: true });
      });
    }
    return { url: `https://install.example.test/${key}/${path.basename(filePath)}`, adminUrl: null, timing: null };
  };
}

require('../../bin/rn-build-upload.js');
