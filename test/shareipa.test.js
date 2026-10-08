/**
 * ShareIPA provider — unit tests.
 *
 * Everything is mocked: fetch is replaced with an in-process fake and the
 * presigned-PUT tests run against a throwaway 127.0.0.1 HTTP server. No test
 * in this file touches api.shareipa.com or the object store.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { StepError } = require('../lib/errors');
const {
  fileTypeFor,
  installUrlFor,
  adminUrlFor,
  sanitize,
  getSignedUrl,
  uploadFileToPresignedUrl,
  buildSavePayload,
  saveApp,
  uploadToShareIPA,
} = require('../lib/providers/shareipa');

/* ---------------------------------------------------------------- */
/* Fixtures                                                          */
/* ---------------------------------------------------------------- */

const API_BASE = 'https://api.example.test/website/api/v1';
const TOKEN = 'eyJhbGciOiJIUzUxMiJ9.eyJ1aWQiOjAsIm10ZCI6eyJhcHBfdXVpZCI6ImFiYzEyMyJ9fQ.c2lnbmF0dXJl';
const BROWSER_ID = '11111111-2222-3333-4444-555555555555';
const PRESIGNED_URL =
  'https://storage.example.test/shareIPA-prod/application/abc123/file.apk' +
  '?X-Amz-Algorithm=AWS4-HMAC-SHA256' +
  '&X-Amz-Credential=EXAMPLEKEY%2F20261005%2Fin-maa-1%2Fs3%2Faws4_request' +
  '&X-Amz-Date=20261005T062717Z&X-Amz-Expires=900&X-Amz-SignedHeaders=host' +
  '&X-Amz-Signature=0123456789abcdef';

const SIGNED_BODY = {
  s3Url: PRESIGNED_URL,
  uuid: 'abc123',
  filePath: 'shareIPA-prod/application/abc123/file.apk',
  fileType: 'apk',
  appData: {
    id: 0,
    passwordProtected: false,
    validTill: '0001-01-01T00:00:00Z',
    createdAt: '0001-01-01T00:00:00Z',
  },
  deviceInfo: { device: '', deviceType: '', os: '', ipAddr: '' },
};

function fakeResponse(status, body, headers = {}) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (name) => lower[String(name).toLowerCase()] ?? null },
    text: async () => text,
  };
}

/** fetch stub that replies from a queue/script and records every call. */
function fakeFetch(script) {
  const calls = [];
  const impl = async (url, options = {}) => {
    calls.push({ url, options });
    const next = script.shift();
    if (!next) throw new Error(`fakeFetch: unexpected call to ${url}`);
    if (next instanceof Error) throw next;
    return next;
  };
  impl.calls = calls;
  return impl;
}

function signedOk() {
  return fakeResponse(200, SIGNED_BODY, { token: TOKEN, 'browser-id': BROWSER_ID });
}

