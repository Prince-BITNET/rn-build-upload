/**
 * StepError — a user-facing failure raised by the build/upload steps.
 *
 * Lives in its own module so deeply nested helpers (e.g. the upload
 * providers) can throw it without importing lib/build-upload.js, which
 * imports them back (circular).
 */

class StepError extends Error {
  constructor(title, { details = '', hint = '', usage = false } = {}) {
    super(title);
    this.name = 'StepError';
    this.details = details;
    this.hint = hint;
    this.usage = usage;
  }
}

module.exports = { StepError };
