/**
 * AppShare upload provider (https://appshare.qubebiz.com) — the default.
 *
 * Drives the same JSON API the AppShare web app uses (observed in its
 * bundle and in a real upload on 2026-11-16):
 *
 *   1. POST /api/auth/login {email, password}
 *        -> sets the `appshare_session` cookie (httpOnly, ~30 days).
 *        Accounts are created by the AppShare admin; there are no API tokens.
 *   2. POST /api/uploads {fileName, fileSize}
 *        -> {uploadId, partSize, parts: [{partNumber, url}]}
 *   3. PUT each part's bytes to its presigned Cloudflare R2 URL (4 at a time,
 *      3 tries each) and keep the returned ETag.
 *   4. POST /api/uploads/{uploadId}/complete {parts: [{partNumber, etag}]}
 *   5. POST /api/builds {uploadId, name, version, buildNumber, bundleId,
 *                       notes, password, expiresIn, icon}
 *        -> {slug, …}; the install page is {base}/s/{slug}.
 *      expiresIn is "" (never) or one of EXPIRY_CHOICES as a string — the
 *      values the web form offers. icon is a PNG data URL of at most 256 px
 *      (what the web page draws from the APK/IPA), or "" for none.
 *
 * A failed or cancelled upload is deleted again (DELETE /api/uploads/{id}),
 * as the web app does. Credentials come only from APPSHARE_EMAIL /
 * APPSHARE_PASSWORD and, like the session cookie and presigned URLs, are
 * never printed. The icon comes from the project's own launcher/AppIcon
 * image (meta.iconPath), converted with macOS `sips`.
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { StepError } = require('../errors');
const { makeTempDir, removeTempPath } = require('../lifecycle');
const { sanitize, errorMessageFrom, signalWithTimeout, isCancellation, cancelledError } = require('./shareipa');

const DEFAULT_BASE = 'https://appshare.qubebiz.com';
/* The expiry options of the AppShare upload form, plus "never". */
const EXPIRY_CHOICES = [1, 3, 7, 14, 30, 90, 365];
const DEFAULT_EXPIRY_DAYS = 90;
const API_TIMEOUT_MS = 60_000;
const PART_CONCURRENCY = 4;
const PART_ATTEMPTS = 3;
/* Abort a part PUT when no bytes moved for this long. */
const STALL_TIMEOUT_MS = 60_000;

/** "90" / 90 / "never" -> 90 | 'never'; throws a usage StepError otherwise. */
function parseExpiry(value) {
  const text = String(value).trim().toLowerCase();
  if (text === 'never') return 'never';
  const days = Number(text);
  if (!EXPIRY_CHOICES.includes(days)) {
    throw new StepError(`Invalid --expires-in-days: ${value}`, {
      usage: true,
      details: `AppShare accepts ${EXPIRY_CHOICES.join(', ')} or never.`,
    });
  }
  return days;
}

function credentials(env) {
  const email = (env.APPSHARE_EMAIL || '').trim();
  const password = env.APPSHARE_PASSWORD || '';
  if (!email || !password) {
    throw new StepError('AppShare credentials are not set.', {
      code: 'UPLOAD_AUTH_FAILED',
      details: `Missing ${[!email && 'APPSHARE_EMAIL', !password && 'APPSHARE_PASSWORD'].filter(Boolean).join(' and ')}.`,
      hint: 'Export APPSHARE_EMAIL and APPSHARE_PASSWORD (your AppShare login; accounts are created by the AppShare admin), or pick another provider with --provider shareipa|betadrop.',
    });
  }
  return { email, password };
}

/* One sign-in per process: the preflight logs in before the build, the
 * upload reuses that session. */
let session = null;

function sessionCookieFrom(res) {
  const headers = res.headers;
  const all = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [headers.get('set-cookie') || ''];
  for (const line of all) {
    const m = /(?:^|[\s,])appshare_session=([^;,\s]+)/.exec(line || '');
    if (m) return `appshare_session=${m[1]}`;
  }
  return null;
}

