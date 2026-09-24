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
 * restored, even on Ctrl+C), the BetaDrop upload and the terminal UI.
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

class StepError extends Error {
  constructor(title, { details = '', hint = '', usage = false } = {}) {
    super(title);
    this.details = details;
    this.hint = hint;
    this.usage = usage;
  }
}

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
  // No env flag: resolved later — interactive select in a TTY, otherwise the
  // current APPConfig.js isUAT value (or a usage error when neither exists).
  return {
    envName: flags[0] || null,
    verbose: args.includes('--verbose'),
    ci: args.includes('--ci'),
    check: args.includes('--check'),
    platform,
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
let cancelRequested = false;

function onCancelRequest() {
  cancelRequested = true;
  if (activeChild) {
    activeChild.kill('SIGINT');
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

/**
 * Upload via the official BetaDrop CLI in CI mode, where stdout is exactly
 * the install URL (last line taken defensively). Token is never printed.
 * The install link expires after BETADROP_LINK_EXPIRY_DAYS days.
 */
async function uploadToBetaDrop(profile, filePath, name, notes) {
  const res = await runCommand(
    'npx',
    [
      '-y',
      '@betadrop/cli',
      'publish',
      filePath,
      '--ci',
      '--name',
      name,
      '--notes',
      notes,
      '--expires-in-days',
      String(BETADROP_LINK_EXPIRY_DAYS),
    ],
    {
      cwd: profile.root,
    },
  );
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
    const providerError = (res.stderr || '').trim() || (res.stdout || '').trim() || `betadrop publish exited with code ${res.code}`;
    const isAuth = /401|unauthor|forbidden|expired|revoked|token|not logged in|login/i.test(providerError);
    throw new StepError('Upload failed.', {
      details: providerError,
      hint: isAuth
        ? 'One-time setup: run `npx -y @betadrop/cli login`, or export BETADROP_TOKEN=bd_live_xxxx\n(create the token at betadrop.app under Settings -> Developer -> API tokens).'
        : '',
    });
  }
  const lines = (res.stdout || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  const url = lines.length > 0 ? lines[lines.length - 1] : '';
  if (!/^https?:\/\/\S+$/.test(url)) {
    throw new StepError('Upload finished without a usable link.', {
      details: `BetaDrop returned no install URL.\nRaw output: ${(res.stdout || '').trim().slice(0, 500)}`,
    });
  }
  return url;
}

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

async function run(adapter, { envName = null, verbose = false, ci = false, introShown = false } = {}) {
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
    await runPlain(adapter, { env, verbose, version, notes, backend, finishRestore, startedAt });
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

    /* ---- Upload ---- */
    const s = p.spinner();
    ctx.spinner = s;
    s.start('Uploading to BetaDrop');
    let url;
    try {
      url = await uploadToBetaDrop(adapter.profile, artifact.file.fullPath, `${adapter.appName} ${adapter.label} ${env.presentWord}`, notes);
    } catch (err) {
      err.artifactReadyAt = artifactRel;
      throw err;
    }
    throwIfCancelled();
    s.stop('Upload complete');
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
    p.log.message(muted(`${env.presentWord} · ${artifact.file.name} · ${formatMB(artifact.file.size)} · BetaDrop · ${formatElapsed(Date.now() - startedAt)}`));
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
async function runPlain(adapter, { env, verbose, version, notes, backend, finishRestore, startedAt }) {
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

    plain.say('Uploading to BetaDrop...');
    const url = await uploadToBetaDrop(adapter.profile, artifact.file.fullPath, `${adapter.appName} ${adapter.label} ${env.presentWord}`, notes);
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
  run,
};
