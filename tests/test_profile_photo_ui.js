'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'client.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
const database = fs.readFileSync(path.join(__dirname, '..', 'src', 'database.js'), 'utf8');

assert.ok(!client.includes('PROFILE_PHOTO_MAX_SOURCE_BYTES'), 'client has no source-size limit constant');
assert.ok(!client.includes('PROFILE_PHOTO_TYPES'), 'client has no MIME type allowlist');
assert.ok(!client.includes('Choose a JPG, PNG, GIF, or WebP image.'), 'client has no legacy format rejection');
assert.ok(!client.includes('File too large, please choose a smaller file.'), 'client has no legacy size rejection');
assert.ok(!index.includes('accept="image/'), 'file picker has no image MIME filter');
assert.ok(!index.includes('up to 10 MB'), 'Account Settings copy has no size limit');
assert.ok(!database.includes("error: 'Invalid photo'"), 'stale Invalid photo error is removed');

assert.match(client, /profilePhotoStatus: 'idle'/, 'profile photo status has a single explicit initial state');
assert.match(client, /setProfilePhotoStatus\('processing'\)/, 'processing state disables Save while work is in flight');
assert.match(client, /setProfilePhotoStatus\('ready'\)/, 'successful processing enters the ready state');
assert.match(client, /saveButton\.disabled = status !== 'ready'/, 'Save is enabled only for a successful preview');
assert.match(client, /setProfilePhotoStatus\('error', err && err\.message/, 'technical failures use the underlying error message');
assert.match(client, /console\.error\('Profile photo processing failed:'/,
  'technical failures are logged for debugging');

console.log('profile photo UI tests: passed');