/** fetch with timeout + cancellation; network failures become StepErrors. */
async function call(fetchImpl, url, init, { signal, timeoutMs = API_TIMEOUT_MS, what }) {
  try {
    return await fetchImpl(url, { ...init, signal: signalWithTimeout(signal, timeoutMs) });
  } catch (err) {
    if (isCancellation(signal, err)) throw cancelledError();
    throw new StepError('Could not reach AppShare.', {
      code: 'UPLOAD_FAILED',
      details: `${what}: ${err && err.name === 'TimeoutError' ? `no response within ${Math.round(timeoutMs / 1000)}s` : sanitize(err && err.message)}`,
      hint: 'Check the network connection and that https://appshare.qubebiz.com is up.',
    });
  }
}

/** Sign in (once per process). Returns the session cookie header value. */
async function login({ fetchImpl = globalThis.fetch, base = DEFAULT_BASE, env = process.env, signal = null } = {}) {
  const { email, password } = credentials(env);
  if (session && session.base === base && session.email === email) return session.cookie;
  const res = await call(
    fetchImpl,
    `${base}/api/auth/login`,
    { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify({ email, password }), redirect: 'manual' },
    { signal, what: 'sign-in' },
  );
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    const msg = errorMessageFrom(bodyText);
    throw new StepError('AppShare sign-in failed.', {
      code: 'UPLOAD_AUTH_FAILED',
      details: `POST /api/auth/login returned HTTP ${res.status}${msg ? ` — ${msg}` : ''}.`,
      hint: res.status === 401 || res.status === 400 ? 'Check APPSHARE_EMAIL and APPSHARE_PASSWORD.' : '',
    });
  }
  const cookie = sessionCookieFrom(res);
  if (!cookie) {
    throw new StepError('AppShare sign-in returned no session.', {
      code: 'UPLOAD_AUTH_FAILED',
      details: 'The login response had no appshare_session cookie.',
      hint: 'The AppShare API may have changed since this provider was written.',
    });
  }
  session = { base, email, cookie };
  return cookie;
}

/** Checked before the build starts, so a bad login fails in seconds, not after it. */
async function preflightAppShare(opts = {}) {
  await login(opts);
}

async function apiJson(fetchImpl, base, cookie, method, route, body, { signal, timeoutMs, what }) {
  const res = await call(
    fetchImpl,
    `${base}/api${route}`,
    {
      method,
      headers: { cookie, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    { signal, timeoutMs, what },
  );
  const text = await res.text().catch(() => '');
  if (!res.ok) {
    const msg = errorMessageFrom(text);
    throw new StepError(`AppShare ${what} failed.`, {
      code: 'UPLOAD_FAILED',
      details: `${method} /api${route.replace(/\/[0-9a-f]{12,}/gi, '/<id>')} returned HTTP ${res.status}${msg ? ` — ${msg}` : ''}.`,
      hint: res.status === 401 ? 'The AppShare session expired or was revoked; run ship again.' : '',
    });
  }
  try {
    return text ? JSON.parse(text) : {};
  } catch (err) {
    throw new StepError('AppShare returned an unexpected response.', {
      code: 'UPLOAD_FAILED',
      details: `${what} did not return JSON: ${sanitize(text, { limit: 200 })}`,
    });
  }
}

/**
 * PUT bytes [start, end) of `filePath` to a presigned URL. Resolves the ETag.
 * `onBytes(n)` reports this part's bytes sent so far.
 */
function putPart(url, filePath, start, end, { onBytes = () => {}, signal = null, stallMs = STALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let target;
    try {
      target = new URL(url);
    } catch (err) {
      reject(new StepError('AppShare returned an invalid upload URL.', { code: 'UPLOAD_FAILED' }));
      return;
    }
    const lib = target.protocol === 'http:' ? http : https;
    let settled = false;
    let sent = 0;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };
    const req = lib.request(target, { method: 'PUT', headers: { 'Content-Length': end - start } }, (res) => {
      res.resume();
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          finish(reject, new StepError('Upload to AppShare storage failed.', { code: 'UPLOAD_FAILED', details: `The object store returned HTTP ${res.statusCode}.` }));
          return;
        }
        const etag = res.headers.etag;
        if (!etag) {
          finish(reject, new StepError('AppShare storage returned no ETag.', { code: 'UPLOAD_FAILED' }));
          return;
        }
        finish(resolve, etag);
      });
    });
    const stream = fs.createReadStream(filePath, { start, end: end - 1 });
    const onAbort = () => {
      const err = cancelledError();
      stream.destroy();
      req.destroy(err);
      finish(reject, err);
    };
    req.setTimeout(stallMs, () => req.destroy(new Error(`no progress for ${Math.round(stallMs / 1000)}s`)));
    req.on('error', (err) => {
      if (err && err.cancelled) return finish(reject, err);
      finish(reject, new StepError('Upload to AppShare storage failed.', { code: 'UPLOAD_FAILED', details: sanitize(err && err.message) }));
    });
    stream.on('data', (chunk) => {
      sent += chunk.length;
      onBytes(sent);
    });
    stream.on('error', (err) => {
      req.destroy(err);
      finish(reject, new StepError('Could not read the build file.', { details: sanitize(err.message) }));
    });
    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    stream.pipe(req);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* The web page draws the icon at most this wide (never larger). */