function tempFile(name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-shareipa-test-'));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}

/** One-shot local HTTP server: returns { url, close, requests }. */
function localServer(handler) {
  return new Promise((resolve) => {
    const requests = [];
    const server = http.createServer((req, res) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        requests.push({
          method: req.method,
          url: req.url,
          headers: req.headers,
          body: Buffer.concat(chunks),
        });
        handler(req, res);
      });
    });
    server.listen(0, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${server.address().port}`,
        requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

/* ---------------------------------------------------------------- */
/* File type / URL helpers                                           */
/* ---------------------------------------------------------------- */

test('fileTypeFor maps .apk/.ipa (case-insensitive) and rejects others', () => {
  assert.equal(fileTypeFor('/tmp/app-release.apk'), 'apk');
  assert.equal(fileTypeFor('/tmp/AlfaPTE.IPA'), 'ipa');
  assert.throws(() => fileTypeFor('/tmp/app.zip'), (err) => err instanceof StepError && /cannot upload this file type/i.test(err.message));
});

test('installUrlFor/adminUrlFor build the website links', () => {
  assert.equal(installUrlFor('ExAmP1'), 'https://install.shareipa.com/ExAmP1');
  assert.equal(adminUrlFor('AdMiN1'), 'https://dashboard.shareipa.com/admin/AdMiN1');
  assert.equal(installUrlFor('a b'), 'https://install.shareipa.com/a%20b');
});

test('sanitize strips JWTs, presigned parameters and storage URLs', () => {
  const dirty = `Authorization: Bearer ${TOKEN} PUT ${PRESIGNED_URL} failed`;
  const clean = sanitize(dirty);
  assert.ok(!clean.includes(TOKEN), 'JWT leaked');
  assert.ok(!clean.includes('X-Amz-Signature=0123456789abcdef'), 'signature leaked');
  assert.ok(!clean.includes('storage.example.test'), 'presigned URL leaked');
  assert.equal(clean, 'Authorization: Bearer <redacted> PUT <presigned-url> failed');
});

/* ---------------------------------------------------------------- */
/* getSignedUrl                                                      */
/* ---------------------------------------------------------------- */

test('getSignedUrl parses the response and keeps token/browser-id out of the body', async () => {
  const fetchImpl = fakeFetch([signedOk()]);
  const signed = await getSignedUrl({ fetchImpl, apiBase: API_BASE, fileType: 'apk' });

  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].url, `${API_BASE}/app/getSignedUrl?fileType=apk`);
  assert.equal(fetchImpl.calls[0].options.method, undefined, 'getSignedUrl must be a GET');
  assert.equal(signed.s3Url, PRESIGNED_URL);
  assert.equal(signed.uuid, 'abc123');
  assert.equal(signed.filePath, SIGNED_BODY.filePath);
  assert.equal(signed.fileType, 'apk');
  assert.equal(signed.token, TOKEN);
  assert.equal(signed.browserId, BROWSER_ID);
});

test('getSignedUrl falls back to a random browser id when the header is absent', async () => {
  const fetchImpl = fakeFetch([fakeResponse(200, SIGNED_BODY, { token: TOKEN })]);
  const signed = await getSignedUrl({ fetchImpl, apiBase: API_BASE, fileType: 'ipa' });
  assert.match(signed.browserId, /^[0-9a-f-]{36}$/);
});

test('getSignedUrl surfaces the API error message on non-2xx', async () => {
  const fetchImpl = fakeFetch([fakeResponse(400, { code: 4, msg: 'invalid file type' })]);
  await assert.rejects(
    () => getSignedUrl({ fetchImpl, apiBase: API_BASE, fileType: 'apk' }),
    (err) =>
      err instanceof StepError &&
      /could not prepare the upload/i.test(err.message) &&
      /HTTP 400/.test(err.details) &&
      /invalid file type/.test(err.details),
  );
});

test('getSignedUrl reports called-out failures for malformed responses', async () => {
  for (const [body, field] of [
    [{ ...SIGNED_BODY, s3Url: undefined }, 's3Url'],
    [{ ...SIGNED_BODY, uuid: undefined }, 'uuid'],
    [{ ...SIGNED_BODY, filePath: undefined }, 'filePath'],
  ]) {
    const fetchImpl = fakeFetch([fakeResponse(200, body, { token: TOKEN })]);
    await assert.rejects(
      () => getSignedUrl({ fetchImpl, apiBase: API_BASE, fileType: 'apk' }),
      (err) => err instanceof StepError && err.details.includes(field),
    );
  }
  const noToken = fakeFetch([fakeResponse(200, SIGNED_BODY)]);
  await assert.rejects(
    () => getSignedUrl({ fetchImpl: noToken, apiBase: API_BASE, fileType: 'apk' }),
    (err) => err instanceof StepError && /token/.test(err.details),
  );
});

test('getSignedUrl maps network failures to a clear StepError', async () => {
  const fetchImpl = fakeFetch([new Error('getaddrinfo ENOTFOUND api.shareipa.com')]);
  await assert.rejects(
    () => getSignedUrl({ fetchImpl, apiBase: API_BASE, fileType: 'apk' }),
    (err) => err instanceof StepError && /could not reach the shareipa api/i.test(err.message),
  );
});

/* ---------------------------------------------------------------- */
/* Presigned upload                                                  */
/* ---------------------------------------------------------------- */

test('uploadFileToPresignedUrl PUTs the exact bytes and reports real progress', async () => {
  const bytes = Buffer.alloc(256 * 1024, 7);
  const file = tempFile('app-release.apk', bytes);
  const server = await localServer((req, res) => {
    res.writeHead(200);
    res.end();
  });
  try {
    const events = [];
    const result = await uploadFileToPresignedUrl(file, `${server.url}/put/here?X-Amz-Signature=x`, {
      onProgress: (event) => events.push(event),
    });

    assert.equal(server.requests.length, 1);
    const req = server.requests[0];
    assert.equal(req.method, 'PUT');
    assert.equal(req.headers['content-type'], 'application/octet-stream');
    assert.equal(Number(req.headers['content-length']), bytes.length);
    assert.deepEqual(req.body, bytes);
    assert.equal(result.bytes, bytes.length);

    assert.ok(events.length >= 1, 'expected progress events');
    const last = events[events.length - 1];
    assert.equal(last.percent, 100);
    assert.ok(last.mb > 0 && last.totalMb > 0);
    assert.ok(events.every((e) => e.percent >= 0 && e.percent <= 100));
  } finally {
    await server.close();
  }
});

test('uploadFileToPresignedUrl maps an expired signed URL (403) to a retryable error', async () => {
  const file = tempFile('app-release.apk', Buffer.from('data'));
  const server = await localServer((req, res) => {
    res.writeHead(403, { 'content-type': 'application/xml' });
    res.end('<Error><Code>AccessDenied</Code><Message>Request has expired</Message></Error>');
  });
  try {
    await assert.rejects(
      () => uploadFileToPresignedUrl(file, `${server.url}/expired`),
      (err) =>
        err instanceof StepError &&
        /upload to shareipa storage failed/i.test(err.message) &&
        /HTTP 403/.test(err.details) &&
        /request has expired/i.test(err.details) &&
        /retri(ed|able)/i.test(err.hint),
    );
  } finally {
    await server.close();
  }
});

test('uploadFileToPresignedUrl fails fast on an invalid URL', async () => {
  const file = tempFile('app-release.apk', Buffer.from('data'));
  await assert.rejects(
    () => uploadFileToPresignedUrl(file, 'not-a-url'),
    (err) => err instanceof StepError && /invalid upload url/i.test(err.message),
  );
});

/* ---------------------------------------------------------------- */
/* /app/save                                                         */
/* ---------------------------------------------------------------- */

test('buildSavePayload mirrors the website payload exactly', () => {
  const signed = { ...SIGNED_BODY, token: TOKEN, browserId: BROWSER_ID };
  const payload = buildSavePayload(signed, { changeLog: 'AlfaPTE build 193' });

  assert.deepEqual(Object.keys(payload), ['s3Url', 'uuid', 'filePath', 'fileType', 'appData', 'deviceInfo']);
  assert.equal(payload.s3Url, PRESIGNED_URL);
  assert.equal(payload.uuid, 'abc123');
  assert.equal(payload.filePath, SIGNED_BODY.filePath);
  assert.equal(payload.fileType, 'apk');
  assert.deepEqual(payload.appData, {
    id: 0,
    passwordProtected: false,
    validTill: '0001-01-01T00:00:00Z',
    createdAt: '0001-01-01T00:00:00Z',
    expDays: 7,
    password: '',
    changeLog: 'AlfaPTE build 193',
  });
  assert.deepEqual(payload.deviceInfo, { device: 'Unknown Device', deviceType: 'browser', ipAddr: '' });
});

test('saveApp posts the payload with Bearer + browser-id and extracts the ids', async () => {
  const fetchImpl = fakeFetch([fakeResponse(201, { admin_id: 'AdMiN1', install_id: 'abc123', id: 235805 })]);
  const signed = { ...SIGNED_BODY, token: TOKEN, browserId: BROWSER_ID };
  const saved = await saveApp({ fetchImpl, apiBase: API_BASE, signed, changeLog: 'notes' });

  assert.equal(saved.installId, 'abc123');
  assert.equal(saved.adminId, 'AdMiN1');
  assert.equal(installUrlFor(saved.installId), 'https://install.shareipa.com/abc123');

  assert.equal(fetchImpl.calls.length, 1);
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${API_BASE}/app/save`);
  assert.equal(call.options.method, 'POST');
  assert.equal(call.options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(call.options.headers['browser-id'], BROWSER_ID);
  const body = JSON.parse(call.options.body);
  assert.equal(body.uuid, 'abc123');
  assert.equal(body.appData.changeLog, 'notes');
});

