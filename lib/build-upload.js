/**
 * rn-build-upload — shared core.
 *
 *   bin/rn-build-upload.js      CLI entry: detects the project, asks for the
 *                               platform (Android / iOS) and the environment
 *                               (Staging / Production), then builds + uploads
 *   lib/detect.js               project detection (no config file)
 *   lib/platforms/android.js    Gradle release APK
 *   lib/platforms/ios.js        Xcode release IPA
 *
 * This module owns argument parsing, the APPConfig.js backend switch (always
 * restored, even on Ctrl+C), the upload providers (BetaDrop by default,
 * ShareIPA with --provider shareipa) and the terminal UI.
 *
 * One-time BetaDrop setup (pick one):
 *   1. Interactive login (recommended locally):
 *        npx -y @betadrop/cli login
 *   2. Or headless via API token (Settings -> Developer -> API tokens on
 *      betadrop.app, value starts with `bd_live_`, shown once):
 *        export BETADROP_TOKEN=bd_live_xxxx
 *      When BETADROP_TOKEN is set it takes precedence over the stored login.
 * The token is never printed by this script.
 */

const { spawn, spawnSync } = require('node:child_process');
const { Buffer } = require('node:buffer');
const fs = require('node:fs');
const path = require('node:path');
const { StepError } = require('./errors');
const { uploadToShareIPA } = require('./providers/shareipa');

function loadPrompts() {
  try {
    return require('@clack/prompts');
  } catch (err) {
    console.error(
      "Missing UI dependency '@clack/prompts'.\n" +
        'Reinstall the tool: npm i -g github:Prince-BITNET/rn-build-upload\n' +
        '(or run `npm install` inside the rn-build-upload checkout).',
    );
    process.exit(1);
  }
}

const p = loadPrompts();

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/* BetaDrop install links stop working after this many days. */
const BETADROP_LINK_EXPIRY_DAYS = 7;

const ENVS = {
  '--uat': { markdownWord: 'Stag', presentWord: 'Staging', isUAT: true, accent: '#60A5FA' },
  '--prod': { markdownWord: 'Prod', presentWord: 'Production', isUAT: false, accent: '#FBBF24' },
};

const EXIT_USAGE = 2;
const EXIT_FAILED = 1;
const EXIT_CANCELLED = 130;

/* ------------------------------------------------------------------ */
/* Minimal palette (truecolor, TTY-aware, NO_COLOR-aware).              */
/* Clack already styles its own chrome; color is used sparingly, only  */
/* for hierarchy: environment, key values, success/error emphasis.     */
/* ------------------------------------------------------------------ */

const USE_COLOR = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

