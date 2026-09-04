'use strict';

const assert = require('assert');
const gate = require('../src/access_gate');

const sunday = new Date('2026-09-06T10:00:00.000Z');
const monday = new Date('2026-09-07T10:00:00.000Z');

assert.strictEqual(gate.israelDay(sunday), 'Sunday');
assert.strictEqual(gate.israelDay(monday), 'Monday');
assert.strictEqual(gate.isPasswordValid('awad3030', sunday), true);
assert.strictEqual(gate.isPasswordValid('rakif458', sunday), false);
assert.strictEqual(gate.isPasswordValid('rakif458', monday), true);
assert.strictEqual(gate.isPasswordValid('wrong', monday), false);

const cookie = gate.accessCookieHeader(monday).split(';')[0];
assert.strictEqual(gate.hasValidSignedCookie(cookie, monday), true);
assert.strictEqual(gate.hasValidSignedCookie(cookie, sunday), false);
assert.strictEqual(gate.hasValidSignedCookie(cookie.replace(/.$/, 'x'), monday), false);
assert.strictEqual(gate.hasValidSignedCookie('poker_access_day=%E0%A4%A', monday), false);

console.log('access gate tests: passed');