test('saveApp never leaks the token or presigned URL in errors', async () => {
  const noisyBody = JSON.stringify({ msg: `bad save for Bearer ${TOKEN} -> ${PRESIGNED_URL}` });
  const fetchImpl = fakeFetch([
    fakeResponse(500, noisyBody),
    fakeResponse(500, noisyBody),
    fakeResponse(500, noisyBody),
  ]);
  const signed = { ...SIGNED_BODY, token: TOKEN, browserId: BROWSER_ID };
  await assert.rejects(
    () => saveApp({ fetchImpl, apiBase: API_BASE, signed, retryDelaysMs: [1, 1] }),
    (err) => {
      const dump = `${err.message}\n${err.details}\n${err.hint}`;
      assert.ok(err instanceof StepError);
      assert.ok(!dump.includes(TOKEN), 'token leaked into error');
      assert.ok(!dump.includes('X-Amz-Signature=0123456789abcdef'), 'signature leaked into error');
      assert.ok(!dump.includes('storage.example.test'), 'presigned URL leaked into error');
      return /could not register/i.test(err.message) && /HTTP 500/.test(err.details);
    },
  );
  assert.equal(fetchImpl.calls.length, 3, 'transient 500s are retried before giving up');
});

test('saveApp retries transient failures instead of wasting the upload', async () => {
  const fetchImpl = fakeFetch([
    fakeResponse(404, '<html><body>404 Not Found</body></html>'),
    fakeResponse(404, '<html><body>404 Not Found</body></html>'),
    fakeResponse(201, { admin_id: 'ADMIN1', install_id: 'abc123' }),
  ]);
  const retries = [];
  const signed = { ...SIGNED_BODY, token: TOKEN, browserId: BROWSER_ID };
  const saved = await saveApp({
    fetchImpl,
    apiBase: API_BASE,
    signed,
    retryDelaysMs: [1, 1],
    onRetry: (info) => retries.push(info),
  });

  assert.equal(saved.installId, 'abc123');
  assert.equal(fetchImpl.calls.length, 3);
  assert.deepEqual(retries.map((r) => r.status), [404, 404]);
  assert.deepEqual(retries.map((r) => r.nextAttempt), [2, 3]);
});