function hex(code) {
  const m = code.match(/^#([0-9a-f]{6})$/i);
  const nums = m ? [1, 3, 5].map((i) => parseInt(m[1].slice(i, i + 2), 16)) : [255, 255, 255];
  return (text) => (USE_COLOR ? `\x1b[38;2;${nums[0]};${nums[1]};${nums[2]}m${text}\x1b[39m` : text);
}

const accentFor = (env) => hex(env.accent);
const muted = hex('#94A3B8');
const bold = (text) => (USE_COLOR ? `\x1b[1m${text}\x1b[22m` : text);

/* ------------------------------------------------------------------ */
/* Business logic (UI-agnostic; failures throw StepError)              */
/* ------------------------------------------------------------------ */

/* StepError lives in lib/errors.js so the upload providers can throw it
 * without a circular import; re-exported below for compatibility. */

/** Entry descriptor for usageText(): { command, label, allowPlatform, verboseHint }. */
function usageText(entry) {
  const lines = [];
  const platformSuffix = entry.allowPlatform ? ' [--platform android|ios]' : '';
  const pad = entry.allowPlatform ? 20 : 12;
  lines.push(`${entry.command}${platformSuffix} [--uat | --prod] [--verbose] [--ci]`);
  lines.push('');
  if (entry.allowPlatform) {
    lines.push(`  ${'(no flags)'.padEnd(pad)}Ask which platform first, then which environment`);
    lines.push(`  ${'--platform android'.padEnd(pad)}Android release APK (skips the platform prompt)`);
    lines.push(`  ${'--platform ios'.padEnd(pad)}iOS release IPA (skips the platform prompt)`);
  } else {
    lines.push(`  ${'(no flag)'.padEnd(pad)}Ask which environment (preselected from APPConfig.js isUAT)`);
  }
  const example = (word) => (entry.label ? `   -> "${entry.appName || 'App'}: [${entry.label} ${word} Build](LINK)"` : '');
  lines.push(`  ${'--uat'.padEnd(pad)}Stag backend (isUAT=true)${example('Stag')}`);
  lines.push(`  ${'--prod'.padEnd(pad)}Prod backend (isUAT=false)${example('Prod')}`);
  lines.push(`  ${'--provider'.padEnd(pad)}Upload provider: betadrop (default) or shareipa`);
  lines.push(`  ${'--verbose'.padEnd(pad)}${entry.verboseHint}`);
  lines.push(`  ${'--ci'.padEnd(pad)}Plain non-interactive output for scripts/CI (no spinners or boxes)`);
  lines.push(`  ${'--check'.padEnd(pad)}Print the detected project profile and exit (no build, no upload)`);
  return lines.join('\n');
}

function parseArgs(argv, { allowPlatform = false } = {}) {
  const args = argv.filter((a) => a !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    return { help: true };
  }
  const allowed = ['--uat', '--prod', '--verbose', '--ci', '--check'];
  const unknown = [];
  let platform = null;
  let provider = DEFAULT_PROVIDER;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--platform' || a.startsWith('--platform=')) {
      if (!allowPlatform) {
        unknown.push('--platform');
        continue;
      }
      if (a === '--platform') {
        const value = args[i + 1];
        if (!value || value.startsWith('-')) {
          throw new StepError('Missing value for --platform (android or ios).', { usage: true });
        }
        platform = value;
        i++;
      } else {
        platform = a.slice('--platform='.length);
      }
    } else if (a === '--provider' || a.startsWith('--provider=')) {
      if (a === '--provider') {
        const value = args[i + 1];
        if (!value || value.startsWith('-')) {
          throw new StepError('Missing value for --provider (betadrop or shareipa).', { usage: true });
        }
        provider = value;
        i++;
      } else {
        provider = a.slice('--provider='.length);
      }
    } else if (a.startsWith('-') && !allowed.includes(a)) {
      unknown.push(a);
    }
  }
  if (unknown.length > 0) {
    throw new StepError(`Unknown option: ${unknown.join(' ')}`, { usage: true });
  }
  const flags = args.filter((a) => a === '--uat' || a === '--prod');
  if (flags.length > 1) {
    throw new StepError('Pass exactly one of --uat or --prod, not both.', { usage: true });
  }
  if (platform !== null) {
    platform = platform.toLowerCase();
    if (platform !== 'android' && platform !== 'ios') {
      throw new StepError(`Unknown platform: ${platform} (expected android or ios).`, { usage: true });
    }
  }
  provider = provider.toLowerCase();
  if (!PROVIDERS[provider]) {
    throw new StepError(`Unknown provider: ${provider} (expected betadrop or shareipa).`, { usage: true });
  }
  // No env flag: resolved later — interactive select in a TTY, otherwise the
  // current APPConfig.js isUAT value (or a usage error when neither exists).
  return {
    envName: flags[0] || null,
    verbose: args.includes('--verbose'),
    ci: args.includes('--ci'),
    check: args.includes('--check'),
    platform,
    provider,
  };
}

/** Current APPConfig.js isUAT value. Returns true/false, or null when unreadable. */
function readCurrentIsUAT(profile) {
  try {
    const content = fs.readFileSync(profile.envFile, 'utf8');
    const match = content.match(/const\s+isUAT\s*=\s*(true|false)/);
    return match ? match[1] === 'true' : null;
  } catch (err) {
    return null;
  }
}

/** Resolve the platform (--platform wins; otherwise ask). */
async function resolvePlatform(platform, ci) {
  if (platform) return platform;
  if (ci || !process.stdin.isTTY) {
    throw new StepError('Missing platform (android or ios).', {
      usage: true,
      details: 'Pass --platform android|ios when not running interactively.',
    });
  }
  const choice = await p.select({
    message: 'Select build platform',
    options: [
      { value: 'android', label: 'Android', hint: 'Gradle release APK' },
      { value: 'ios', label: 'iOS', hint: 'Xcode release IPA' },
    ],
    initialValue: 'android',
  });
  if (p.isCancel(choice)) {
    p.cancel('Operation cancelled.');
    process.exit(EXIT_CANCELLED);
  }
  return choice;
}

/** Resolve the environment: explicit flag wins; otherwise ask (TTY) or fall
 * back to the current APPConfig.js value (non-interactive contexts). */
