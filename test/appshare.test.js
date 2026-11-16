/**
 * AppShare provider — unit tests.
 *
 * Everything is mocked: the AppShare JSON API is a fake fetch, and the
 * presigned R2 part PUTs go to a throwaway 127.0.0.1 HTTP server. No test
 * here touches appshare.qubebiz.com or Cloudflare.
 */

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const { StepError } = require('../lib/errors');
const { parseExpiry, login, uploadToAppShare, resetSessionForTests, DEFAULT_EXPIRY_DAYS, EXPIRY_CHOICES } = require('../lib/providers/appshare');

const BASE = 'https://appshare.example.test';
const ENV = { APPSHARE_EMAIL: 'dev@example.test', APPSHARE_PASSWORD: 's3cret-pass' };
const COOKIE = 'appshare_session=abc123sessionvalue';

function jsonResponse(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (n) => headers[n.toLowerCase()] ?? null,
      getSetCookie: () => (headers['set-cookie'] ? [headers['set-cookie']] : []),
    },
    text: async () => text,
  };
}

/** A local stand-in for R2: records part bodies, answers with an ETag. */
async function startStorage({ failTimes = {} } = {}) {
  const received = {};
  const attempts = {};
  const server = http.createServer((req, res) => {
    const part = Number(new URL(req.url, 'http://x').searchParams.get('partNumber'));
    attempts[part] = (attempts[part] || 0) + 1;
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (attempts[part] <= (failTimes[part] || 0)) {
        res.writeHead(500);
        res.end('boom');
        return;
      }
      const body = Buffer.concat(chunks);
      received[part] = body;
      res.writeHead(200, { ETag: `"etag-${part}-${crypto.createHash('md5').update(body).digest('hex').slice(0, 8)}"` });
      res.end();
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    received,
    attempts,
    url: (part) => `http://127.0.0.1:${port}/builds/x.apk?partNumber=${part}&X-Amz-Signature=SIGNATURE`,
    close: () => new Promise((r) => server.close(r)),
  };
}

/** Fake AppShare API. `overrides[route]` replaces a response. */
function fakeApi(storage, { partSize, fileSize, overrides = {} }) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    const route = url.replace(BASE, '');
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ method: init.method || 'GET', route, body, cookie: init.headers && init.headers.cookie });
    const key = `${init.method || 'GET'} ${route.replace(/\/up-1(?=\/|$)/, '/{id}')}`;
    if (overrides[key]) return overrides[key](body);
    switch (key) {
      case 'POST /api/auth/login':
        return jsonResponse(200, { user: { id: 'u1' } }, { 'set-cookie': `${COOKIE}; Path=/; HttpOnly; SameSite=Lax` });
      case 'POST /api/uploads': {
        const count = Math.ceil(fileSize / partSize);
        return jsonResponse(201, { uploadId: 'up-1', partSize, parts: Array.from({ length: count }, (_, i) => ({ partNumber: i + 1, url: storage.url(i + 1) })) });
      }
      case 'POST /api/uploads/{id}/complete':
        return jsonResponse(200, { ok: true });
      case 'POST /api/builds':
        return jsonResponse(201, { id: 'b1', slug: 'SLUG123', name: body.name });
      case 'DELETE /api/uploads/{id}':
        return jsonResponse(200, {});
      default:
        return jsonResponse(404, { error: `unexpected ${key}` });
    }
  };
  return { fetchImpl, calls };
}

function tmpApk(size) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ship-appshare-test-'));
  const file = path.join(dir, 'app-release.apk');
  fs.writeFileSync(file, crypto.randomBytes(size));
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

test('parseExpiry accepts exactly the AppShare choices and never', () => {
  assert.equal(DEFAULT_EXPIRY_DAYS, 90);
  assert.deepEqual(EXPIRY_CHOICES, [1, 3, 7, 14, 30, 90, 365]);
  for (const v of EXPIRY_CHOICES) assert.equal(parseExpiry(String(v)), v);
  assert.equal(parseExpiry('NEVER'), 'never');
  for (const bad of ['45', '0', '-7', 'abc', '90.5', '']) {
    assert.throws(() => parseExpiry(bad), (err) => err instanceof StepError && err.usage === true, bad);
  }
});

