/**
 * ShareIPA upload provider.
 *
 * UNOFFICIAL — ShareIPA's free tier has no public API. Their FAQ states it
 * plainly: "ShareIPA (free) doesn't offer API/CLI integrations" (the paid
 * Zunoy AppShare product is the one with a CLI). This provider therefore
 * drives the same *undocumented website-backend calls the browser makes*:
 *
 *   1. GET  {api}/app/getSignedUrl?fileType=<apk|ipa>
 *        Creates the application id and returns a presigned object-storage
 *        PUT URL. The anonymous bearer token for step 3 comes back in the
 *        `token` *response header* (15-minute expiry), the browser id in
 *        `browser-id`. No login, cookie or pre-existing session is involved.
 *
 *   2. PUT  <presigned object-storage URL>          (the build bytes)
 *        Straight to ShareIPA's S3-compatible storage (Linode). The URL is
 *        signed for 15 minutes; nothing is registered on ShareIPA yet.
 *
 *   3. POST {api}/app/save   (Authorization: Bearer <token>)
 *        Registers the upload, processes the binary server-side (name,
 *        version, icon, package id) and returns
 *        { install_id, admin_id, id, appdata }. There is no polling: when
 *        this call returns, the app is live.
 *
 * Resulting links (built by the website the same way):
 *   install: https://install.shareipa.com/<install_id>
 *   admin:   https://dashboard.shareipa.com/admin/<admin_id>
 *
 * Security notes:
 *   - Nothing is persisted: every run asks for a fresh anonymous token and
 *     it is only ever sent to api.shareipa.com.
 *   - Tokens, browser ids and presigned URLs never appear in error messages
 *     or logs; all provider output is passed through sanitize().
 *
 * Because these endpoints are undocumented they can change without notice.
 * Failures are reported with the HTTP status and a hint rather than guessing.
 *
 * Retry semantics:
 *   - A failed PUT is retried once with a *fresh* getSignedUrl (new app id +
 *     new token), because each attempt is independent and nothing was
 *     registered. The abandoned attempt only leaves an unreferenced object.
 *   - /app/save itself is retried a couple of times on transient failures
 *     (the observed one is an nginx 404 while ShareIPA's processing service
 *     is briefly unavailable). This is cheap: the object is already uploaded
 *     and the anonymous token stays valid for 15 minutes.
 *   - If the PUT succeeded but registration still fails after the retry
 *     budget, the file is NOT re-uploaded automatically; the error tells the
 *     user to re-run, instead of silently burning another upload through
 *     their connection.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const https = require('node:https');
const path = require('node:path');
const { StepError } = require('../errors');

const DEFAULT_API_BASE = 'https://api.shareipa.com/website/api/v1';
const INSTALL_BASE = 'https://install.shareipa.com';
const ADMIN_BASE = 'https://dashboard.shareipa.com';

/** Free-tier links (and the server-side `validTill`) live 7 days. */
const LINK_EXPIRY_DAYS = 7;
/** getSignedUrl is a quick metadata call. */
const API_TIMEOUT_MS = 30_000;
/** /app/save also processes the binary server-side; observed ~40–55s for a 95 MB APK. */
const SAVE_TIMEOUT_MS = 300_000;
/**
 * Registration retries. ShareIPA occasionally answers /app/save with an nginx
 * 404 while its processing service is briefly unavailable (observed after a
 * fully successful upload); retrying is cheap because the bytes are already
 * stored and the anonymous token is valid for 15 minutes.
 */
const SAVE_ATTEMPTS = 3;
const SAVE_RETRY_DELAYS_MS = [3000, 10_000];
/** Abort a PUT when no progress event happened for this long. */
const STALL_TIMEOUT_MS = 60_000;
/** One automatic retry (with a fresh signed URL) when the PUT fails. */
const UPLOAD_ATTEMPTS = 2;

/** api path -> 'apk' | 'ipa'; ShareIPA derives everything else from the file. */
function fileTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.apk') return 'apk';
  if (ext === '.ipa') return 'ipa';
  throw new StepError('ShareIPA cannot upload this file type.', {
    details: `Expected a .apk or .ipa file, got ${path.basename(filePath)}.`,
  });
}

