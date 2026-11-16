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
 * restored, even on Ctrl+C), the upload providers (AppShare by default,
 * ShareIPA / BetaDrop with --provider) and the terminal UI.
 *
 * One-time BetaDrop setup (only needed with --provider betadrop; pick one):
 *   1. Interactive login (recommended locally):
 *        npx -y @betadrop/cli@0.4.0 login
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
const lifecycle = require('./lifecycle');
const { acquireProjectLock } = require('./lock');
const { createRecorder, sha256File } = require('./result');
const { uploadToShareIPA } = require('./providers/shareipa');
const { uploadToAppShare, preflightAppShare, parseExpiry, EXPIRY_CHOICES, DEFAULT_EXPIRY_DAYS } = require('./providers/appshare');

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

/* Exact @betadrop/cli release run through npx — never an unpinned "latest".
 * 0.4.0 (2026-09-16) was verified to provide `publish <file> --name --notes
 * --expires-in-days --ci`, with --ci printing the install URL as the last
 * stdout line. Bump deliberately, after re-checking that contract. */
const BETADROP_CLI_VERSION = '0.4.0';
const BETADROP_CLI_PACKAGE = `@betadrop/cli@${BETADROP_CLI_VERSION}`;

const ENVS = {
  '--uat': { markdownWord: 'Stag', presentWord: 'Staging', isUAT: true, accent: '#60A5FA' },
  '--prod': { markdownWord: 'Prod', presentWord: 'Production', isUAT: false, accent: '#FBBF24' },
};

const EXIT_USAGE = 2;
const EXIT_FAILED = 1;
/* Another ship run holds this project's lock. */
const EXIT_LOCKED = 3;
/* The run succeeded but --output-json could not be written. */
const EXIT_RESULT_WRITE = 4;
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
  const platformSuffix = entry.allowPlatform ? ' [--platform android|ios|android,ios]' : '';
  const pad = entry.allowPlatform ? 24 : 12;
  lines.push(`${entry.command}${platformSuffix} [--uat | --prod] [--verbose] [--ci] [--output-json <path>]`);
  lines.push('');
  if (entry.allowPlatform) {
    lines.push(`  ${'(no flags)'.padEnd(pad)}Ask which platform(s) first, then which environment`);
    lines.push(`  ${'--platform android'.padEnd(pad)}Android release APK only`);
    lines.push(`  ${'--platform ios'.padEnd(pad)}iOS release IPA only`);
    lines.push(`  ${'--platform android,ios'.padEnd(pad)}Both — asks Sequential or Parallel`);
  } else {
    lines.push(`  ${'(no flag)'.padEnd(pad)}Ask which environment (preselected from APPConfig.js isUAT)`);
  }
  const example = (word) => (entry.label ? `   -> "${entry.shareName || entry.appName || 'App'} (${word.toUpperCase()}): [${entry.label} Build Link](LINK)"` : '');
  lines.push(`  ${'--uat'.padEnd(pad)}Stag backend (isUAT=true)${example('Stag')}`);
  lines.push(`  ${'--prod'.padEnd(pad)}Prod backend (isUAT=false)${example('Prod')}`);
  lines.push(`  --provider <provider>`);
  lines.push(`  ${''.padEnd(pad)}Upload provider (default: ${DEFAULT_PROVIDER}):`);
  lines.push(`  ${''.padEnd(pad)}  appshare   AppShare — needs APPSHARE_EMAIL / APPSHARE_PASSWORD`);
  lines.push(`  ${''.padEnd(pad)}  shareipa   ShareIPA — website API flow, no setup`);
  lines.push(`  ${''.padEnd(pad)}  betadrop   BetaDrop — official CLI, one-time login`);
  lines.push(`  --expires-in-days <days|never>`);
  lines.push(`  ${''.padEnd(pad)}AppShare link lifetime: ${EXPIRY_CHOICES.join(', ')} or never (default: ${DEFAULT_EXPIRY_DAYS})`);
  lines.push(`  ${'--verbose'.padEnd(pad)}${entry.verboseHint}`);
  lines.push(`  ${'--ci'.padEnd(pad)}Plain non-interactive output for scripts/CI (needs --platform and --uat|--prod; no clipboard)`);
  lines.push(`  --output-json <path>`);
  lines.push(`  ${''.padEnd(pad)}Write the machine-readable run result (JSON) to <path>`);
  lines.push(`  ${'--check'.padEnd(pad)}Print the detected project profile and exit (no build, no upload)`);
  const uploadExample = entry.allowPlatform ? `${entry.command} --platform android --uat` : `${entry.command} --uat`;
  lines.push('');
  lines.push('  Examples:');
  lines.push(`    ${uploadExample}  -> AppShare (default, 90-day link)`);
  lines.push(`    ${uploadExample} --expires-in-days never  -> AppShare, link never expires`);
  lines.push(`    ${uploadExample} --provider shareipa  -> ShareIPA`);
  lines.push(`    ${uploadExample} --provider betadrop  -> BetaDrop`);
  if (entry.allowPlatform) {
    lines.push(`    ${entry.command} --platform android,ios --uat  -> both platforms, one run`);
  }
  return lines.join('\n');
}

