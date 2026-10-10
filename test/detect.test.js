/**
 * detect.js — share-message name hyphenation.
 *
 * The message name is derived from the detected app name, so the same label
 * is produced regardless of which source (iOS plist, Android strings.xml,
 * app.json, package.json) provided the name.
 */

const assert = require('node:assert/strict');
const { test } = require('node:test');

const { hyphenateName } = require('../lib/detect');

test('hyphenateName matches the two production app names', () => {
  /* AlfaPTE (from "Alfa PTE" or the stripped form) */
  assert.equal(hyphenateName('AlfaPTE'), 'Alfa-PTE');
  assert.equal(hyphenateName('Alfa PTE'), 'Alfa-PTE');
  /* PTENow comes from either "PTE Now" (Android) or "PTENow" (iOS plist) */
  assert.equal(hyphenateName('PTENow'), 'PTE-Now');
  assert.equal(hyphenateName('PTE Now'), 'PTE-Now');
});

test('hyphenateName general cases', () => {
  assert.equal(hyphenateName('MyApp'), 'My-App');
  assert.equal(hyphenateName('My App'), 'My-App');
  assert.equal(hyphenateName('App'), 'App');
  assert.equal(hyphenateName('APP'), 'APP');
  assert.equal(hyphenateName('App2Go'), 'App2-Go');
  assert.equal(hyphenateName('Already-Hyphenated'), 'Already-Hyphenated');
  assert.equal(hyphenateName('  spaced  out  '), 'spaced-out');
  assert.equal(hyphenateName(''), '');
  assert.equal(hyphenateName(null), '');
});