async function resolveEnvName(profile, envName, ci, label) {
  if (envName) return envName;
  const current = readCurrentIsUAT(profile);
  if (ci || !process.stdin.isTTY) {
    if (current === null) {
      throw new StepError('Missing environment flag.', { usage: true });
    }
    const fallback = current ? '--uat' : '--prod';
    console.log(`No environment flag given; using APPConfig.js isUAT=${current} -> ${fallback}.`);
    return fallback;
  }
  const choice = await p.select({
    message: 'Select build environment',
    options: [
      { value: '--uat', label: 'Staging', hint: `isUAT=true · ${label} Stag Build` },
      { value: '--prod', label: 'Production', hint: `isUAT=false · ${label} Prod Build` },
    ],
    initialValue: current === false ? '--prod' : '--uat',
  });
  if (p.isCancel(choice)) {
    p.cancel('Operation cancelled.');
    process.exit(EXIT_CANCELLED);
  }
  return choice;
}

/** Point APPConfig.js at the requested env. Returns { restore, patched, previous }. */
function setIsUAT(profile, wantUAT) {
  const envFile = profile.envFile;
  if (!fs.existsSync(envFile)) {
    throw new StepError('Cannot determine the app backend.', {
      details: `APPConfig.js not found at ${envFile}; refusing to build an unknown backend.`,
    });
  }
  const original = fs.readFileSync(envFile, 'utf8');
  const match = original.match(/const\s+isUAT\s*=\s*(true|false)/);
  if (!match) {
    throw new StepError('Cannot determine the app backend.', {
      details: `Could not find "const isUAT = true|false" in ${envFile}; refusing to guess the backend.`,
    });
  }
  const previous = match[1] === 'true';
  if (previous === wantUAT) {
    return { restore: () => {}, patched: false, previous };
  }
  fs.writeFileSync(envFile, original.replace(/const\s+isUAT\s*=\s*(true|false)/, `const isUAT = ${wantUAT}`));
  return {
    restore: () => {
      fs.writeFileSync(envFile, original);
    },
    patched: true,
    previous,
  };
}

/* Async spawn wrapper so Ctrl+C can kill the child and restore state.
 * Resolves with { code, signal, stdout, stderr }; never throws for exits. */
let activeChild = null;
let activeAbort = null;
let cancelRequested = false;

function onCancelRequest() {
  cancelRequested = true;
  if (activeChild) {
    activeChild.kill('SIGINT');
  }
  if (activeAbort) {
    try {
      activeAbort.abort();
    } catch (err) {
      /* already aborted */
    }
  }
}

function runCommand(cmd, args, { cwd, streamOutput, onOutput }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: streamOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    activeChild = child;
    let stdout = '';
    let stderr = '';
    if (!streamOutput) {
      child.stdout.on('data', (d) => {
        stdout += d.toString();
        if (onOutput) onOutput(d.toString(), 'out');
      });
      child.stderr.on('data', (d) => {
        stderr += d.toString();
        if (onOutput) onOutput(d.toString(), 'err');
      });
    }
    child.on('error', (err) => {
      activeChild = null;
      resolve({ code: null, signal: null, stdout, stderr, spawnError: err });
    });
    child.on('close', (code, signal) => {
      activeChild = null;
      resolve({ code, signal, stdout, stderr });
    });
  });
}

function throwIfCancelled() {
  if (cancelRequested) {
    const err = new StepError('Operation cancelled.');
    err.cancelled = true;
    throw err;
  }
}

function formatMB(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Verify a ZIP container (APK / IPA) by its magic bytes. */
function assertZipMagic(filePath, artifactWord) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    if (buf[0] !== 0x50 || buf[1] !== 0x4b || buf[2] !== 0x03 || buf[3] !== 0x04) {
      throw new StepError(`Release ${artifactWord} looks invalid.`, {
        details: `File does not look like a ${artifactWord} (bad ZIP magic): ${filePath}`,
      });
    }
  } finally {
    fs.closeSync(fd);
  }
}

/* The CLI renders `  ████░░ 42% · 40.3/95.0 MB` progress frames on stderr,
 * updated in place on a TTY and concatenated (no separator) when piped.
 * On a TTY it also emits chalk colors and cli-progress cursor moves. */
const UPLOAD_FRAME_RE = /(\d{1,3})% · ([\d.]+)\/([\d.]+) MB/g;
const ANSI_RE = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b[78]/g;

/** Incrementally read the CLI's stderr progress frames; returns the latest
 * { percent, mb, totalMb, speed } per push (a chunk can split a frame). */