test('saveApp gives up after its retry budget with a clear error', async () => {
  const fetchImpl = fakeFetch([fakeResponse(500, 'oops'), fakeResponse(502, ''), fakeResponse(503, '')]);
  const signed = { ...SIGNED_BODY, token: TOKEN, browserId: BROWSER_ID };
  await assert.rejects(
    () => saveApp({ fetchImpl, apiBase: API_BASE, signed, retryDelaysMs: [1, 1] }),
    (err) => err instanceof StepError && /HTTP 503/.test(err.details) && /Retried 2 times/.test(err.details),
  );
  assert.equal(fetchImpl.calls.length, 3);
});

test('saveApp does not retry non-transient errors (401)', async () => {
  const fetchImpl = fakeFetch([fakeResponse(401, { msg: 'unauthorized' })]);
  const signed = { ...SIGNED_BODY, token: TOKEN, browserId: BROWSER_ID };
  await assert.rejects(
    () => saveApp({ fetchImpl, apiBase: API_BASE, signed, retryDelaysMs: [1, 1] }),
    (err) => err instanceof StepError && /HTTP 401/.test(err.details),
  );
  assert.equal(fetchImpl.calls.length, 1, 'auth errors must not be retried');
});

test('saveApp retries a dropped connection and succeeds', async () => {
  const fetchImpl = fakeFetch([new Error('socket hang up'), fakeResponse(201, { install_id: 'ABC123' })]);
  const signed = { ...SIGNED_BODY, token: TOKEN, browserId: BROWSER_ID };
  const saved = await saveApp({ fetchImpl, apiBase: API_BASE, signed, retryDelaysMs: [1] });
  assert.equal(saved.installId, 'ABC123');
  assert.equal(fetchImpl.calls.length, 2);
});

