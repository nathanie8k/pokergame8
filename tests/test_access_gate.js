'use strict';

// The daily password mapping is read from process.env.DAILY_PASSWORDS at
// module load time. The test sets it below BEFORE requiring the module so the
// module picks up the test passwords. These are TEST values only — never used
// in production (production reads from the deployment env).
process.env.DAILY_PASSWORDS = JSON.stringify({
  '0': 'awad3030',   // Sunday
  '1': 'rakif458',   // Monday
  '2': 'nomo3322',   // Tuesday
  '3': 'yakar777',   // Wednesday
  '4': 'gever999',   // Thursday
  '5': 'stomtape5',  // Friday
  '6': 'avram123',   // Saturday
});

const assert = require('assert');
const gate = require('../src/access_gate');

// Israel-day numeric index: 0 = Sunday ... 6 = Saturday, matching JS getDay().
const sunday = new Date('2026-09-06T10:00:00.000Z');
const monday = new Date('2026-09-07T10:00:00.000Z');

assert.strictEqual(gate.israelDay(sunday), 'Sunday');
assert.strictEqual(gate.israelDay(monday), 'Monday');
assert.strictEqual(gate.israelDayNumber(sunday), 0);
assert.strictEqual(gate.israelDayNumber(monday), 1);
assert.strictEqual(gate.isPasswordValid('awad3030', sunday), true);
assert.strictEqual(gate.isPasswordValid('rakif458', sunday), false);
assert.strictEqual(gate.isPasswordValid('rakif458', monday), true);
assert.strictEqual(gate.isPasswordValid('wrong', monday), false);

// Env-driven mapping (keys "0".."6") must also validate the same way.
assert.strictEqual(gate.isPasswordValid('awad3030', sunday), true);
assert.strictEqual(gate.isPasswordValid('rakif458', monday), true);

// Cookie auth against the Israel day (numeric value).
const cookie = gate.accessCookieHeader(monday).split(';')[0];
assert.strictEqual(gate.hasValidSignedCookie(cookie, monday), true);
assert.strictEqual(gate.hasValidSignedCookie(cookie, sunday), false);
assert.strictEqual(gate.hasValidSignedCookie(cookie.replace(/.$/, 'x'), monday), false);
assert.strictEqual(gate.hasValidSignedCookie('poker_access_day=%E0%A4%A', monday), false);

// Israel-day numeric cookie path.
assert.strictEqual(gate.israelDayNumber(monday), 1);
assert.strictEqual(gate.israelAccessCookieValue(monday), '1');
assert.strictEqual(gate.israelAccessCookieValue(sunday), '0');

// Per-IP brute-force helpers.
const ip = '203.0.113.1';
assert.strictEqual(gate.ipBlocked(ip), false);
for (let i = 0; i < 4; i++) gate.ipRecordFail(ip);
assert.strictEqual(gate.ipBlocked(ip), false);
gate.ipRecordFail(ip); // 5th fail -> block
assert.strictEqual(gate.ipBlocked(ip), true);
assert.strictEqual(gate.IP_MAX_FAILS, 5);
assert.strictEqual(typeof gate.IP_BLOCK_MS, 'number');
assert.strictEqual(gate.extractClientIp({ headers: {} }), null);

// extractClientIp: x-forwarded-for wins over direct address.
const req = {
  headers: { 'x-forwarded-for': ' 198.51.100.2, 198.51.100.9 ', 'x-real-ip': '198.51.100.9' },
  socket: { remoteAddress: '192.0.2.99' },
};
assert.strictEqual(gate.extractClientIp(req), '198.51.100.2');

// When DAILY_PASSWORDS is not configured, dayPasswords() returns null and
// every password check fails closed. Verify that an unconfigured environment
// rejects every password.
const prev = process.env.DAILY_PASSWORDS;
delete process.env.DAILY_PASSWORDS;
try {
  // The module was already loaded with the test passwords above, so we
  // cannot re-test the unconfigured path through the same module instance.
  // Instead, spawn a fresh node process to verify the fail-closed behavior.
  const { execSync } = require('child_process');
  const script = 'process.env.DAILY_PASSWORDS = undefined; const g = require(\'../src/access_gate\'); console.log(g.isPasswordValid(\'any\', new Date(\'2026-09-07T10:00:00.000Z\')) ? \'FAIL\' : \'OK\');';
  const result = execSync('node -e ' + JSON.stringify(script), { cwd: __dirname, encoding: 'utf8' }).trim();
  assert.strictEqual(result, 'OK');
} finally {
  if (prev !== undefined) process.env.DAILY_PASSWORDS = prev;
}

console.log('access gate tests: passed');