function createUploadTracker() {
  let carry = '';
  let first = null;
  let last = null;
  let sentAt = null;
  let frames = 0;
  return {
    push(chunk) {
      const buf = carry + chunk;
      UPLOAD_FRAME_RE.lastIndex = 0;
      let match;
      let found = null;
      let end = 0;
      let matched = 0;
      while ((match = UPLOAD_FRAME_RE.exec(buf)) !== null) {
        found = { percent: Number(match[1]), mb: Number(match[2]), totalMb: Number(match[3]) };
        end = UPLOAD_FRAME_RE.lastIndex;
        matched++;
      }
      carry = buf.slice(end);
      if (carry.length > 1024) carry = carry.slice(-1024);
      if (!found) return null;
      const at = Date.now();
      if (!first) first = { at, mb: found.mb };
      last = { at, ...found };
      frames += matched;
      if (found.percent >= 100 && sentAt === null) sentAt = at;
      const elapsed = (at - first.at) / 1000;
      const speed = elapsed > 0.5 ? (found.mb - first.mb) / elapsed : 0;
      return { percent: found.percent, mb: found.mb, totalMb: found.totalMb, speed: speed > 0.05 ? speed : null };
    },
    /** Split the upload into transfer time and the wait for BetaDrop to
     * accept/process the build once the bytes went to the socket. */
    stats(exitAt) {
      if (!first) return null;
      const doneAt = sentAt ?? last.at;
      return { transferMs: Math.max(0, doneAt - first.at), serverMs: Math.max(0, exitAt - doneAt), frames };
    },
  };
}

/** The install URL from non-CI stdout: the labelled "Install link" line the
 * CLI prints, else any install-shaped URL (short /i/<id> form included). */
function extractInstallUrl(stdout) {
  const text = (stdout || '').replace(ANSI_RE, '');
  const labelled = text.match(/Install link\s+(https?:\/\/\S+)/i);
  if (labelled) return labelled[1];
  const any = text.match(/https?:\/\/\S+\/(?:install\/?\?i=|i\/)[A-Za-z0-9_-]+/);
  return any ? any[0] : null;
}

/** CLI output with ANSI colors, progress frames, spinner frames and control
 * characters removed — leaves the readable lines for the error card. Works on
 * both the piped stderr (plain) and the PTY-merged stream. */
function cleanCliOutput(output) {
  return (output || '')
    .replace(ANSI_RE, '')
    .replace(/[\u2800-\u28FF]/g, '') /* ora/npm spinner frames */
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '') /* control chars */
    .replace(/\r/g, '\n')
    .replace(/[█░]{1,60} ?\d{1,3}% · [\d.]+\/[\d.]+ MB/g, '')
    .split(/\n+/)
    .map((line) => line.trim().replace(/^✗\s*/, ''))
    .filter((line) => line && !/^npm (warn|notice) exec /i.test(line) && !/^Uploading .*…$/.test(line))
    .join('\n')
    .trim();
}

/**
 * Upload via the official BetaDrop CLI.
 *
 * Interactive runs put the CLI on a PTY (`script -q /dev/null`) for one
 * reason: cli-progress parks its bar unless its stream is a real TTY
 * (noTTYOutput is off), even without `--ci` — so a plain pipe gets no
 * progress at all. On a PTY the CLI renders its real upload bar, which the
 * caller mirrors on a Clack progress bar; the install URL is read back from
 * the "Install link" line. On non-macOS hosts the CLI runs piped instead
 * (upload still works, just without the live bar).
 *
 * `--ci` runs skip all of that and keep the machine contract — stdout is
 * exactly the install URL (last line taken defensively). Token is never
 * printed. The install link expires after BETADROP_LINK_EXPIRY_DAYS days.
 */