test('saveApp rejects malformed and incomplete responses', async () => {
  const signed = { ...SIGNED_BODY, token: TOKEN, browserId: BROWSER_ID };
  const html = fakeFetch([fakeResponse(404, '<html><body>404 Not Found</body></html>')]);
  await assert.rejects(
    () => saveApp({ fetchImpl: html, apiBase: API_BASE, signed, attempts: 1 }),
    (err) => err instanceof StepError && /could not register/i.test(err.message) && /HTTP 404/.test(err.details),
  );

  const noInstall = fakeFetch([fakeResponse(201, { admin_id: 'x' })]);
  await assert.rejects(
    () => saveApp({ fetchImpl: noInstall, apiBase: API_BASE, signed }),
    (err) => err instanceof StepError && /install_id/.test(err.details),
  );
});

/* ---------------------------------------------------------------- */
/* uploadToShareIPA — orchestration                                  */
/* ---------------------------------------------------------------- */

function orchestrationStubs({ uploadResults = [], saveBody, saveResponses = null, fileType = 'apk' } = {}) {
  const signed = { ...SIGNED_BODY, fileType };
  const calls = [];
  const uploadCalls = [];
  const saveQueue = saveResponses ? [...saveResponses] : null;
  const uploadFn = async (filePath, s3Url, opts) => {
    uploadCalls.push({ filePath, s3Url, opts });
    const next = uploadResults.shift() ?? undefined;
    if (next instanceof Error) throw next;
    if (opts && opts.onProgress) {
      opts.onProgress({ percent: 50, mb: 1, totalMb: 2, speed: 1 });
      opts.onProgress({ percent: 100, mb: 2, totalMb: 2, speed: 2 });
    }
    return { bytes: 2, ms: 10 };
  };
  // A fetch impl that answers getSignedUrl then save, in order.
  let phase = 0;
  const scriptedFetch = async (url, options = {}) => {
    calls.push({ url, options });
    if (/getSignedUrl/.test(url)) {
      return fakeResponse(200, signed, { token: TOKEN, 'browser-id': BROWSER_ID });
    }
    if (/\/app\/save$/.test(url)) {
      phase++;
      if (saveQueue && saveQueue.length > 0) return saveQueue.shift();
      return fakeResponse(201, saveBody || { admin_id: 'ADMIN1', install_id: 'abc123' });
    }
    throw new Error(`unexpected fetch: ${url}`);
  };
  scriptedFetch.calls = calls;
  return { fetchImpl: scriptedFetch, uploadFn, uploadCalls, phases: () => phase };
}

test('uploadToShareIPA runs getSignedUrl -> PUT -> save and returns both links', async () => {
  const { fetchImpl, uploadFn, uploadCalls } = orchestrationStubs({});
  const file = tempFile('app-release.apk', Buffer.from('apk-bytes'));
  const order = [];
  const result = await uploadToShareIPA({ root: '/tmp/project' }, file, 'App', 'note text', {
    fetchImpl,
    uploadFn,
    apiBase: API_BASE,
    onProgress: () => order.push('progress'),
    onProcessing: () => order.push('processing'),
  });

  assert.equal(result.url, 'https://install.shareipa.com/abc123');
  assert.equal(result.adminUrl, 'https://dashboard.shareipa.com/admin/ADMIN1');
  assert.equal(uploadCalls.length, 1);
  assert.equal(uploadCalls[0].s3Url, PRESIGNED_URL);
  assert.deepEqual(order, ['progress', 'progress', 'processing']);
  assert.ok(typeof result.timing.transferMs === 'number');
  assert.ok(typeof result.timing.serverMs === 'number');
  const saveCall = fetchImpl.calls.find((c) => /\/app\/save$/.test(c.url));
  assert.equal(JSON.parse(saveCall.options.body).appData.changeLog, 'note text');
});

