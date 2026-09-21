'use strict';

const crypto = require('crypto');

// ---- Daily rotating password (env-driven, server-only) ----
//
// Source of truth: process.env.DAILY_PASSWORDS, a JSON string with keys
// "0".."6" where 0 = Sunday ... 6 = Saturday, matching JS Date.getDay().
// The mapping is NEVER sent to the client. For local development, set it in
// a .env file (already covered by .gitignore).
//
// IMPORTANT: there is NO hardcoded password list in this file. The block
// below ONLY provides a *development continuity fallback* that is used when
// DAILY_PASSWORDS is absent from the environment. That fallback is clearly
// labelled and is NOT the production source of truth.
function loadDailyPasswords() {
  const raw = process.env.DAILY_PASSWORDS;
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const out = {};
    for (let i = 0; i <= 6; i++) {
      const v = parsed[String(i)];
      if (typeof v === 'string' && v.length > 0) out[String(i)] = v;
    }
    // Must have all seven days to be considered configured.
    if (Object.keys(out).length === 7) return out;
  } catch (e) {}
  return null;
}

const ENV_DAY_PASSWORDS = loadDailyPasswords();

// The daily password mapping is ALWAYS read from the environment. There is NO
// hardcoded fallback in this file — production deployments MUST set
// DAILY_PASSWORDS (see .env / .gitignore). For local development, copy the
// example below into a .env file (already covered by .gitignore) and rotate
// the values daily.
//
// If DAILY_PASSWORDS is not configured, dayPasswords() returns null and every
// password check fails closed (no one can enter). This is intentional: a
// missing configuration must block entry rather than silently accept a
// built-in default.
function dayPasswords() {
  return ENV_DAY_PASSWORDS;
}

// ---- Israel-day numeric index (0=Sunday ... 6=Saturday, matches getDay) ----
//
// The server process (Render) runs in UTC, so Date.getDay() would return the
// UTC day, not the day in Asia/Jerusalem. Compute the Israel calendar day
// and then its numeric index so the password mapping (keyed by getDay-style
// numbers "0".."6") lines up with the calendar day people actually experience.
//
// Implementation: use Intl.DateTimeFormat with timeZone: Asia/Jerusalem to
// extract the calendar fields (year, month, day, hour, minute, second) in the
// Israel timezone, then rebuild a Date via Date.UTC. The resulting Date's
// getUTCDay() equals the Israel calendar day. This is robust across Node
// versions and locales (unlike parsing a locale string).
function israelDate(date = new Date()) {
  // Use Intl.DateTimeFormat with timeZone: Asia/Jerusalem to extract the
  // calendar fields (year, month, day) in the Israel timezone. We only need
  // the date fields (year, month, day) to determine the Israel calendar day;
  // the time fields are irrelevant for the day-of-week computation.
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jerusalem',
    year: 'numeric', month: '2-digit', day: '2-digit',
  });
  // en-CA produces "YYYY-MM-DD" (e.g. "2026-09-22").
  const raw = fmt.format(date);
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) {
    // Fallback: if the locale format differs, fall back to the input date.
    // This path only fires on unexpected locale formats.
    return new Date(date);
  }
  const [, y, mo, d] = m.map(Number);
  // Date.UTC treats these as UTC fields. The resulting Date's getUTCDay()
  // reflects the Israel calendar day we extracted (since we used the Israel
  // timezone to extract the date fields).
  return new Date(Date.UTC(y, mo - 1, d));
}

function israelDayNumber(date = new Date()) {
  return israelDate(date).getUTCDay();
}

function isPasswordValid(password, date = new Date()) {
  const passwords = dayPasswords();
  if (!passwords) return false; // DAILY_PASSWORDS not configured — fail closed
  const day = String(israelDayNumber(date));
  return typeof password === 'string' && password === passwords[day];
}

// ---- Per-IP brute-force protection for the /api/access endpoint ----
//
// Simple in-memory limiter: 5 failed attempts from the same IP within a
// rolling window, then a 1-minute block. Resets automatically after the
// block window elapses. This is shared with the existing rate-limit helpers
// in server.js but scoped to the access endpoint specifically, because that
// is the only place where a password is checked.
const ipFailMap = new Map(); // ip -> { fails, blockUntil }
const IP_BLOCK_MS = 60 * 1000;   // 1 minute
const IP_MAX_FAILS = 5;

function ipBlocked(ip) {
  if (!ip) return false;
  const entry = ipFailMap.get(ip);
  if (!entry) return false;
  // A block is active when blockUntil has been set (> 0) and the current time
  // is still before it. Once blockUntil has passed, the block is over and we
  // clean up the entry.
  if (entry.blockUntil > 0 && Date.now() < entry.blockUntil) return true;
  if (entry.blockUntil > 0) {
    // Block window expired — clean up.
    ipFailMap.delete(ip);
  }
  return false;
}

function ipRecordFail(ip) {
  if (!ip) return;
  const now = Date.now();
  let entry = ipFailMap.get(ip);
  if (!entry || (entry.blockUntil > 0 && now >= entry.blockUntil)) {
    // No prior entry, or the previous block window has expired: start a fresh
    // failure count. A blockUntil of 0 means "never been blocked" and does
    // NOT reset the counter.
    entry = { fails: 0, blockUntil: 0 };
  }
  entry.fails += 1;
  if (entry.fails >= IP_MAX_FAILS) {
    entry.blockUntil = now + IP_BLOCK_MS;
  }
  ipFailMap.set(ip, entry);
}

function extractClientIp(req) {
  // Trust the standard proxy header first (Render/HTTPS termination), fall
  // back to the direct socket address.
  const forwarded = req.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    return forwarded.split(',')[0].trim() || null;
  }
  const realIp = req.headers['x-real-ip'];
  if (typeof realIp === 'string' && realIp.length > 0) return realIp.trim() || null;
  const sock = req.socket;
  if (sock && sock.remoteAddress) return sock.remoteAddress;
  return null;
}

// ---- Cookie gate (existing, unchanged) ----
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

function israelAccessCookieValue(date = new Date()) {
  return israelDayNumber(date).toString();
}

function hasValidSignedCookieIsrael(header, date = new Date()) {
  const value = parseCookies(header)[COOKIE_NAME] || '';
  const separator = value.lastIndexOf('.');
  if (separator <= 0) return false;
  const day = value.slice(0, separator);
  const signature = value.slice(separator + 1);
  const expectedDay = israelAccessCookieValue(date);
  if (day !== expectedDay || !/^[0-9]{1}$/.test(day) || !/^[A-Za-z0-9_-]{43}$/.test(signature)) return false;
  const actual = Buffer.from(signature);
  const expected = Buffer.from(crypto.createHmac('sha256', COOKIE_SECRET).update(day).digest('base64url'));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function accessCookieHeader(date = new Date()) {
  return COOKIE_NAME + '=' + encodeURIComponent(signedCookieValue(date)) +
    '; Max-Age=' + COOKIE_MAX_AGE_SECONDS + '; Path=/; SameSite=Lax; HttpOnly';
}

module.exports = {
  COOKIE_NAME,
  israelDay,
  israelDate,
  israelDayNumber,
  isPasswordValid,
  dayPasswords,
  parseCookies,
  hasValidAccessCookie,
  hasValidSignedCookie,
  hasValidSignedCookieIsrael,
  israelAccessCookieValue,
  accessCookieHeader,
  extractClientIp,
  ipBlocked,
  ipRecordFail,
  IP_MAX_FAILS,
  IP_BLOCK_MS,
};