async function uploadToBetaDrop(profile, filePath, name, notes, { ci = false, onProgress = null } = {}) {
  const cliArgs = [
    'publish',
    filePath,
    '--name',
    name,
    '--notes',
    notes,
    '--expires-in-days',
    String(BETADROP_LINK_EXPIRY_DAYS),
  ];
  if (ci) cliArgs.push('--ci');
  const baseArgs = ['-y', '@betadrop/cli', ...cliArgs];

  const usePty = !ci && process.platform === 'darwin';
  const command = usePty ? 'script' : 'npx';
  const args = usePty ? ['-q', '/dev/null', 'npx', ...baseArgs] : baseArgs;

  const tracker = ci ? null : createUploadTracker();
  const res = await runCommand(command, args, {
    cwd: profile.root,
    onOutput: (chunk) => {
      if (!tracker || !onProgress) return;
      const progress = tracker.push(chunk);
      if (progress) onProgress(progress);
    },
  });
  throwIfCancelled();
  if (res.spawnError) {
    const err = res.spawnError;
    throw new StepError('Could not start the BetaDrop CLI.', {
      details:
        err.code === 'ENOENT'
          ? 'Could not run `npx` (Node 18+ required for @betadrop/cli). Install Node and retry.'
          : err.message,
    });
  }
  if (res.signal) {
    const err = new StepError('Operation cancelled.');
    err.cancelled = true;
    throw err;
  }
  if (res.code !== 0) {
    const cleaned = ci
      ? (res.stderr || '').trim()
      : cleanCliOutput(res.stderr) || cleanCliOutput(res.stdout);
    const providerError = cleaned || (res.stdout || '').trim() || `betadrop publish exited with code ${res.code}`;
    const isAuth = /401|unauthor|forbidden|expired|revoked|token|not logged in|login/i.test(providerError);
    throw new StepError('Upload failed.', {
      details: providerError,
      hint: isAuth
        ? 'One-time setup: run `npx -y @betadrop/cli login`, or export BETADROP_TOKEN=bd_live_xxxx\n(create the token at betadrop.app under Settings -> Developer -> API tokens).'
        : '',
    });
  }
  let url;
  if (ci) {
    const lines = (res.stdout || '')
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
    url = lines.length > 0 ? lines[lines.length - 1] : '';
  } else {
    url = extractInstallUrl(res.stdout) || extractInstallUrl(res.stderr);
  }
  if (!url || !/^https?:\/\/\S+$/.test(url)) {
    throw new StepError('Upload finished without a usable link.', {
      details: `BetaDrop returned no install URL.\nRaw output: ${(res.stdout || '').trim().slice(0, 500)}`,
      hint: 'The upload itself may have succeeded — check recent builds with `npx -y @betadrop/cli builds list`.',
    });
  }
  return { url, timing: tracker ? tracker.stats(Date.now()) : null };
}

/* ------------------------------------------------------------------ */
/* Upload providers                                                    */
/* ------------------------------------------------------------------ */

/**
 * betadrop (default) — official CLI with mirrored live progress; behaviour
 * unchanged. shareipa — drives the undocumented ShareIPA website API (no
 * account, no official API): see lib/providers/shareipa.js.
 *
 * Both share the signature
 *   upload(profile, filePath, name, notes, { ci, onProgress, onProcessing, signal })
 * and return { url, timing?, adminUrl? }.
 */
const PROVIDERS = {
  betadrop: { key: 'betadrop', label: 'BetaDrop', upload: uploadToBetaDrop },
  shareipa: { key: 'shareipa', label: 'ShareIPA', upload: uploadToShareIPA },
};

const DEFAULT_PROVIDER = 'betadrop';

function buildMarkdown(appName, label, env, url) {
  return `${appName}: [${label} ${env.markdownWord} Build](${url})`;
}

/** Copy the full Markdown string. Returns false (non-fatal) if pbcopy fails. */
function copyToClipboard(text) {
  const res = spawnSync('pbcopy', [], { input: text, encoding: 'utf8' });
  if (res.error || res.status !== 0) {
    return false;
  }
  return true;
}

