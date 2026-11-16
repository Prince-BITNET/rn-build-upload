/**
 * StepError — a user-facing failure raised by the build/upload steps.
 *
 * Lives in its own module so deeply nested helpers (e.g. the upload
 * providers) can throw it without importing lib/build-upload.js, which
 * imports them back (circular).
 *
 * `code` is the stable machine-readable error code reported by
 * --output-json (see README "CI result JSON"). Throw sites set it when they
 * know the precise cause; otherwise the orchestrator derives one from the
 * phase that failed.
 */

class StepError extends Error {
  constructor(title, { details = '', hint = '', usage = false, code = null } = {}) {
    super(title);
    this.name = 'StepError';
    this.details = details;
    this.hint = hint;
    this.usage = usage;
    this.code = code || (usage ? 'USAGE' : null);
  }
}

module.exports = { StepError };
