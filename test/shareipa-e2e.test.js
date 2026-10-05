/**
 * LIVE ShareIPA upload — OPT-IN ONLY, clearly labelled.
 *
 * This is the only test that touches the real ShareIPA service and it never
 * runs by default. It uploads a file to the public anonymous ShareIPA
 * service (which creates a real, 7-day install link — there is no delete
 * API for anonymous uploads, so the link simply expires).
 *
 * Run it explicitly:
 *
 *   SHIP_SHAREIPA_E2E=1 SHIP_SHAREIPA_E2E_FILE=/path/to/app-release.apk \
 *     node --test test/shareipa-e2e.test.js
 *
 * No credentials are involved: ShareIPA issues an anonymous token per run.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const { test } = require('node:test');

const { uploadToShareIPA } = require('../lib/providers/shareipa');

test('live ShareIPA upload (opt-in)', async (t) => {
  if (process.env.SHIP_SHAREIPA_E2E !== '1') {
    t.skip('set SHIP_SHAREIPA_E2E=1 and SHIP_SHAREIPA_E2E_FILE=<path to .apk/.ipa> to run this live test');
    return;
  }
  const file = process.env.SHIP_SHAREIPA_E2E_FILE;
  assert.ok(file && fs.existsSync(file), 'SHIP_SHAREIPA_E2E_FILE must point to an existing .apk or .ipa file');

  const events = [];
  const result = await uploadToShareIPA({ root: process.cwd() }, file, 'E2E', 'ship shareipa e2e', {
    onProgress: (event) => events.push(event),
    onProcessing: () => events.push({ processing: true }),
  });

  assert.match(result.url, /^https:\/\/install\.shareipa\.com\/[A-Za-z0-9_-]+$/);
  if (result.adminUrl) {
    assert.match(result.adminUrl, /^https:\/\/dashboard\.shareipa\.com\/admin\/[A-Za-z0-9_-]+$/);
  }
  assert.ok(events.some((e) => e.percent === 100), 'progress should reach 100%');
  assert.ok(events.some((e) => e.processing), 'the processing phase should be reported');
  assert.ok(result.timing && result.timing.transferMs > 0, 'transfer time should be measured');

  const page = await fetch(result.url, { redirect: 'follow' });
  assert.equal(page.status, 200, 'the install URL should resolve');

  console.log(`LIVE ShareIPA upload OK — install URL: ${result.url}`);
});
