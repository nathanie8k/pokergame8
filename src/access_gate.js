'use strict';

const crypto = require('crypto');

// Keep this schedule in one server-only file so updating a day never requires
// changing the browser bundle. Values are intentionally never sent to clients.
const DAILY_PASSWORDS = Object.freeze({
  Sunday: 'awad3030',
  Monday: 'rakif458',
  Tuesday: 'nomo3322',
  Wednesday: 'yakar777',
  Thursday: 'gever999',
  Friday: 'stomtape5',
  Saturday: 'avram123',
});

const COOKIE_NAME = 'poker_access_day';
const COOKIE_MAX_AGE_SECONDS = 36 * 60 * 60;
// A deployment should provide a stable secret so valid access cookies survive
// restarts. The process-local fallback fails closed after a restart rather
// than allowing a forged unsigned day value.
const COOKIE_SECRET = process.env.POKER_ACCESS_COOKIE_SECRET || crypto.randomBytes(32).toString('hex');

function israelDay(date = new Date()) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Jerusalem', weekday: 'long',
  }).format(date);
}

function isPasswordValid(password, date = new Date()) {
  const day = israelDay(date);
  return typeof password === 'string' && password === DAILY_PASSWORDS[day];
}

function accessCookieValue(date = new Date()) {
  return israelDay(date);
}

function parseCookies(header) {
  const result = {};
  for (const part of String(header || '').split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const key = part.slice(0, idx).trim();
    try {
      result[key] = decodeURIComponent(part.slice(idx + 1).trim());
    } catch (err) {
      // Ignore malformed cookie values instead of allowing a bad header
      // to turn into a 500 response.
    }
  }
  return result;
}

function hasValidAccessCookie(header, date = new Date()) {
  return parseCookies(header)[COOKIE_NAME] === accessCookieValue(date);
}

function signedCookieValue(date = new Date()) {
  const day = accessCookieValue(date);
  const signature = crypto.createHmac('sha256', COOKIE_SECRET).update(day).digest('base64url');
  return day + '.' + signature;
}

function hasValidSignedCookie(header, date = new Date()) {
  const value = parseCookies(header)[COOKIE_NAME] || '';
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return false;
  const day = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expectedDay = accessCookieValue(date);
  if (day !== expectedDay || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(crypto.createHmac('sha256', COOKIE_SECRET).update(day).digest('base64url'));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function accessCookieHeader(date = new Date()) {
  return COOKIE_NAME + '=' + encodeURIComponent(signedCookieValue(date)) +
    '; Max-Age=' + COOKIE_MAX_AGE_SECONDS + '; Path=/; SameSite=Lax; HttpOnly';
}

module.exports = {
  DAILY_PASSWORDS,
  COOKIE_NAME,
  israelDay,
  isPasswordValid,
  parseCookies,
  hasValidAccessCookie,
  hasValidSignedCookie,
  accessCookieHeader,
};