function formatElapsed(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

/** Stop message for the upload step: "Upload complete · 12.4s transfer ·
 * 8.0s processing" (plain "Upload complete" when no frames were printed). */
function uploadStopMessage(timing) {
  if (!timing) return 'Upload complete';
  const duration = (ms) => (ms < 10000 ? `${(ms / 1000).toFixed(1)}s` : formatElapsed(ms));
  return `Upload complete · ${duration(timing.transferMs)} transfer · ${duration(timing.serverMs)} processing`;
}

/** Project-relative path when the file lives inside the repo, absolute otherwise. */
function displayPath(root, fullPath) {
  const rel = path.relative(root, fullPath);
  return rel.startsWith('..') ? fullPath : rel;
}

/** Best-effort removal of adapter-held temp files (e.g. the iOS IPA staging dir). */
function cleanupArtifact(artifact) {
  if (!artifact.cleanup) return;
  try {
    artifact.cleanup();
  } catch (err) {
    /* best-effort; the upload already succeeded */
  }
}

/* ------------------------------------------------------------------ */
/* Presentation (Clack)                                                */
/* ------------------------------------------------------------------ */

function showIntro(adapter) {
  p.intro(`${adapter.appName}  ·  ${adapter.label} Build & Distribution`);
}

function showEnv(env, version, adapter) {
  const accent = accentFor(env);
  p.note(
    `${accent(bold(`● ${env.presentWord}`))}\n${muted(`${adapter.label} · Backend isUAT=${env.isUAT} · v${version.versionName} (build ${version.versionCode})`)}`,
    'Environment',
  );
}

function renderUsageError(err, entry) {
  p.log.error(err.message);
  if (err.details) {
    p.log.message(muted(err.details));
  }
  p.note(usageText(entry), 'Usage');
  process.exit(EXIT_USAGE);
}

function renderStepError(err, ctx, adapter) {
  if (err.cancelled || cancelRequested) {
    finishCancelled(ctx);
    return;
  }
  if (ctx.spinner) {
    // The spinner line itself becomes the error line; don't repeat it below.
    ctx.spinner.error(err.message);
    ctx.spinner = null;
  } else {
    if (ctx.buildLog) {
      ctx.buildLog.error(err.buildFailed ? adapter.buildFailedTitle : 'Failed');
      ctx.buildLog = null;
    }
    p.log.error(err.message);
  }
  if (err.details) {
    p.note(err.details, 'Details');
  }
  if (err.hint) {
    p.log.info(err.hint);
  }
  if (err.artifactReadyAt) {
    p.log.message(muted(`${adapter.artifactWord} built successfully: ${err.artifactReadyAt} — fix the issue above and re-run, or upload it manually.`));
  }
  p.outro('Build did not complete');
  process.exit(EXIT_FAILED);
}

function finishCancelled(ctx) {
  try {
    if (ctx.spinner) ctx.spinner.stop('Cancelled');
    if (ctx.buildLog) ctx.buildLog.error('Operation cancelled');
  } catch (err) {
    /* UI already settled */
  }
  p.cancel('Operation cancelled.');
  process.exit(EXIT_CANCELLED);
}

/* Plain output for --ci (scripts/CI): no spinners, boxes, or colors. */
const plain = {
  say: (msg) => console.log(msg),
  fail: (msg) => console.error(msg),
};

/* ------------------------------------------------------------------ */
/* Orchestration                                                       */
/* ------------------------------------------------------------------ */

/** Read version info, showing a spinner only for adapters that declare
 * settingsMessage (slow reads, e.g. xcodebuild -showBuildSettings). */
async function readVersion(adapter, ci) {
  if (!adapter.settingsMessage) {
    return adapter.readVersionInfo();
  }
  if (ci) {
    plain.say(`${adapter.settingsMessage}...`);
    return adapter.readVersionInfo();
  }
  const s = p.spinner();
  s.start(adapter.settingsMessage);
  try {
    const version = await adapter.readVersionInfo();
    s.stop(adapter.settingsDone);
    return version;
  } catch (err) {
    s.stop('Could not read the project settings');
    throw err;
  }
}

async function run(adapter, { envName = null, verbose = false, ci = false, introShown = false, provider = DEFAULT_PROVIDER } = {}) {
  const startedAt = Date.now();

  /* Ctrl+C: kill the child, restore APPConfig, leave the terminal clean. */
  process.on('SIGINT', () => onCancelRequest());
  process.on('SIGTERM', () => onCancelRequest());

  let shownIntro = introShown;
  if (!ci && !shownIntro) {
    showIntro(adapter);
    shownIntro = true;
  }

  let version;
  try {
    version = await readVersion(adapter, ci);
  } catch (err) {
    if (ci) {
      plain.fail(err.message);
      if (err.details) plain.fail(err.details);
      if (err.hint) plain.fail(err.hint);
      process.exit(EXIT_FAILED);
    }
    renderStepError(err, {}, adapter);
    return;
  }

  /* Resolve the environment: explicit flag wins; otherwise ask (TTY) or
   * fall back to the current APPConfig.js value (non-interactive). */
  let resolvedName;
  try {
    resolvedName = await resolveEnvName(adapter.profile, envName, ci, adapter.label);
  } catch (err) {
    if (ci) {
      plain.fail(err.message);
      plain.fail(err.usage ? usageText(adapter.entry) : err.details || '');
      process.exit(err.usage ? EXIT_USAGE : EXIT_FAILED);
    }
    renderUsageError(err, adapter.entry);
    return;
  }
  const env = ENVS[resolvedName];
  const notes = `${adapter.appName} ${adapter.label} ${env.presentWord} Build — v${version.versionName} (build ${version.versionCode})`;

  /* ---- Prepare backend selection (always restored) ---- */
  let backend;
  try {
    backend = setIsUAT(adapter.profile, env.isUAT);
  } catch (err) {
    if (ci) {
      plain.fail(err.message);
      if (err.details) plain.fail(err.details);
      process.exit(EXIT_FAILED);
    }
    renderStepError(err, {}, adapter);
    return;
  }

  const finishRestore = () => {
    try {
      backend.restore();
    } catch (err) {
      /* restore is best-effort; the build result matters more */
    }
  };

  if (ci) {
    await runPlain(adapter, { env, verbose, version, notes, backend, finishRestore, startedAt, provider });
    return;
  }

  showEnv(env, version, adapter);
  if (backend.patched) {
    p.log.message(muted(`Backend set to isUAT=${env.isUAT} for this build (restoring afterwards)`));
  }

  const ctx = {};
  try {
    /* ---- Build (compact live view; hidden on success, kept on failure) ---- */
    if (verbose) {
      const s = p.spinner();
      ctx.spinner = s;
      s.start(adapter.verboseBuildStart);
      await adapter.build({ verbose: true });
      throwIfCancelled();
      s.stop(`Release ${adapter.artifactWord} built in ${formatElapsed(Date.now() - startedAt)}`);
      ctx.spinner = null;
    } else {
      const buildLog = p.taskLog({ title: adapter.buildLogTitle, limit: 6 });
      ctx.buildLog = buildLog;
      let carry = '';
      await adapter.build({
        verbose: false,
        onOutput: (chunk) => {
          carry += chunk;
          const lines = carry.split(/\r?\n/);
          carry = lines.pop();
          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed || /UP-TO-DATE$/.test(trimmed)) continue;
            buildLog.message(trimmed);
          }
        },
      });
      throwIfCancelled();
      buildLog.success(`Release ${adapter.artifactWord} built in ${formatElapsed(Date.now() - startedAt)}`);
      ctx.buildLog = null;
    }
    finishRestore();
    if (backend.patched) {
      p.log.message(muted(`APPConfig restored (isUAT=${backend.previous})`));
    }

    /* ---- Locate / package the artifact ---- */
    const artifact = await adapter.produceArtifact();
    if (artifact.fallback) {
      p.log.warn(`${adapter.expectedName} not present; using the only ${adapter.artifactWord} available: ${artifact.file.name}`);
    }
    const artifactRel = displayPath(adapter.profile.root, artifact.file.fullPath);

    /* ---- Upload (live percentage; both providers emit real progress) ---- */
    const uploadProvider = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
    const up = p.progress({ style: 'light', size: 22 });
    ctx.spinner = up;
    up.start(`Uploading to ${uploadProvider.label}`);
    let idleTimer = null;
    let lastPercent = 0;
    const onUploadProgress = ({ percent, mb, totalMb, speed }) => {
      /* Speed only when the line has room for it (keeps narrow terminals
       * from wrapping the spinner). */
      const withSpeed = speed && (!process.stdout.columns || process.stdout.columns >= 90);
      const message =
        `Uploading to ${uploadProvider.label} · ${percent}% · ${mb.toFixed(1)}/${totalMb.toFixed(1)} MB` +
        (withSpeed ? ` · ${speed.toFixed(1)} MB/s` : '');
      if (percent > lastPercent) {
        up.advance(percent - lastPercent, message);
        lastPercent = percent;
      } else {
        up.advance(0, message);
      }
      /* BetaDrop's CLI parks its bar at 100% while it waits for the server to
       * process the build — say so instead of looking stuck. ShareIPA reports
       * that phase itself through onProcessing (after the PUT completes). */
      if (uploadProvider.key !== 'betadrop') return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer =
        percent >= 99
          ? setTimeout(() => {
              idleTimer = null;
              up.advance(0, `Processing on ${uploadProvider.label}…`);
            }, 2500)
          : null;
    };

    /* Ctrl+C aborts an in-flight ShareIPA fetch/upload; spawned CLIs are
     * killed through activeChild instead. */
    const abort = new AbortController();
    activeAbort = abort;
    let url;
    let timing;
    try {
      ({ url, timing } = await uploadProvider.upload(
        adapter.profile,
        artifact.file.fullPath,
        `${adapter.appName} ${adapter.label} ${env.presentWord}`,
        notes,
        {
          onProgress: onUploadProgress,
          onProcessing: () => up.advance(0, `Processing on ${uploadProvider.label}…`),
          signal: abort.signal,
        },
      ));
    } catch (err) {
      if (idleTimer) clearTimeout(idleTimer);
      err.artifactReadyAt = artifactRel;
      throw err;
    } finally {
      activeAbort = null;
    }
    if (idleTimer) clearTimeout(idleTimer);
    throwIfCancelled();
    up.stop(uploadStopMessage(timing));
    ctx.spinner = null;
    cleanupArtifact(artifact);

    /* ---- Share message + clipboard ---- */
    const markdown = buildMarkdown(adapter.appName, adapter.label, env, url);
    const copied = copyToClipboard(markdown);
    if (copied) {
      p.log.success('Copied to clipboard');
    } else {
      p.log.warn('Clipboard unavailable — copy the message below manually');
    }
    p.note(url, 'Install URL');
    p.note(markdown, copied ? 'Share message · copied' : 'Share message');
    p.log.message(muted(`${env.presentWord} · ${artifact.file.name} · ${formatMB(artifact.file.size)} · ${uploadProvider.label} · ${formatElapsed(Date.now() - startedAt)}`));
    p.outro(`${env.presentWord} build ready — paste it anywhere with ⌘V`);
  } catch (err) {
    finishRestore();
    if (err.cancelled || cancelRequested) {
      finishCancelled(ctx);
      return;
    }
    if (err.buildFailed && ctx.buildLog) {
      ctx.buildLog.error(adapter.buildFailedTitle);
      ctx.buildLog = null;
    }
    renderStepError(err, ctx, adapter);
  }
}