const ICON_MAX_PX = 256;

/**
 * PNG data URL of `iconPath` (png/webp/…), at most ICON_MAX_PX wide and never
 * upscaled — what the AppShare web page sends. "" when there is no icon or
 * sips fails: a missing icon must never fail an upload.
 */
function iconDataUrl(iconPath, { run = spawnSync } = {}) {
  if (!iconPath) return '';
  let dir = null;
  try {
    dir = makeTempDir('icon');
    const out = path.join(dir, 'icon.png');
    const probe = run('sips', ['-g', 'pixelWidth', iconPath], { encoding: 'utf8' });
    const width = Number((/pixelWidth:\s*(\d+)/.exec(probe.stdout || '') || [])[1]);
    const resize = width > ICON_MAX_PX ? ['-Z', String(ICON_MAX_PX)] : [];
    const res = run('sips', ['-s', 'format', 'png', ...resize, iconPath, '--out', out], { encoding: 'utf8' });
    if (res.error || res.status !== 0) return '';
    return `data:image/png;base64,${fs.readFileSync(out).toString('base64')}`;
  } catch (err) {
    return '';
  } finally {
    if (dir) removeTempPath(dir);
  }
}

/**
 * Provider entry point (same signature as the other providers):
 *   uploadToAppShare(profile, filePath, name, notes,
 *                    { onProgress, onProcessing, onRetry, signal, meta, expiresInDays })
 * `meta` = { version, buildNumber, bundleId } for the AppShare build record.
 * Returns { url, timing: { transferMs, serverMs } }.
 */