function installUrlFor(installId) {
  return `${INSTALL_BASE}/${encodeURIComponent(installId)}`;
}

function adminUrlFor(adminId) {
  return `${ADMIN_BASE}/admin/${encodeURIComponent(adminId)}`;
}

/**
 * Strip anything secret-shaped from text that may end up in errors.
 * The token is a JWT; presigned URLs carry X-Amz credentials/signatures and
 * point at the storage host. Never print those.
 */
function sanitize(text, { limit = 400 } = {}) {
  if (text === undefined || text === null || text === '') return '';
  return String(text)
    .replace(/eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '<token>')
    /* Whole presigned URLs, whatever the storage host — spotted by their X-Amz-* query. */
    .replace(/https?:\/\/[^\s"']*[?&]X-Amz-[^\s"']*/gi, '<presigned-url>')
    .replace(/https?:\/\/[^\s"']*\.linodeobjects\.com\/[^\s"']*/gi, '<presigned-url>')
    .replace(/(X-Amz-(?:Signature|Credential)=)[^&\s"']+/gi, '$1<redacted>')
    .replace(/(Authorization\s*[:=]\s*Bearer\s+)\S+/gi, '$1<redacted>')
    .slice(0, limit);
}

/** Human message from an API error body (JSON `msg`/`message`/`error` else raw text). */
function errorMessageFrom(bodyText) {
  if (!bodyText) return '';
  try {
    const json = JSON.parse(bodyText);
    const msg = json && (json.msg || json.message || json.error);
    if (msg !== undefined && msg !== null && String(msg) !== '') {
      return sanitize(String(msg), { limit: 200 });
    }
  } catch (err) {
    /* not JSON — fall through to the raw text */
  }
  return sanitize(bodyText, { limit: 200 });
}

function normalizeError(err, title, hint) {
  if (err instanceof StepError) return err;
  return new StepError(title, { details: sanitize(err && err.message), hint });
}

/**
 * `AbortSignal.any` needs Node 20.3+; the tool supports Node 18, so compose
 * manually when it is missing.
 */
function signalWithTimeout(signal, ms) {
  const timeout = AbortSignal.timeout(ms);
  if (!signal) return timeout;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([signal, timeout]);
  const ctrl = new AbortController();
  const abortWith = (reason) => {
    if (!ctrl.signal.aborted) ctrl.abort(reason);
  };
  if (signal.aborted) abortWith(signal.reason);
  else signal.addEventListener('abort', () => abortWith(signal.reason), { once: true });
  if (timeout.aborted) abortWith(timeout.reason);
  else timeout.addEventListener('abort', () => abortWith(timeout.reason), { once: true });
  return ctrl.signal;
}

function isCancellation(signal, err) {
  if (signal && signal.aborted) return true;
  return Boolean(err && (err.cancelled || (err.name === 'AbortError' && signal && signal.aborted)));
}

function cancelledError() {
  const err = new StepError('Operation cancelled.');
  err.cancelled = true;
  return err;
}

/** Cancel-aware pause between retries. */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        reject(cancelledError());
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/**
 * Transient upstream failures worth retrying for /app/save: the observed
 * nginx 404 during processing, plus the usual 408/425/429/5xx suspects.
 * 400/401/403 mean the request itself is wrong — retrying cannot help.
 */
function isRetryableSaveStatus(status) {
  return status === 404 || status === 408 || status === 425 || status === 429 || status >= 500;
}

/** Value of a response header that works with fetch Headers and test fakes. */
function headerValue(res, name) {
  if (!res || !res.headers) return null;
  if (typeof res.headers.get === 'function') return res.headers.get(name);
  return res.headers[name] ?? res.headers[String(name).toLowerCase()] ?? null;
}

/**
 * Step 1 — prepare the upload. No authentication is required; the anonymous
 * bearer token is issued by this response itself.
 */
async function getSignedUrl({ fetchImpl = globalThis.fetch, apiBase = DEFAULT_API_BASE, fileType, signal } = {}) {
  const url = `${apiBase}/app/getSignedUrl?fileType=${encodeURIComponent(fileType)}`;
  let res;
  try {
    res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: signalWithTimeout(signal, API_TIMEOUT_MS),
    });
  } catch (err) {
    if (isCancellation(signal, err)) throw cancelledError();
    if (err && err.name === 'TimeoutError') {
      throw new StepError('ShareIPA did not respond in time.', {
        details: 'The getSignedUrl request hit the 30s timeout.',
      });
    }
    throw normalizeError(
      err,
      'Could not reach the ShareIPA API.',
      "ShareIPA's website API may be down or blocked on this network. You can still upload manually at https://www.shareipa.com.",
    );
  }

  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    const msg = errorMessageFrom(bodyText);
    throw new StepError('ShareIPA could not prepare the upload.', {
      details: `getSignedUrl returned HTTP ${res.status}${msg ? ` — ${msg}` : ''}.`,
      hint: 'The ShareIPA website API may have changed. You can still upload manually at https://www.shareipa.com.',
    });
  }

  let data;
  try {
    data = JSON.parse(bodyText);
  } catch (err) {
    throw new StepError('ShareIPA returned an unexpected response.', {
      details: `getSignedUrl did not return JSON: ${sanitize(bodyText, { limit: 200 })}`,
    });
  }

  for (const field of ['s3Url', 'uuid', 'filePath', 'fileType']) {
    if (!data || !data[field]) {
      throw new StepError('ShareIPA returned an unexpected response.', {
        details: `getSignedUrl response is missing "${field}".`,
        hint: 'The ShareIPA website API may have changed since this provider was written.',
      });
    }
  }

  const token = headerValue(res, 'token');
  if (!token) {
    throw new StepError('ShareIPA returned an unexpected response.', {
      details: 'getSignedUrl response is missing the `token` header.',
      hint: 'The ShareIPA website API may have changed since this provider was written.',
    });
  }

  return {
    s3Url: data.s3Url,
    uuid: data.uuid,
    filePath: data.filePath,
    fileType: data.fileType,
    appData: data.appData || null,
    /* The browser stores the server-issued browser id; fall back to a fresh
     * one (the save endpoint accepts either). */
    browserId: headerValue(res, 'browser-id') || crypto.randomUUID(),
    token,
  };
}

/**
 * Step 2 — stream the file to the presigned URL, reporting real progress
 * from the bytes handed to the socket.
 *
 * Progress events: { percent, mb, totalMb, speed } — same shape the BetaDrop
 * tracker emits, so the UI renders both providers identically.
 */
function uploadFileToPresignedUrl(filePath, s3Url, { onProgress = null, signal = null, stallMs = STALL_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    let url;
    try {
      url = new URL(s3Url);
    } catch (err) {
      reject(
        new StepError('ShareIPA returned an invalid upload URL.', {
          details: 'The presigned URL from getSignedUrl could not be parsed.',
        }),
      );
      return;
    }

    let size = 0;
    try {
      size = fs.statSync(filePath).size;
    } catch (err) {
      reject(new StepError('Could not read the build file.', { details: sanitize(err.message) }));
      return;
    }
    if (!size) {
      reject(new StepError('Could not read the build file.', { details: `${filePath} is empty.` }));
      return;
    }

    const lib = url.protocol === 'http:' ? http : https;
    const startedAt = Date.now();
    let sent = 0;
    let lastEmit = 0;
    let settled = false;

    const totalMb = size / (1024 * 1024);
    const emit = (force) => {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - lastEmit < 200) return;
      lastEmit = now;
      const mb = sent / (1024 * 1024);
      const elapsed = (now - startedAt) / 1000;
      onProgress({
        percent: Math.min(100, Math.round((sent / size) * 100)),
        mb,
        totalMb,
        speed: elapsed > 0.5 && mb > 0 ? mb / elapsed : null,
      });
    };

    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      if (signal) signal.removeEventListener('abort', onAbort);
      fn(value);
    };

    const onAbort = () => {
      const err = cancelledError();
      readStream.destroy(err);
      req.destroy(err);
      finish(reject, err);
    };

    const req = lib.request(
      url,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': size },
      },
      (res) => {
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          if (body.length < 2000) body += chunk;
        });
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            emit(true);
            finish(resolve, { bytes: sent, ms: Date.now() - startedAt });
          } else {
            const msg = errorMessageFrom(body);
            finish(
              reject,
              new StepError('Upload to ShareIPA storage failed.', {
                details: `The object store returned HTTP ${res.statusCode}${msg ? ` — ${msg}` : ''}.`,
                hint: 'Nothing was registered on ShareIPA; the upload can be retried safely.',
              }),
            );
          }
        });
      },
    );

    req.setTimeout(stallMs, () => {
      req.destroy(
        new StepError('Upload to ShareIPA storage stalled.', {
          details: `No progress for ${Math.round(stallMs / 1000)}s — the connection appears dead.`,
          hint: 'Nothing was registered on ShareIPA; the upload can be retried safely.',
        }),
      );
    });

    req.on('error', (err) => {
      if (err && err.cancelled) return finish(reject, err);
      finish(
        reject,
        normalizeError(
          err,
          'Upload to ShareIPA storage failed.',
          'Nothing was registered on ShareIPA; the upload can be retried safely.',
        ),
      );
    });

    const readStream = fs.createReadStream(filePath);
    readStream.on('data', (chunk) => {
      sent += chunk.length;
      emit(false);
    });
    readStream.on('error', (err) => {
      req.destroy(err);
      finish(reject, new StepError('Could not read the build file.', { details: sanitize(err.message) }));
    });

    if (signal) {
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
    }
    readStream.pipe(req);
  });
}