test('missing credentials fail before any request, naming only the variable', async () => {
  resetSessionForTests();
  const fetchImpl = async () => assert.fail('no request without credentials');
  await assert.rejects(login({ fetchImpl, base: BASE, env: { APPSHARE_EMAIL: 'x@example.test' } }), (err) => {
    assert.equal(err.code, 'UPLOAD_AUTH_FAILED');
    assert.match(err.details, /APPSHARE_PASSWORD/);
    assert.doesNotMatch(err.details, /APPSHARE_EMAIL/);
    return true;
  });
});

test('login posts the credentials once and reuses the session cookie', async () => {
  resetSessionForTests();
  const { fetchImpl, calls } = fakeApi(null, { partSize: 1, fileSize: 1 });
  assert.equal(await login({ fetchImpl, base: BASE, env: ENV }), COOKIE);
  assert.equal(await login({ fetchImpl, base: BASE, env: ENV }), COOKIE);
  assert.equal(calls.length, 1, 'second call reuses the session');
  assert.deepEqual(calls[0].body, { email: 'dev@example.test', password: 's3cret-pass' });
});

test('a rejected login is UPLOAD_AUTH_FAILED and never echoes the password', async () => {
  resetSessionForTests();
  const fetchImpl = async () => jsonResponse(401, { error: 'Invalid email or password' });
  await assert.rejects(login({ fetchImpl, base: BASE, env: ENV }), (err) => {
    assert.equal(err.code, 'UPLOAD_AUTH_FAILED');
    assert.match(err.details, /HTTP 401 — Invalid email or password/);
    assert.ok(!JSON.stringify(err).includes('s3cret-pass') && !err.message.includes('s3cret-pass'));
    return true;
  });
});