/* Non-interactive variant: same steps, plain line-oriented output. */
async function runPlain(adapter, { env, verbose, version, notes, backend, finishRestore, startedAt, provider = DEFAULT_PROVIDER }) {
  const uploadProvider = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
  plain.say(`${adapter.appName} ${adapter.label} ${env.presentWord} build (v${version.versionName}, build ${version.versionCode})`);
  try {
    plain.say(`Building ${adapter.label} release...`);
    await adapter.build({ verbose });
    throwIfCancelled();
    plain.say(`Build complete in ${formatElapsed(Date.now() - startedAt)}`);
    finishRestore();

    const artifact = await adapter.produceArtifact();
    if (artifact.fallback) {
      plain.say(`Note: ${adapter.expectedName} not present; using the only ${adapter.artifactWord} available: ${artifact.file.name}`);
    }
    const artifactLocation = displayPath(adapter.profile.root, artifact.file.fullPath);
    const stagingNote = artifact.cleanup ? ' — staging copy, removed after upload' : '';
    plain.say(`${adapter.artifactWord}: ${artifactLocation} (${formatMB(artifact.file.size)})${stagingNote}`);

    plain.say(`Uploading to ${uploadProvider.label}...`);
    const abort = new AbortController();
    activeAbort = abort;
    let url;
    try {
      ({ url } = await uploadProvider.upload(
        adapter.profile,
        artifact.file.fullPath,
        `${adapter.appName} ${adapter.label} ${env.presentWord}`,
        notes,
        {
          ci: true,
          onProcessing: () => plain.say(`Processing on ${uploadProvider.label}...`),
          signal: abort.signal,
        },
      ));
    } finally {
      activeAbort = null;
    }
    throwIfCancelled();
    cleanupArtifact(artifact);
    const markdown = buildMarkdown(adapter.appName, adapter.label, env, url);
    plain.say(markdown);
    if (copyToClipboard(markdown)) {
      plain.say('Copied to clipboard');
    } else {
      plain.say('Clipboard unavailable — copy the message above manually');
    }
  } catch (err) {
    finishRestore();
    if (err.cancelled || cancelRequested) {
      plain.fail('Operation cancelled.');
      process.exit(EXIT_CANCELLED);
    }
    if (err.usage) {
      plain.fail(err.message);
      plain.fail(usageText(adapter.entry));
      process.exit(EXIT_USAGE);
    }
    plain.fail(err.message);
    if (err.details) plain.fail(err.details);
    if (err.hint) plain.fail(err.hint);
    if (err.artifactReadyAt) {
      plain.fail(`${adapter.artifactWord} built successfully: ${err.artifactReadyAt} — upload it manually once the issue above is fixed.`);
    }
    process.exit(EXIT_FAILED);
  }
}

module.exports = {
  ENVS,
  BETADROP_LINK_EXPIRY_DAYS,
  EXIT_USAGE,
  EXIT_FAILED,
  EXIT_CANCELLED,
  StepError,
  PROVIDERS,
  DEFAULT_PROVIDER,
  p,
  plain,
  usageText,
  parseArgs,
  resolvePlatform,
  renderUsageError,
  renderStepError,
  runCommand,
  throwIfCancelled,
  assertZipMagic,
  formatMB,
  createUploadTracker,
  extractInstallUrl,
  cleanCliOutput,
  run,
  runPlain,
};