test('uploadToShareIPA forwards transient save retries without re-uploading', async () => {
  const { fetchImpl, uploadFn, uploadCalls } = orchestrationStubs({
    saveResponses: [
      fakeResponse(404, '<html><body>404 Not Found</body></html>'),
      fakeResponse(201, { admin_id: 'ADMIN1', install_id: 'abc123' }),
    ],
  });
  const file = tempFile('app-release.apk', Buffer.from('apk-bytes'));
  const retries = [];
  const result = await uploadToShareIPA({ root: '/tmp/project' }, file, 'App', 'notes', {
    fetchImpl,
    uploadFn,
    apiBase: API_BASE,
    saveRetryDelaysMs: [1],
    onRetry: (info) => retries.push(info),
  });

  assert.equal(result.url, 'https://install.shareipa.com/abc123');
  assert.equal(uploadCalls.length, 1, 'the file must not be re-uploaded');
  assert.equal(retries.length, 1);
  assert.equal(retries[0].status, 404);
  assert.equal(fetchImpl.calls.filter((c) => /getSignedUrl/.test(c.url)).length, 1);
  assert.equal(fetchImpl.calls.filter((c) => /\/app\/save$/.test(c.url)).length, 2);
});

test('uploadToShareIPA retries a failed PUT with a fresh signed URL (no re-save)', async () => {
  const failure = new StepError('Upload to ShareIPA storage failed.', { details: 'HTTP 500' });
  const { fetchImpl, uploadFn } = orchestrationStubs({ uploadResults: [failure] });
  const file = tempFile('app-release.ipa', Buffer.from('ipa-bytes'));
  const result = await uploadToShareIPA({ root: '/tmp/project' }, file, 'App', 'notes', {
    fetchImpl,
    uploadFn,
    apiBase: API_BASE,
  });

  const signedCalls = fetchImpl.calls.filter((c) => /getSignedUrl/.test(c.url));
  const saveCalls = fetchImpl.calls.filter((c) => /\/app\/save$/.test(c.url));
  assert.equal(signedCalls.length, 2, 'each attempt asks for a fresh URL');
  assert.equal(saveCalls.length, 1, 'save runs only after a successful PUT');
  assert.equal(result.url, 'https://install.shareipa.com/abc123');
});

test('uploadToShareIPA stops after the retry budget and reports the attempts', async () => {
  const failure = new StepError('Upload to ShareIPA storage failed.', { details: 'HTTP 500' });
  const { fetchImpl, uploadFn } = orchestrationStubs({ uploadResults: [failure, failure] });
  const file = tempFile('app-release.apk', Buffer.from('apk-bytes'));
  await assert.rejects(
    () => uploadToShareIPA({ root: '/tmp/project' }, file, 'App', 'notes', { fetchImpl, uploadFn, apiBase: API_BASE }),
    (err) => err instanceof StepError && /2 attempts/.test(err.details),
  );
  assert.equal(fetchImpl.calls.filter((c) => /getSignedUrl/.test(c.url)).length, 2);
  assert.equal(fetchImpl.calls.filter((c) => /\/app\/save$/.test(c.url)).length, 0);
});

test('uploadToShareIPA propagates cancellation immediately', async () => {
  const cancelled = new StepError('Operation cancelled.');
  cancelled.cancelled = true;
  const { fetchImpl, uploadFn } = orchestrationStubs({ uploadResults: [cancelled] });
  const file = tempFile('app-release.apk', Buffer.from('apk-bytes'));
  await assert.rejects(
    () => uploadToShareIPA({ root: '/tmp/project' }, file, 'App', 'notes', { fetchImpl, uploadFn, apiBase: API_BASE }),
    (err) => err.cancelled === true,
  );
});

test('uploadToShareIPA refuses unsupported file types before any network call', async () => {
  const { fetchImpl, uploadFn } = orchestrationStubs({});
  const file = tempFile('app.zip', Buffer.from('zip'));
  await assert.rejects(
    () => uploadToShareIPA({ root: '/tmp/project' }, file, 'App', 'notes', { fetchImpl, uploadFn, apiBase: API_BASE }),
    (err) => err instanceof StepError && /cannot upload this file type/i.test(err.message),
  );
  assert.equal(fetchImpl.calls.length, 0);
});