/** The exact JSON body the website posts to /app/save. */
function buildSavePayload(signed, { changeLog = '', expDays = LINK_EXPIRY_DAYS } = {}) {
  return {
    s3Url: signed.s3Url,
    uuid: signed.uuid,
    filePath: signed.filePath,
    fileType: signed.fileType,
    appData: {
      ...(signed.appData || {}),
      id: 0,
      passwordProtected: false,
      expDays,
      password: '',
      changeLog: changeLog || '',
    },
    deviceInfo: { device: 'Unknown Device', deviceType: 'browser', ipAddr: '' },
  };
}

/**
 * Step 3 — register the app. This call also does the server-side processing
 * (rename/icon/version extraction), so it is allowed a long timeout.
 *
 * Transient upstream failures are retried without re-uploading the file; the
 * anonymous token stays valid for 15 minutes, so `attempts` saves fit
 * comfortably. `onRetry({ attempt, status, delayMs, nextAttempt })` is called
 * before each retry so the UI can say "still working".
 */
async function saveApp({
  fetchImpl = globalThis.fetch,
  apiBase = DEFAULT_API_BASE,
  signed,
  changeLog = '',
  signal,
  attempts = SAVE_ATTEMPTS,
  retryDelaysMs = SAVE_RETRY_DELAYS_MS,
  onRetry = null,
} = {}) {
  const payload = buildSavePayload(signed, { changeLog });
  for (let attempt = 1; ; attempt++) {
    const canRetry = attempt < attempts;
    const delayMs = retryDelaysMs[Math.min(attempt - 1, retryDelaysMs.length - 1)] || 0;

    let res;
    try {
      res = await fetchImpl(`${apiBase}/app/save`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${signed.token}`,
          'browser-id': signed.browserId,
        },
        body: JSON.stringify(payload),
        signal: signalWithTimeout(signal, SAVE_TIMEOUT_MS),
      });
    } catch (err) {
      if (isCancellation(signal, err)) throw cancelledError();
      if (err && err.name === 'TimeoutError') {
        /* The server may still be processing a request we abandoned — do not
         * risk a duplicate registration by retrying. */
        throw new StepError('ShareIPA did not finish processing in time.', {
          details: 'The /app/save request hit the 5-minute timeout.',
          hint: 'The upload may still complete server-side; check https://dashboard.shareipa.com or try again.',
        });
      }
      if (canRetry) {
        if (onRetry) onRetry({ attempt, status: null, delayMs, nextAttempt: attempt + 1 });
        await sleep(delayMs, signal);
        continue;
      }
      throw normalizeError(err, 'Could not reach the ShareIPA API.', "ShareIPA's website API may be down; try again later.");
    }

    const bodyText = await res.text().catch(() => '');
    if (!res.ok) {
      const msg = errorMessageFrom(bodyText);
      if (canRetry && isRetryableSaveStatus(res.status)) {
        if (onRetry) onRetry({ attempt, status: res.status, delayMs, nextAttempt: attempt + 1 });
        await sleep(delayMs, signal);
        continue;
      }
      const retriedNote = attempt > 1 ? `\n(Retried ${attempt - 1} time${attempt > 2 ? 's' : ''} after transient failures.)` : '';
      throw new StepError('ShareIPA could not register the uploaded build.', {
        details: `POST /app/save returned HTTP ${res.status}${msg ? ` — ${msg}` : ''}.${retriedNote}`,
        hint: 'The build bytes were uploaded but no install link was created. Run the upload again to retry (a fresh upload is used).',
      });
    }

    let data;
    try {
      data = JSON.parse(bodyText);
    } catch (err) {
      throw new StepError('ShareIPA returned an unexpected response.', {
        details: `save did not return JSON: ${sanitize(bodyText, { limit: 200 })}`,
        hint: 'The build may not have been registered; check https://dashboard.shareipa.com.',
      });
    }
    if (!data || !data.install_id) {
      throw new StepError('ShareIPA returned an unexpected response.', {
        details: 'save response is missing "install_id".',
        hint: 'The ShareIPA website API may have changed since this provider was written.',
      });
    }
    return {
      installId: String(data.install_id),
      adminId: data.admin_id ? String(data.admin_id) : null,
    };
  }
}

/**
 * Provider entry point — same signature as uploadToBetaDrop so the core can
 * switch providers without special cases:
 *   uploadToShareIPA(profile, filePath, name, notes,
 *                    { onProgress, onProcessing, onRetry, signal })
 *
 * `profile` is accepted for interface parity (unused: ShareIPA needs no
 * project context). `name` is unused too — ShareIPA reads the app name from
 * the binary; `notes` becomes the app's change log when provided.
 *
 * Returns { url, adminUrl, timing: { transferMs, serverMs } }.
 */
async function uploadToShareIPA(profile, filePath, name, notes, { onProgress = null, onProcessing = null, onRetry = null, signal = null, fetchImpl = globalThis.fetch, uploadFn = null, apiBase = DEFAULT_API_BASE, attempts = UPLOAD_ATTEMPTS, saveRetryDelaysMs = SAVE_RETRY_DELAYS_MS } = {}) {
  const fileType = fileTypeFor(filePath);
  const upload = uploadFn || uploadFileToPresignedUrl;

  /* 1+2 — fresh signed URL per attempt; a failed PUT is retried once because
   * nothing is registered until /app/save. */
  let signed = null;
  let transferMs = 0;
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    signed = await getSignedUrl({ fetchImpl, apiBase, fileType, signal });
    const startedAt = Date.now();
    try {
      await upload(filePath, signed.s3Url, { onProgress, signal });
      transferMs = Date.now() - startedAt;
      lastError = null;
      break;
    } catch (err) {
      lastError = normalizeError(err, 'Upload to ShareIPA storage failed.');
      if (lastError.cancelled || (signal && signal.aborted)) throw lastError;
      if (attempt === attempts) {
        if (attempts > 1) {
          lastError.details = `${lastError.details}\n(${attempts} attempts, each with a fresh ShareIPA upload URL.)`;
        }
        throw lastError;
      }
    }
  }
  if (lastError) throw lastError;

  /* 3 — register + process (with transient-failure retries; no re-upload). */
  if (onProcessing) onProcessing();
  const saveStartedAt = Date.now();
  const saved = await saveApp({ fetchImpl, apiBase, signed, changeLog: notes, signal, onRetry, retryDelaysMs: saveRetryDelaysMs });
  return {
    url: installUrlFor(saved.installId),
    adminUrl: saved.adminId ? adminUrlFor(saved.adminId) : null,
    timing: { transferMs, serverMs: Date.now() - saveStartedAt },
  };
}

module.exports = {
  DEFAULT_API_BASE,
  INSTALL_BASE,
  ADMIN_BASE,
  LINK_EXPIRY_DAYS,
  UPLOAD_ATTEMPTS,
  fileTypeFor,
  installUrlFor,
  adminUrlFor,
  sanitize,
  getSignedUrl,
  uploadFileToPresignedUrl,
  buildSavePayload,
  saveApp,
  uploadToShareIPA,
};