test('upload: multipart PUTs, complete, publish with metadata and the default 90-day expiry', async () => {
  resetSessionForTests();
  const partSize = 64 * 1024;
  const apk = tmpApk(partSize * 3 + 1234); /* 4 parts, the last one short */
  const storage = await startStorage();
  const api = fakeApi(storage, { partSize, fileSize: fs.statSync(apk.file).size });
  const progress = [];
  let processing = 0;
  try {
    const result = await uploadToAppShare({}, apk.file, 'DemoApp Android Staging', 'notes here', {
      fetchImpl: api.fetchImpl,
      base: BASE,
      env: ENV,
      meta: { version: '1.2.3', buildNumber: '7', bundleId: 'com.example.demo' },
      onProgress: (p) => progress.push(p.percent),
      onProcessing: () => processing++,
    });
    assert.equal(result.url, `${BASE}/s/SLUG123`);
    /* the bytes arrive intact, split exactly at partSize */
    const reassembled = Buffer.concat([1, 2, 3, 4].map((n) => storage.received[n]));
    assert.deepEqual(reassembled, fs.readFileSync(apk.file));
    assert.equal(storage.received[4].length, 1234);

    const routes = api.calls.map((c) => `${c.method} ${c.route}`);
    assert.deepEqual(routes, ['POST /api/auth/login', 'POST /api/uploads', 'POST /api/uploads/up-1/complete', 'POST /api/builds']);
    assert.ok(api.calls.slice(1).every((c) => c.cookie === COOKIE), 'every API call carries the session');
    assert.deepEqual(api.calls[1].body, { fileName: 'app-release.apk', fileSize: partSize * 3 + 1234 });
    const complete = api.calls[2].body.parts;
    assert.deepEqual(complete.map((p) => p.partNumber), [1, 2, 3, 4]);
    assert.ok(complete.every((p) => /^"etag-\d-/.test(p.etag)), 'ETags passed back unchanged');
    assert.deepEqual(api.calls[3].body, {
      uploadId: 'up-1',
      name: 'DemoApp Android Staging',
      version: '1.2.3',
      buildNumber: '7',
      bundleId: 'com.example.demo',
      notes: 'notes here',
      password: '',
      expiresIn: '90',
    });
    assert.equal(progress[progress.length - 1], 100);
    assert.equal(processing, 1);
  } finally {
    await storage.close();
    apk.cleanup();
  }
});

test('expiry is sent as AppShare expects: "never" -> "", 7 -> "7"', async () => {
  for (const [value, expected] of [['never', ''], [7, '7']]) {
    resetSessionForTests();
    const apk = tmpApk(100);
    const storage = await startStorage();
    const api = fakeApi(storage, { partSize: 1024, fileSize: 100 });
    try {
      await uploadToAppShare({}, apk.file, 'n', '', { fetchImpl: api.fetchImpl, base: BASE, env: ENV, expiresInDays: value });
      assert.equal(api.calls.find((c) => c.route === '/api/builds').body.expiresIn, expected);
    } finally {
      await storage.close();
      apk.cleanup();
    }
  }
});

test('a failing part is retried; a part that keeps failing aborts and deletes the upload', async () => {
  resetSessionForTests();
  const apk = tmpApk(3000);
  let storage = await startStorage({ failTimes: { 2: 1 } });
  let api = fakeApi(storage, { partSize: 1000, fileSize: 3000 });
  try {
    await uploadToAppShare({}, apk.file, 'n', '', { fetchImpl: api.fetchImpl, base: BASE, env: ENV, retryDelayMs: 1 });
    assert.equal(storage.attempts[2], 2, 'part 2 retried once');
    await storage.close();

    resetSessionForTests();
    storage = await startStorage({ failTimes: { 3: 99 } });
    api = fakeApi(storage, { partSize: 1000, fileSize: 3000 });
    await assert.rejects(uploadToAppShare({}, apk.file, 'n', '', { fetchImpl: api.fetchImpl, base: BASE, env: ENV, retryDelayMs: 1 }), (err) => {
      assert.equal(err.code, 'UPLOAD_FAILED');
      assert.ok(!`${err.message} ${err.details}`.includes('X-Amz-Signature'), 'no presigned URL in the error');
      return true;
    });
    assert.equal(storage.attempts[3], 3, 'three tries per part');
    assert.ok(api.calls.some((c) => c.method === 'DELETE' && c.route === '/api/uploads/up-1'), 'upload deleted');
    assert.ok(!api.calls.some((c) => c.route === '/api/builds'), 'nothing published');
  } finally {
    await storage.close();
    apk.cleanup();
  }
});

test('a publish without a slug is UPLOAD_NO_URL and the upload is deleted', async () => {
  resetSessionForTests();
  const apk = tmpApk(100);
  const storage = await startStorage();
  const api = fakeApi(storage, { partSize: 1024, fileSize: 100, overrides: { 'POST /api/builds': () => jsonResponse(201, { id: 'b1' }) } });
  try {
    await assert.rejects(uploadToAppShare({}, apk.file, 'n', '', { fetchImpl: api.fetchImpl, base: BASE, env: ENV }), (err) => err.code === 'UPLOAD_NO_URL');
    assert.ok(api.calls.some((c) => c.method === 'DELETE'));
  } finally {
    await storage.close();
    apk.cleanup();
  }
});

test('API errors carry the HTTP status and the server message', async () => {
  resetSessionForTests();
  const apk = tmpApk(100);
  const api = fakeApi(null, { partSize: 1024, fileSize: 100, overrides: { 'POST /api/uploads': () => jsonResponse(413, { error: 'File too large' }) } });
  try {
    await assert.rejects(uploadToAppShare({}, apk.file, 'n', '', { fetchImpl: api.fetchImpl, base: BASE, env: ENV }), (err) => {
      assert.equal(err.code, 'UPLOAD_FAILED');
      assert.match(err.details, /POST \/api\/uploads returned HTTP 413 — File too large/);
      return true;
    });
  } finally {
    apk.cleanup();
  }
});

test('cancelling during the part upload stops it and deletes the upload', async () => {
  resetSessionForTests();
  const apk = tmpApk(4000);
  const storage = await startStorage();
  const api = fakeApi(storage, { partSize: 1000, fileSize: 4000 });
  const ctrl = new AbortController();
  /* a part PUT that only ends when cancelled */
  const put = (url, file, start, end, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new StepError('Operation cancelled.'), { cancelled: true })), { once: true });
      setTimeout(() => ctrl.abort(), 20);
    });
  try {
    await assert.rejects(uploadToAppShare({}, apk.file, 'n', '', { fetchImpl: api.fetchImpl, base: BASE, env: ENV, signal: ctrl.signal, put }), (err) => err.cancelled === true);
    assert.ok(api.calls.some((c) => c.method === 'DELETE' && c.route === '/api/uploads/up-1'));
    assert.ok(!api.calls.some((c) => c.route.endsWith('/complete')));
  } finally {
    await storage.close();
    apk.cleanup();
  }
});

test('only .apk and .ipa files are accepted', async () => {
  await assert.rejects(uploadToAppShare({}, '/tmp/x.zip', 'n', '', { env: ENV, fetchImpl: async () => assert.fail('no request') }), (err) => /cannot upload this file type/.test(err.message));
});