function parseArgs(argv, { allowPlatform = false } = {}) {
  const args = argv.filter((a) => a !== '--');
  if (args.includes('--help') || args.includes('-h')) {
    return { help: true };
  }
  const allowed = ['--uat', '--prod', '--verbose', '--ci', '--check'];
  const unknown = [];
  let platforms = null;
  let provider = DEFAULT_PROVIDER;
  let outputJson = null;
  let expiresInDays = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--expires-in-days' || a.startsWith('--expires-in-days=')) {
      const value = a === '--expires-in-days' ? args[++i] : a.slice('--expires-in-days='.length);
      if (!value || value.startsWith('-')) {
        throw new StepError(`Missing value for --expires-in-days (${EXPIRY_CHOICES.join(', ')} or never).`, { usage: true });
      }
      expiresInDays = parseExpiry(value);
    } else if (a === '--output-json' || a.startsWith('--output-json=')) {
      const value = a === '--output-json' ? args[++i] : a.slice('--output-json='.length);
      if (!value || value.startsWith('-')) {
        throw new StepError('Missing value for --output-json (a file path).', { usage: true });
      }
      outputJson = value;
    } else if (a === '--platform' || a.startsWith('--platform=')) {
      if (!allowPlatform) {
        unknown.push('--platform');
        continue;
      }
      if (a === '--platform') {
        const value = args[i + 1];
        if (!value || value.startsWith('-')) {
          throw new StepError('Missing value for --platform (android, ios, or android,ios).', { usage: true });
        }
        platforms = [...(platforms || []), ...value.split(',')];
        i++;
      } else {
        platforms = [...(platforms || []), ...a.slice('--platform='.length).split(',')];
      }
    } else if (a === '--provider' || a.startsWith('--provider=')) {
      if (a === '--provider') {
        const value = args[i + 1];
        if (!value || value.startsWith('-')) {
          throw new StepError(`Missing value for --provider (${Object.keys(PROVIDERS).join(' or ')}).`, { usage: true });
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
  if (platforms !== null) {
    /* One or both, comma-separated: --platform android,ios */
    platforms = platforms.map((p) => p.trim().toLowerCase()).filter(Boolean);
    for (const p of platforms) {
      if (p !== 'android' && p !== 'ios') {
        throw new StepError(`Unknown platform: ${p} (expected android, ios, or android,ios).`, { usage: true });
      }
    }
    platforms = [...new Set(platforms)]; /* de-dupe, keep the given order */
    if (platforms.length === 0) {
      throw new StepError('Missing value for --platform (android, ios, or android,ios).', { usage: true });
    }
  }
  provider = provider.toLowerCase();
  if (!PROVIDERS[provider]) {
    throw new StepError(`Unknown provider: ${provider} (expected ${Object.keys(PROVIDERS).join(' or ')}).`, { usage: true });
  }
  if (expiresInDays !== null && provider !== 'appshare') {
    throw new StepError('--expires-in-days is only supported with --provider appshare.', { usage: true });
  }
  // No env flag: resolved later — interactive select in a TTY, otherwise the
  // current APPConfig.js isUAT value (or a usage error when neither exists).
  return {
    envName: flags[0] || null,
    verbose: args.includes('--verbose'),
    ci: args.includes('--ci'),
    check: args.includes('--check'),
    platforms,
    provider,
    outputJson,
    expiresInDays: provider === 'appshare' ? (expiresInDays ?? DEFAULT_EXPIRY_DAYS) : null,
  };
}

/** --output-json value from raw argv, for reporting a usage error that
 * parseArgs threw before returning it. */
function peekOutputJson(argv) {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--output-json') return argv[i + 1] && !argv[i + 1].startsWith('-') ? argv[i + 1] : null;
    if (a.startsWith('--output-json=')) return a.slice('--output-json='.length) || null;
  }
  return null;
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

/**
 * Resolve the platforms. `--platform` wins (one or both, comma-separated);
 * otherwise ask with checkboxes (both unchecked by default — the user picks
 * one or both). At least one is required.
 */
async function resolvePlatforms(profile, platforms, ci) {
  if (platforms) return platforms;
  if (ci || !process.stdin.isTTY) {
    throw new StepError('Missing platform (android or ios).', {
      usage: true,
      details: 'Pass --platform android, --platform ios, or --platform android,ios when not running interactively.',
    });
  }
  const options = [];
  if (profile.android) options.push({ value: 'android', label: 'Android', hint: 'Gradle release APK' });
  if (profile.ios) options.push({ value: 'ios', label: 'iOS', hint: 'Xcode release IPA' });
  const choice = await p.multiselect({
    message: 'Select build platform(s)',
    options,
    required: true,
  });
  if (p.isCancel(choice)) {
    p.cancel('Operation cancelled.');
    process.exit(EXIT_CANCELLED);
  }
  return choice;
}

/**
 * How to run two platforms — asked only when BOTH are selected (a single
 * platform goes straight through, exactly like before). Non-interactive runs
 * are always sequential.
 */
async function resolveMode(adapters, ci) {
  if (adapters.length < 2 || ci || !process.stdin.isTTY) return 'sequential';
  const choice = await p.select({
    message: `Build ${adapters.map((a) => a.label).join(' + ')} how?`,
    options: [
      { value: 'sequential', label: 'Sequential', hint: 'build + upload one, then the other' },
      { value: 'parallel', label: 'Parallel', hint: 'build + upload both at the same time' },
    ],
    initialValue: 'sequential',
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
  if (ci) {
    /* CI builds only what was asked for, never whatever the checkout holds. */
    throw new StepError('Missing environment flag.', {
      usage: true,
      details: 'Pass --uat or --prod with --ci.',
    });
  }
  if (!process.stdin.isTTY) {
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
      { value: '--uat', label: 'Staging', hint: `isUAT=true · ${label} (STAG)` },
      { value: '--prod', label: 'Production', hint: `isUAT=false · ${label} (PROD)` },
    ],
    initialValue: current === false ? '--prod' : '--uat',
  });
  if (p.isCancel(choice)) {
    p.cancel('Operation cancelled.');
    process.exit(EXIT_CANCELLED);
  }
  return choice;
}

const IS_UAT_RE = /const\s+isUAT\s*=\s*(true|false)/;

/** Replace `file` atomically (temp file + rename), keeping its mode. */
function writeFileAtomic(file, content) {
  let mode = 0o644;
  try {
    mode = fs.statSync(file).mode & 0o7777;
  } catch (err) {
    /* new file */
  }
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.ship-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, content, { mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, file);
  } catch (err) {
    try {
      fs.unlinkSync(tmp);
    } catch (unlinkErr) {
      /* never created */
    }
    throw err;
  }
}

/**
 * Point APPConfig.js at the requested env. Returns
 * { restore, patched, previous }; restore() is idempotent and returns
 *   'unchanged'  nothing was patched
 *   'restored'   the file is byte-for-byte what it was before the run
 *   'merged'     the file was edited during the run: only the isUAT value
 *                was put back, the other edits are kept
 *   'conflict'   isUAT itself was changed during the run: left untouched
 * Pre-existing (uncommitted) edits are part of the snapshot, so they survive.
 */
function setIsUAT(profile, wantUAT) {
  const envFile = profile.envFile;
  if (!fs.existsSync(envFile)) {
    throw new StepError('Cannot determine the app backend.', {
      code: 'ENV_CONFIG_INVALID',
      details: `APPConfig.js not found at ${envFile}; refusing to build an unknown backend.`,
    });
  }
  const original = fs.readFileSync(envFile, 'utf8');
  const match = original.match(IS_UAT_RE);
  if (!match) {
    throw new StepError('Cannot determine the app backend.', {
      code: 'ENV_CONFIG_INVALID',
      details: `Could not find "const isUAT = true|false" in ${envFile}; refusing to guess the backend.`,
    });
  }
  const previous = match[1] === 'true';
  if (previous === wantUAT) {
    return { restore: () => 'unchanged', patched: false, previous };
  }
  const patchedContent = original.replace(IS_UAT_RE, `const isUAT = ${wantUAT}`);
  writeFileAtomic(envFile, patchedContent);
  let outcome = null;
  return {
    restore: () => {
      if (outcome) return outcome;
      let current;
      try {
        current = fs.readFileSync(envFile, 'utf8');
      } catch (err) {
        outcome = 'conflict';
        return outcome;
      }
      if (current === original) {
        outcome = 'restored';
      } else if (current === patchedContent) {
        writeFileAtomic(envFile, original);
        outcome = 'restored';
      } else {
        const now = current.match(IS_UAT_RE);
        if (now && (now[1] === 'true') === wantUAT) {
          writeFileAtomic(envFile, current.replace(IS_UAT_RE, `const isUAT = ${previous}`));
          outcome = 'merged';
        } else {
          outcome = 'conflict';
        }
      }
      return outcome;
    },
    patched: true,
    previous,
  };
}

/* Async spawn wrapper so Ctrl+C can kill the children and restore state.
 * Sets (not single values) because parallel mode can run two builds at once.
 * Resolves with { code, signal, stdout, stderr }; never throws for exits. */
const activeChildren = new Set();
const activeAborts = new Set();
let cancelRequested = false;
let runActive = false;

/* A child that ignores the cooperative SIGINT is escalated to SIGTERM and
 * then SIGKILL, so a cancelled CI job cannot hang on it. */
const CANCEL_ESCALATION_MS = [10_000, 20_000];

/* Descendants seen while cancelling. A grandchild (xcodebuild's compilers,
 * npx's node, a shell's background job) is re-parented to launchd once its
 * parent exits, so it is remembered here and reaped at exit. */
const cancelledTree = new Set();

/** Descendant pids of `roots` (not the roots), from one `ps` snapshot. */
function descendantPids(roots) {
  if (roots.length === 0) return [];
  const res = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8', timeout: 5000 });
  if (res.error || res.status !== 0) return [];
  const children = new Map();
  for (const line of String(res.stdout).split('\n')) {
    const [pid, ppid] = line.trim().split(/\s+/).map(Number);
    if (!pid || !ppid) continue;
    if (!children.has(ppid)) children.set(ppid, []);
    children.get(ppid).push(pid);
  }
  const out = [];
  const queue = [...roots];
  const seen = new Set(roots);
  while (queue.length > 0) {
    for (const pid of children.get(queue.shift()) || []) {
      if (seen.has(pid) || pid === process.pid) continue;
      seen.add(pid);
      out.push(pid);
      queue.push(pid);
    }
  }
  return out;
}

function killPid(pid, sig) {
  try {
    process.kill(pid, sig);
    return true;
  } catch (err) {
    return false;
  }
}

/** Signal every running child and all of its descendants (like Ctrl+C does
 * for a terminal's foreground process group). */
function signalChildren(sig) {
  const roots = [...activeChildren].map((child) => child.pid).filter(Boolean);
  for (const pid of descendantPids(roots)) cancelledTree.add(pid);
  for (const pid of roots) killPid(pid, sig);
  for (const pid of cancelledTree) killPid(pid, sig);
}

const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

/**
 * Exit hook (cancelled runs only): processes left over from the cancelled
 * children get SIGTERM, up to 1s to exit, then SIGKILL. Pids are only those
 * seen as descendants of this run's own children during the cancel.
 */
function reapCancelledDescendants() {
  if (!cancelRequested) return;
  const roots = [...activeChildren].map((child) => child.pid).filter(Boolean);
  for (const pid of descendantPids(roots)) cancelledTree.add(pid);
  let alive = [...roots, ...cancelledTree].filter((pid) => killPid(pid, 0));
  if (alive.length === 0) return;
  for (const pid of alive) killPid(pid, 'SIGTERM');
  for (let waited = 0; waited < 1000 && alive.length > 0; waited += 50) {
    sleepSync(50);
    alive = alive.filter((pid) => killPid(pid, 0));
  }
  for (const pid of alive) killPid(pid, 'SIGKILL');
}

/** True once Ctrl+C / SIGTERM / SIGHUP asked this run to stop. A child that
 * died from a signal *without* that request (OOM killer, kill -9) is a
 * failure, not a cancellation. */
const isCancelRequested = () => cancelRequested;

/** "exited with code 1" / "was killed by SIGKILL" for error details. */
const exitText = (res) => (res.signal ? `was killed by ${res.signal}` : `exited with code ${res.code}`);

function onCancelRequest() {
  /* A second Ctrl+C / SIGTERM: stop waiting for children to wind down. The
   * 'exit' hooks still restore APPConfig, remove temp files and unlock. */
  const force = cancelRequested;
  cancelRequested = true;
  if (!runActive || force) {
    signalChildren('SIGKILL');
    process.exit(EXIT_CANCELLED);
  }
  signalChildren('SIGINT');
  for (const [i, sig] of [[0, 'SIGTERM'], [1, 'SIGKILL']]) {
    setTimeout(() => signalChildren(sig), CANCEL_ESCALATION_MS[i]).unref();
  }
  for (const ctrl of activeAborts) {
    try {
      ctrl.abort();
    } catch (err) {
      /* already aborted */
    }
  }
}

let signalsInstalled = false;

/** SIGINT/SIGTERM/SIGHUP -> cooperative cancel (see onCancelRequest). Without
 * these handlers Node would die on the signal without running 'exit' hooks. */
function installSignalHandlers() {
  if (signalsInstalled) return;
  signalsInstalled = true;
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => onCancelRequest());
  lifecycle.addCleanup(reapCancelledDescendants);
}