async function uploadToAppShare(profile, filePath, name, notes, {
  onProgress = null,
  onProcessing = null,
  signal = null,
  meta = {},
  expiresInDays = DEFAULT_EXPIRY_DAYS,
  fetchImpl = globalThis.fetch,
  base = DEFAULT_BASE,
  env = process.env,
  put = putPart,
  retryDelayMs = 1000,
  toIcon = iconDataUrl,
} = {}) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext !== '.apk' && ext !== '.ipa') {
    throw new StepError('AppShare cannot upload this file type.', { code: 'UPLOAD_FAILED', details: `Expected a .apk or .ipa file, got ${path.basename(filePath)}.` });
  }
  const expiry = parseExpiry(expiresInDays);
  const cookie = await login({ fetchImpl, base, env, signal });
  const size = fs.statSync(filePath).size;
  const opts = { signal };

  const created = await apiJson(fetchImpl, base, cookie, 'POST', '/uploads', { fileName: path.basename(filePath), fileSize: size }, { ...opts, what: 'upload start' });
  const { uploadId, partSize, parts } = created;
  if (!uploadId || !Number(partSize) || !Array.isArray(parts) || parts.length === 0) {
    throw new StepError('AppShare returned an unexpected response.', { code: 'UPLOAD_FAILED', details: 'upload start is missing uploadId, partSize or parts.' });
  }

  const startedAt = Date.now();
  const sentByPart = {};
  let lastEmit = 0;
  const totalMb = size / (1024 * 1024);
  const emit = (force) => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastEmit < 200) return;
    lastEmit = now;
    const sent = Object.values(sentByPart).reduce((a, b) => a + b, 0);
    const mb = sent / (1024 * 1024);
    const elapsed = (now - startedAt) / 1000;
    onProgress({ percent: Math.min(100, Math.round((sent / size) * 100)), mb, totalMb, speed: elapsed > 0.5 && mb > 0 ? mb / elapsed : null });
  };

  try {
    const queue = [...parts];
    const done = [];
    const worker = async () => {
      while (queue.length > 0) {
        const { partNumber, url } = queue.shift();
        const start = (partNumber - 1) * partSize;
        const end = Math.min(size, partNumber * partSize);
        for (let attempt = 1; ; attempt++) {
          try {
            const etag = await put(url, filePath, start, end, { signal, onBytes: (n) => { sentByPart[partNumber] = n; emit(false); } });
            done.push({ partNumber, etag });
            break;
          } catch (err) {
            if (err.cancelled || (signal && signal.aborted) || attempt >= PART_ATTEMPTS) throw err;
            sentByPart[partNumber] = 0;
            await sleep(retryDelayMs * attempt);
          }
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PART_CONCURRENCY, parts.length) }, worker));
    emit(true);
    const transferMs = Date.now() - startedAt;

    await apiJson(fetchImpl, base, cookie, 'POST', `/uploads/${encodeURIComponent(uploadId)}/complete`, { parts: done.sort((a, b) => a.partNumber - b.partNumber) }, { ...opts, what: 'upload completion' });
    if (onProcessing) onProcessing();
    const serverStartedAt = Date.now();
    const build = await apiJson(
      fetchImpl,
      base,
      cookie,
      'POST',
      '/builds',
      {
        uploadId,
        name,
        version: String(meta.version || 'unknown'),
        buildNumber: meta.buildNumber ? String(meta.buildNumber) : '',
        bundleId: meta.bundleId || '',
        notes: notes || '',
        password: '',
        expiresIn: expiry === 'never' ? '' : String(expiry),
        icon: toIcon(meta.iconPath),
      },
      { ...opts, timeoutMs: 180_000, what: 'build publish' },
    );
    if (!build || !build.slug) {
      throw new StepError('AppShare returned an unexpected response.', { code: 'UPLOAD_NO_URL', details: 'build publish response is missing "slug".' });
    }
    return { url: `${base}/s/${encodeURIComponent(build.slug)}`, timing: { transferMs, serverMs: Date.now() - serverStartedAt } };
  } catch (err) {
    /* Drop the half-finished upload server-side (best effort, like the web app). */
    await call(fetchImpl, `${base}/api/uploads/${encodeURIComponent(uploadId)}`, { method: 'DELETE', headers: { cookie } }, { signal: null, timeoutMs: 10_000, what: 'upload cleanup' }).catch(() => {});
    throw err;
  }
}

/** Test helper: forget the cached session. */
function resetSessionForTests() {
  session = null;
}

module.exports = {
  DEFAULT_BASE,
  EXPIRY_CHOICES,
  DEFAULT_EXPIRY_DAYS,
  parseExpiry,
  iconDataUrl,
  login,
  preflightAppShare,
  putPart,
  uploadToAppShare,
  resetSessionForTests,
};