function runCommand(cmd, args, { cwd, streamOutput, onOutput }) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd,
      env: process.env,
      stdio: streamOutput ? 'inherit' : ['ignore', 'pipe', 'pipe'],
    });
    activeChildren.add(child);
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
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      activeChildren.delete(child);
      resolve(result);
    };
    child.on('error', (err) => {
      finish({ code: null, signal: null, stdout, stderr, spawnError: err });
    });
    /* 'close' waits until every holder of the stdout/stderr pipes is gone. A
     * descendant that ignores the cancel (re-parented once its parent dies)
     * can hold them indefinitely, so after a cancel request the child's own
     * exit is enough; the exit hook reaps the leftovers. */
    child.on('exit', (code, signal) => {
      if (!cancelRequested) return;
      if (child.stdout) child.stdout.destroy();
      if (child.stderr) child.stderr.destroy();
      finish({ code, signal, stdout, stderr });
    });
    child.on('close', (code, signal) => {
      finish({ code, signal, stdout, stderr });
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
        code: 'ARTIFACT_INVALID',
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
 * The exact process to spawn for a BetaDrop CLI call: always the pinned
 * BETADROP_CLI_PACKAGE through npx, on a PTY (`script`) for interactive
 * macOS runs (see uploadToBetaDrop).
 */
function betadropCommand(cliArgs, { ci = false, platform = process.platform } = {}) {
  const baseArgs = ['-y', BETADROP_CLI_PACKAGE, ...cliArgs];
  const usePty = !ci && platform === 'darwin';
  return usePty ? { command: 'script', args: ['-q', '/dev/null', 'npx', ...baseArgs] } : { command: 'npx', args: baseArgs };
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
  const { command, args } = betadropCommand(cliArgs, { ci });

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
  if (res.signal && cancelRequested) {
    const err = new StepError('Operation cancelled.');
    err.cancelled = true;
    throw err;
  }
  if (res.code !== 0) {
    const cleaned = ci
      ? (res.stderr || '').trim()
      : cleanCliOutput(res.stderr) || cleanCliOutput(res.stdout);
    const providerError = cleaned || (res.stdout || '').trim() || `betadrop publish ${exitText(res)}`;
    const isAuth = /401|unauthor|forbidden|expired|revoked|token|not logged in|login/i.test(providerError);
    throw new StepError('Upload failed.', {
      code: 'UPLOAD_FAILED',
      details: providerError,
      hint: isAuth
        ? `One-time setup: run \`npx -y ${BETADROP_CLI_PACKAGE} login\`, or export BETADROP_TOKEN=bd_live_xxxx\n(create the token at betadrop.app under Settings -> Developer -> API tokens).`
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
      code: 'UPLOAD_NO_URL',
      details: `BetaDrop returned no install URL.\nRaw output: ${(res.stdout || '').trim().slice(0, 500)}`,
      hint: `The upload itself may have succeeded — check recent builds with \`npx -y ${BETADROP_CLI_PACKAGE} builds list\`.`,
    });
  }
  return { url, timing: tracker ? tracker.stats(Date.now()) : null };
}

/* ------------------------------------------------------------------ */
/* Upload providers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Upload providers. AppShare is the default: it drives the AppShare web
 * app's API with the APPSHARE_EMAIL / APPSHARE_PASSWORD login — see
 * lib/providers/appshare.js. ShareIPA drives the undocumented anonymous
 * ShareIPA website API (lib/providers/shareipa.js). BetaDrop is the official
 * CLI with mirrored live progress.
 *
 * All share the signature
 *   upload(profile, filePath, name, notes, { ci, onProgress, onProcessing, signal, meta, expiresInDays })
 * and return { url, timing?, adminUrl? }. An optional preflight(opts) runs
 * before the build (AppShare signs in there).
 */
const PROVIDERS = {
  appshare: { key: 'appshare', label: 'AppShare', upload: uploadToAppShare, preflight: preflightAppShare },
  shareipa: { key: 'shareipa', label: 'ShareIPA', upload: uploadToShareIPA },
  betadrop: { key: 'betadrop', label: 'BetaDrop', upload: uploadToBetaDrop },
};

/* Single source of truth for the default upload provider. */
const DEFAULT_PROVIDER = 'appshare';

/** Provider options beyond progress/cancel: build metadata (AppShare
 * records version/build/bundle id) and the requested link lifetime. */
const uploadExtras = (version, expiresInDays) => ({
  meta: {
    version: version && version.versionName,
    buildNumber: version && version.versionCode,
    bundleId: version && version.bundleId,
    iconPath: version && version.iconPath,
  },
  ...(expiresInDays === null || expiresInDays === undefined ? {} : { expiresInDays }),
});

/**
 * The share message copied to the clipboard (and printed by --ci):
 *   Alfa-PTE (STAG): [Android Build Link](https://install.shareipa.com/…)
 * The name comes from adapter.shareName (camelCase hyphenated by detect.js).
 */
function buildMarkdown(shareName, label, env, url) {
  return `${shareName} (${env.markdownWord.toUpperCase()}): [${label} Build Link](${url})`;
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

/**
 * Remove adapter-held temp files (e.g. the iOS IPA staging dir) — after the
 * upload, whether it succeeded or failed. Never throws: a cleanup problem is
 * recorded as a warning and must not replace the build/upload error.
 */
function cleanupArtifact(artifact, recorder = null) {
  if (!artifact || !artifact.cleanup) return;
  try {
    artifact.cleanup();
  } catch (err) {
    if (recorder) recorder.warn(`Could not remove the staged ${artifact.file ? artifact.file.name : 'artifact'}: ${err.message}`);
  }
}

/** Stable platform key for results ('android' / 'ios'). */
const platformKey = (adapter) => adapter.key || String(adapter.label || 'unknown').toLowerCase();

/** Exit status for a failed step (a held project lock gets its own code). */
const exitCodeFor = (err) => (err && err.code === 'LOCKED' ? EXIT_LOCKED : EXIT_FAILED);

/**
 * Where the built output stays after a failed upload. A staged temp artifact
 * (the iOS IPA) has already been removed, so point at its source instead.
 */
function markArtifactReady(err, adapter, artifact) {
  if (!err || err.cancelled || !artifact || !artifact.file) return;
  const root = adapter.profile.root;
  if (artifact.sourceKept && artifact.source) {
    err.artifactReadyAt = displayPath(root, artifact.source);
    return;
  }
  if (artifact.cleanup) {
    if (artifact.source) {
      err.artifactReadyMessage = `App built successfully: ${displayPath(root, artifact.source)} — the staged ${adapter.artifactWord} was removed; fix the issue above and re-run to package and upload it again.`;
    }
    return;
  }
  err.artifactReadyAt = displayPath(root, artifact.file.fullPath);
}

/** Record the artifact (checksum only when a result file was requested). */
async function recordArtifact(recorder, adapter, artifact) {
  if (!recorder.enabled) return;
  recorder.setArtifact(platformKey(adapter), {
    name: artifact.file.name,
    sizeBytes: artifact.file.size,
    sha256: await sha256File(artifact.file.fullPath),
    signature: artifact.signature || null,
  });
}

/* ------------------------------------------------------------------ */
/* Presentation (Clack)                                                */
/* ------------------------------------------------------------------ */

function showIntro(adapters) {
  const labels = adapters.length > 1 ? adapters.map((a) => a.label).join(' + ') : adapters[0].label;
  p.intro(`${adapters[0].appName}  ·  ${labels} Build & Distribution`);
}

/** Environment note; `entries` is [{ adapter, version }] (one or two). */
function showEnv(env, entries) {
  const accent = accentFor(env);
  const lines = [accent(bold(`● ${env.presentWord}`))];
  for (const { adapter, version } of entries) {
    lines.push(muted(`${adapter.label} · Backend isUAT=${env.isUAT} · v${version.versionName} (build ${version.versionCode})`));
  }
  p.note(lines.join('\n'), 'Environment');
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
  if (err.artifactReadyMessage) {
    p.log.message(muted(err.artifactReadyMessage));
  } else if (err.artifactReadyAt) {
    p.log.message(muted(`${adapter.artifactWord} built successfully: ${err.artifactReadyAt} — fix the issue above and re-run, or upload it manually.`));
  }
  p.outro('Build did not complete');
  process.exit(exitCodeFor(err));
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

/* ------------------------------------------------------------------ */
/* Interactive phases (shared by single- and multi-platform runs)      */
/* ------------------------------------------------------------------ */

const nameFor = (adapter, env) => `${adapter.appName} ${adapter.label} ${env.presentWord}`;

const notesFor = (adapter, version, env) =>
  `${adapter.appName} ${adapter.label} ${env.presentWord} Build — v${version.versionName} (build ${version.versionCode})`;

const markdownFor = (adapter, env, url) => buildMarkdown(adapter.shareName || adapter.appName, adapter.label, env, url);

/** One interactive build phase; wires the spinner/task-log into ctx. */
async function buildInteractive(adapter, { verbose, ctx, startedAt }) {
  if (verbose) {
    const s = p.spinner();
    ctx.spinner = s;
    s.start(adapter.verboseBuildStart);
    await adapter.build({ verbose: true });
    throwIfCancelled();
    s.stop(`Release ${adapter.artifactWord} built in ${formatElapsed(Date.now() - startedAt)}`);
    ctx.spinner = null;
    return;
  }
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

/** "\n"-free suffix for provider onRetry notices, e.g. " (retry 2/5 in 15s)". */
function retrySuffix(info) {
  if (!info || !info.nextAttempt) return ' (retrying)';
  const total = info.attempts ? `/${info.attempts}` : '';
  const seconds = Math.round((info.delayMs || 0) / 1000);
  return ` (retry ${info.nextAttempt}${total}${seconds > 0 ? ` in ${seconds}s` : ''})`;
}

/** One interactive upload phase with the live progress bar. */
async function uploadInteractive(adapter, artifact, { env, provider, ctx, notes, extras = {} }) {
  const up = p.progress({ style: 'light', size: 22 });
  ctx.spinner = up;
  up.start(`Uploading to ${provider.label}`);
  let idleTimer = null;
  let lastPercent = 0;
  const onUploadProgress = ({ percent, mb, totalMb, speed }) => {
    /* Speed only when the line has room for it (keeps narrow terminals
     * from wrapping the spinner). */
    const withSpeed = speed && (!process.stdout.columns || process.stdout.columns >= 90);
    const message =
      `Uploading to ${provider.label} · ${percent}% · ${mb.toFixed(1)}/${totalMb.toFixed(1)} MB` +
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
    if (provider.key !== 'betadrop') return;
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer =
      percent >= 99
        ? setTimeout(() => {
            idleTimer = null;
            up.advance(0, `Processing on ${provider.label}…`);
          }, 2500)
        : null;
  };

  /* Ctrl+C aborts an in-flight upload; spawned CLIs are killed through the
   * activeChildren set instead. */
  const abort = new AbortController();
  activeAborts.add(abort);
  let result;
  try {
    result = await provider.upload(adapter.profile, artifact.file.fullPath, nameFor(adapter, env), notes, {
      ...extras,
      onProgress: onUploadProgress,
      onProcessing: () => up.advance(0, `Processing on ${provider.label}…`),
      onRetry: (info) => up.advance(0, `Processing on ${provider.label}…${retrySuffix(info)}`),
      signal: abort.signal,
    });
  } catch (err) {
    if (idleTimer) clearTimeout(idleTimer);
    markArtifactReady(err, adapter, artifact);
    throw err;
  } finally {
    activeAborts.delete(abort);
  }
  if (idleTimer) clearTimeout(idleTimer);
  up.stop(uploadStopMessage(result.timing));
  ctx.spinner = null;
  return result;
}

/** Final success rendering: links, share message, clipboard, summary, outro. */
function finishSuccess(results, { env, provider, startedAt }) {
  const multi = results.length > 1;
  const markdown = results.map(({ adapter, url }) => markdownFor(adapter, env, url)).join('\n');
  const copied = copyToClipboard(markdown);
  if (copied) {
    p.log.success('Copied to clipboard');
  } else {
    p.log.warn('Clipboard unavailable — copy the message below manually');
  }
  if (multi) {
    p.note(results.map((r) => `${r.adapter.label}: ${r.url}`).join('\n'), 'Install URLs');
  } else {
    p.note(results[0].url, 'Install URL');
  }
  p.note(markdown, copied ? 'Share message · copied' : 'Share message');
  if (multi) {
    const sizes = results.map((r) => `${r.adapter.label} ${formatMB(r.file.size)}`).join(' + ');
    p.log.message(muted(`${env.presentWord} · ${results.length} builds · ${sizes} · ${provider.label} · ${formatElapsed(Date.now() - startedAt)}`));
    p.outro(`${env.presentWord} builds ready — paste them anywhere with ⌘V`);
  } else {
    const r = results[0];
    p.log.message(muted(`${env.presentWord} · ${r.file.name} · ${formatMB(r.file.size)} · ${provider.label} · ${formatElapsed(Date.now() - startedAt)}`));
    p.outro(`${env.presentWord} build ready — paste it anywhere with ⌘V`);
  }
}

/** Interactive orchestration: one platform at a time (single or sequential). */
async function runSequential(entries, { env, verbose, backend, finishRestore, provider, startedAt, recorder, expiresInDays = null }) {
  const multi = entries.length > 1;
  const ctx = {};
  const results = [];
  let buildsDone = 0;
  let active = entries[0].adapter;
  let phase = 'build';
  const maybeRestore = () => {
    buildsDone++;
    if (buildsDone >= entries.length) {
      finishRestore();
      if (backend.patched) {
        p.log.message(muted(`APPConfig restored (isUAT=${backend.previous})`));
      }
    }
  };
  try {
    for (const [i, { adapter, version }] of entries.entries()) {
      active = adapter;
      const key = platformKey(adapter);
      if (multi) {
        p.log.step(`${adapter.label} (${i + 1}/${entries.length})`);
      }
      phase = 'build';
      const platformStart = Date.now();
      await buildInteractive(adapter, { verbose, ctx, startedAt: multi ? platformStart : startedAt });
      recorder.buildDone(key, Date.now() - platformStart);
      maybeRestore();

      phase = 'artifact';
      const artifact = await adapter.produceArtifact();
      let uploaded;
      try {
        if (artifact.fallback) {
          p.log.warn(`${adapter.expectedName} not present; using the only ${adapter.artifactWord} available: ${artifact.file.name}`);
        }
        await recordArtifact(recorder, adapter, artifact);
        /* A cancel during the checksum must not start an upload. */
        throwIfCancelled();
        phase = 'upload';
        const uploadStart = Date.now();
        uploaded = await uploadInteractive(adapter, artifact, {
          env,
          provider,
          ctx,
          notes: notesFor(adapter, version, env),
          extras: uploadExtras(version, expiresInDays),
        });
        throwIfCancelled();
        recorder.uploadDone(key, { url: uploaded.url, ms: Date.now() - uploadStart });
      } finally {
        cleanupArtifact(artifact, recorder);
      }
      results.push({ adapter, url: uploaded.url, timing: uploaded.timing, file: artifact.file });
    }
    recorder.succeed();
    finishSuccess(results, { env, provider, startedAt });
  } catch (err) {
    finishRestore();
    recorder.fail(err, { phase, platform: platformKey(active) });
    if (err.cancelled || cancelRequested) {
      finishCancelled(ctx);
      return;
    }
    if (err.buildFailed && ctx.buildLog) {
      ctx.buildLog.error(active.buildFailedTitle);
      ctx.buildLog = null;
    }
    renderStepError(err, ctx, active);
  }
}

/**
 * Interactive orchestration: both platforms at once. One compact prefixed
 * view (`[Android] …` / `[iOS] …`); each upload starts as soon as its build
 * finishes, and a failure on one side still surfaces the other's link.
 */
async function runParallel(entries, { env, verbose, backend, finishRestore, provider, startedAt, recorder, expiresInDays = null }) {
  const ctx = {};
  const log = p.taskLog({ title: `Building ${entries.map((e) => e.adapter.label).join(' + ')} in parallel`, limit: 12 });
  ctx.buildLog = log;
  const say = (adapter, message) => log.message(`[${adapter.label}] ${message}`);

  if (verbose) {
    p.log.warn(muted('--verbose is ignored in parallel mode; using the compact view'));
  }

  const abort = new AbortController();
  activeAborts.add(abort);

  const tasks = entries.map(async ({ adapter, version }) => {
    const key = platformKey(adapter);
    let phase = 'build';
    try {
      const platformStart = Date.now();
      say(adapter, 'Building release…');
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
            say(adapter, trimmed);
          }
        },
      });
      throwIfCancelled();
      recorder.buildDone(key, Date.now() - platformStart);
      say(adapter, `✓ built in ${formatElapsed(Date.now() - platformStart)}`);

      phase = 'artifact';
      const artifact = await adapter.produceArtifact();
      let result;
      try {
        if (artifact.fallback) {
          say(adapter, `Using ${artifact.file.name} (expected ${adapter.expectedName})`);
        }
        await recordArtifact(recorder, adapter, artifact);
        throwIfCancelled();
        phase = 'upload';
        say(adapter, `Uploading to ${provider.label}…`);
        let lastPercent = -100;
        let lastAt = 0;
        const uploadStart = Date.now();
        try {
          result = await provider.upload(adapter.profile, artifact.file.fullPath, nameFor(adapter, env), notesFor(adapter, version, env), {
            ...uploadExtras(version, expiresInDays),
            onProgress: ({ percent, mb, totalMb }) => {
              const now = Date.now();
              if (percent < lastPercent + 10 && percent !== 100 && now - lastAt < 3000) return;
              lastPercent = percent;
              lastAt = now;
              say(adapter, `${percent}% · ${mb.toFixed(1)}/${totalMb.toFixed(1)} MB`);
            },
            onProcessing: () => say(adapter, `Processing on ${provider.label}…`),
            onRetry: (info) => say(adapter, `Processing on ${provider.label}…${retrySuffix(info)}`),
            signal: abort.signal,
          });
        } catch (err) {
          markArtifactReady(err, adapter, artifact);
          throw err;
        }
        throwIfCancelled();
        recorder.uploadDone(key, { url: result.url, ms: Date.now() - uploadStart });
      } finally {
        cleanupArtifact(artifact, recorder);
      }
      say(adapter, `✓ ${result.url}`);
      return { adapter, ...result, file: artifact.file };
    } catch (err) {
      err.failedAdapter = adapter;
      recorder.fail(err, { phase, platform: key });
      throw err;
    }
  });

  const settled = await Promise.allSettled(tasks);
  activeAborts.delete(abort);
  finishRestore();
  if (backend.patched) {
    p.log.message(muted(`APPConfig restored (isUAT=${backend.previous})`));
  }

  const results = settled.filter((s) => s.status === 'fulfilled').map((s) => s.value);
  const failures = settled.filter((s) => s.status === 'rejected').map((s) => s.reason);

  if (cancelRequested || failures.some((err) => err && err.cancelled)) {
    recorder.cancel();
    log.error('Operation cancelled');
    ctx.buildLog = null;
    finishCancelled(ctx);
    return;
  }

  if (failures.length > 0) {
    log.error(failures[0].message || 'Failed');
    ctx.buildLog = null;
    for (const r of results) {
      p.log.success(`${r.adapter.label} finished: ${r.url}`);
    }
    renderStepError(failures[0], ctx, failures[0].failedAdapter || entries[0].adapter);
    return;
  }

  log.success(`${entries.map((e) => e.adapter.label).join(' + ')} complete`);
  ctx.buildLog = null;
  recorder.succeed();
  finishSuccess(results, { env, provider, startedAt });
}

/** Print a failure on the plain (--ci) path and exit with its status. */
function failPlainAndExit(err, { usageEntry = null } = {}) {
  if (err.cancelled || cancelRequested) {
    plain.fail('Operation cancelled.');
    process.exit(EXIT_CANCELLED);
  }
  plain.fail(err.message);
  if (err.usage && usageEntry) {
    plain.fail(usageText(usageEntry));
    process.exit(EXIT_USAGE);
  }
  if (err.details) plain.fail(err.details);
  if (err.hint) plain.fail(err.hint);
  process.exit(err.usage ? EXIT_USAGE : exitCodeFor(err));
}

/**
 * Take the per-project lock for the rest of the process. On a stale lock left
 * by a killed run that had APPConfig patched, warn: that run could not
 * restore the file.
 */
function lockProject(profile, { ci, recorder }) {
  const lock = acquireProjectLock(profile.root);
  lifecycle.addCleanup(() => lock.release());
  const stale = lock.staleOwner && lock.staleOwner.appConfig;
  if (stale) {
    const message =
      `A previous ship run (pid ${lock.staleOwner.pid}) ended without restoring ${stale.file}: it had set isUAT=${stale.patchedTo} ` +
      `(it was isUAT=${stale.previous} before that run). Check the file before relying on this build's backend.`;
    recorder.warn(message);
    if (ci) plain.fail(`Warning: ${message}`);
    else p.log.warn(message);
  }
  return lock;
}

async function run(adapterOrAdapters, { envName = null, verbose = false, ci = false, introShown = false, provider = DEFAULT_PROVIDER, recorder = createRecorder(), expiresInDays = null } = {}) {
  const adapters = Array.isArray(adapterOrAdapters) ? adapterOrAdapters : [adapterOrAdapters];
  const multi = adapters.length > 1;
  const primary = adapters[0];
  const startedAt = Date.now();
  const uploadProvider = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];

  /* Ctrl+C / SIGTERM: kill the children, restore APPConfig, remove temp
   * files, unlock, leave the terminal clean. */
  installSignalHandlers();
  runActive = true;
  recorder.setRequest({ platforms: adapters.map(platformKey), provider: uploadProvider.key, ci, expiresInDays });

  if (!ci && !introShown) {
    showIntro(adapters);
  }

  /* ---- Exclusive per-project lock for the whole build/upload lifecycle ---- */
  let lock;
  try {
    lock = lockProject(primary.profile, { ci, recorder });
  } catch (err) {
    recorder.fail(err, { phase: 'lock' });
    if (ci) failPlainAndExit(err);
    renderStepError(err, {}, primary);
    return;
  }

  /* ---- Version info (one read per selected platform) ---- */
  const entries = [];
  let reading = primary;
  try {
    for (const adapter of adapters) {
      reading = adapter;
      const version = await readVersion(adapter, ci);
      recorder.setVersion(platformKey(adapter), version);
      entries.push({ adapter, version });
    }
  } catch (err) {
    recorder.fail(err, { phase: 'version', platform: platformKey(reading) });
    if (ci) failPlainAndExit(err);
    renderStepError(err, {}, primary);
    return;
  }

  /* ---- Environment (one choice applies to every selected platform) ---- */
  let resolvedName;
  try {
    resolvedName = await resolveEnvName(primary.profile, envName, ci, adapters.map((a) => a.label).join(' + '));
  } catch (err) {
    recorder.fail(err, { phase: 'env' });
    if (ci) {
      plain.fail(err.message);
      if (err.details) plain.fail(err.details);
      plain.fail(err.usage ? usageText(primary.entry) : '');
      process.exit(err.usage ? EXIT_USAGE : EXIT_FAILED);
    }
    renderUsageError(err, primary.entry);
    return;
  }
  recorder.setEnvironment(resolvedName);
  const env = ENVS[resolvedName];

  /* ---- Sequential vs Parallel — asked only when BOTH platforms run ---- */
  const mode = await resolveMode(adapters, ci);

  /* ---- Provider sign-in before the build: a bad login fails in seconds ---- */
  if (uploadProvider.preflight) {
    try {
      if (ci) plain.say(`Signing in to ${uploadProvider.label}...`);
      await uploadProvider.preflight({});
      throwIfCancelled();
    } catch (err) {
      recorder.fail(err, { phase: 'preflight' });
      if (ci) failPlainAndExit(err);
      renderStepError(err, {}, primary);
      return;
    }
  }

  /* ---- Prepare backend selection (always restored) ---- */
  let backend;
  try {
    backend = setIsUAT(primary.profile, env.isUAT);
  } catch (err) {
    recorder.fail(err, { phase: 'env' });
    if (ci) failPlainAndExit(err);
    renderStepError(err, {}, primary);
    return;
  }

  const finishRestore = () => {
    let outcome;
    try {
      outcome = backend.restore();
    } catch (err) {
      /* restore is best-effort here; the 'exit' hook retries it */
      return;
    }
    if (backend.patched) {
      try {
        lock.update({ appConfig: null });
      } catch (err) {
        /* the lock file is only advisory state */
      }
    }
    if (outcome === 'merged' || outcome === 'conflict') {
      const message =
        outcome === 'merged'
          ? `${primary.profile.envFile} was edited during the build; only isUAT was put back to ${backend.previous}, the other edits were kept.`
          : `${primary.profile.envFile}: isUAT was changed during the build, so it was left as is (it was isUAT=${backend.previous} before this run).`;
      if (!finishRestore.warned) {
        finishRestore.warned = true;
        recorder.warn(message);
        if (ci) plain.fail(`Warning: ${message}`);
        else p.log.warn(message);
      }
    }
  };
  lifecycle.addCleanup(finishRestore);
  if (backend.patched) {
    /* Lets a later run explain a crash that left the file patched. Registered
     * after the restore hook so a failure here cannot skip the restore. */
    try {
      lock.update({ appConfig: { file: primary.profile.envFile, patchedTo: env.isUAT, previous: backend.previous } });
    } catch (err) {
      recorder.warn(`Could not record the APPConfig state in the lock file: ${err.message}`);
    }
  }

  if (ci) {
    await runPlain(adapters, { env, verbose, entries, backend, finishRestore, startedAt, provider, recorder, expiresInDays });
    return;
  }

  showEnv(env, entries);
  if (backend.patched) {
    p.log.message(muted(`Backend set to isUAT=${env.isUAT} for this ${multi ? 'run' : 'build'} (restoring afterwards)`));
  }

  if (multi && mode === 'parallel') {
    await runParallel(entries, { env, verbose, backend, finishRestore, provider: uploadProvider, startedAt, recorder, expiresInDays });
  } else {
    await runSequential(entries, { env, verbose, backend, finishRestore, provider: uploadProvider, startedAt, recorder, expiresInDays });
  }
}

/* Non-interactive variant: same steps, plain line-oriented output.
 * Accepts one adapter or several — CI always runs them sequentially.
 * Contract: progress lines on stdout, errors on stderr, and on success the
 * share message lines (one per platform, each with the install URL) are the
 * last stdout lines. Never prompts and never touches the clipboard. */
async function runPlain(adapterOrAdapters, { env, verbose, version, versions, entries, notes, backend, finishRestore, startedAt, provider = DEFAULT_PROVIDER, recorder = createRecorder(), expiresInDays = null }) {
  const adapters = Array.isArray(adapterOrAdapters) ? adapterOrAdapters : [adapterOrAdapters];
  const versionList = entries ? entries.map((e) => e.version) : versions || adapters.map(() => version);
  const uploadProvider = PROVIDERS[provider] || PROVIDERS[DEFAULT_PROVIDER];
  const results = [];
  let buildsDone = 0;
  let active = adapters[0];
  let phase = 'build';
  try {
    for (const [i, adapter] of adapters.entries()) {
      active = adapter;
      const key = platformKey(adapter);
      const v = versionList[i] || { versionName: 'unknown', versionCode: 'unknown' };
      phase = 'build';
      plain.say(`${adapter.appName} ${adapter.label} ${env.presentWord} build (v${v.versionName}, build ${v.versionCode})`);
      plain.say(`Building ${adapter.label} release...`);
      const buildStart = Date.now();
      await adapter.build({ verbose });
      throwIfCancelled();
      recorder.buildDone(key, Date.now() - buildStart);
      plain.say(`Build complete in ${formatElapsed(Date.now() - startedAt)}`);
      buildsDone++;
      if (buildsDone >= adapters.length) finishRestore();

      phase = 'artifact';
      const artifact = await adapter.produceArtifact();
      let uploaded;
      try {
        if (artifact.fallback) {
          plain.say(`Note: ${adapter.expectedName} not present; using the only ${adapter.artifactWord} available: ${artifact.file.name}`);
        }
        const kept = artifact.sourceKept && artifact.source;
        const artifactLocation = displayPath(adapter.profile.root, kept ? artifact.source : artifact.file.fullPath);
        const stagingNote = artifact.cleanup && !kept ? ' — staging copy, removed after upload' : '';
        plain.say(`${adapter.artifactWord}: ${artifactLocation} (${formatMB(artifact.file.size)})${stagingNote}`);
        if (artifact.signature) {
          plain.say(`Signature verified (${artifact.signature.schemes.join(', ')})`);
        }
        await recordArtifact(recorder, adapter, artifact);
        throwIfCancelled();

        phase = 'upload';
        plain.say(`Uploading to ${uploadProvider.label}...`);
        const abort = new AbortController();
        activeAborts.add(abort);
        const uploadStart = Date.now();
        try {
          /* Registered for abort first, then checked: a cancel that arrived
           * during the checksum stops here, one that arrives later aborts. */
          throwIfCancelled();
          uploaded = await uploadProvider.upload(adapter.profile, artifact.file.fullPath, nameFor(adapter, env), notes || notesFor(adapter, v, env), {
            ...uploadExtras(v, expiresInDays),
            ci: true,
            onProcessing: () => plain.say(`Processing on ${uploadProvider.label}...`),
            onRetry: (info) => plain.say(`Processing on ${uploadProvider.label}...${retrySuffix(info)}`),
            signal: abort.signal,
          });
        } catch (err) {
          markArtifactReady(err, adapter, artifact);
          throw err;
        } finally {
          activeAborts.delete(abort);
        }
        throwIfCancelled();
        recorder.uploadDone(key, { url: uploaded.url, ms: Date.now() - uploadStart });
      } finally {
        cleanupArtifact(artifact, recorder);
      }
      results.push({ adapter, url: uploaded.url, file: artifact.file });
    }

    recorder.succeed();
    const markdown = results.map(({ adapter, url }) => markdownFor(adapter, env, url)).join('\n');
    plain.say(markdown);
  } catch (err) {
    finishRestore();
    recorder.fail(err, { phase, platform: platformKey(active) });
    if (err.cancelled || cancelRequested) {
      plain.fail('Operation cancelled.');
      process.exit(EXIT_CANCELLED);
    }
    if (err.usage) {
      plain.fail(err.message);
      plain.fail(usageText(active.entry || adapters[0].entry));
      process.exit(EXIT_USAGE);
    }
    plain.fail(err.message);
    if (err.details) plain.fail(err.details);
    if (err.hint) plain.fail(err.hint);
    if (err.artifactReadyMessage) {
      plain.fail(err.artifactReadyMessage);
    } else if (err.artifactReadyAt) {
      plain.fail(`${active.artifactWord} built successfully: ${err.artifactReadyAt} — upload it manually once the issue above is fixed.`);
    }
    process.exit(exitCodeFor(err));
  }
}

module.exports = {
  ENVS,
  BETADROP_LINK_EXPIRY_DAYS,
  BETADROP_CLI_VERSION,
  BETADROP_CLI_PACKAGE,
  EXIT_USAGE,
  EXIT_FAILED,
  EXIT_LOCKED,
  EXIT_RESULT_WRITE,
  EXIT_CANCELLED,
  StepError,
  PROVIDERS,
  DEFAULT_PROVIDER,
  p,
  plain,
  usageText,
  parseArgs,
  peekOutputJson,
  setIsUAT,
  betadropCommand,
  uploadToBetaDrop,
  installSignalHandlers,
  isCancelRequested,
  exitText,
  exitCodeFor,
  resolvePlatforms,
  resolveMode,
  renderUsageError,
  renderStepError,
  retrySuffix,
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
