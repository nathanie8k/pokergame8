// JSON-file based persistence for player accounts and admin settings.
// Uses a simple in-memory cache and serializes writes to avoid corruption.

'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Allows the test suite (and any future tooling) to redirect reads + writes
// to a different file via POKER_DATA_FILE=/some/path. Set BEFORE
// `require('./database.js')` so DATA_FILE is computed at module load.
// Defaults to ./data.json as before.
const DATA_FILE = process.env.POKER_DATA_FILE
  ? path.resolve(process.env.POKER_DATA_FILE)
  : path.join(__dirname, '..', 'data.json');

let dataCache = null;
let writeChain = Promise.resolve();

function defaultData() {
  return {
    players: {},            // name -> { id, name, points, created }
    adminPassword: 'admin123',
    settings: { startingStack: 1000 },
  };
}

async function loadData() {
  if (dataCache) return dataCache;
  try {
    const raw = await fs.promises.readFile(DATA_FILE, 'utf8');
    dataCache = JSON.parse(raw);
  } catch (err) {
    if (err.code === 'ENOENT') {
      dataCache = defaultData();
    } else {
      throw err;
    }
  }
  // Backfill any missing keys
  if (!dataCache.players)        dataCache.players = {};
  if (!dataCache.adminPassword)  dataCache.adminPassword = 'admin123';
  if (!dataCache.settings)       dataCache.settings = { startingStack: 1000 };
  // Backfill per-player stat fields on existing data.json entries so the
  // leaderboard's `gamesPlayed > 0` filter and the admin view don't have to
  // defensively `(p.gamesPlayed || 0)` everywhere. Treats legacy records
  // (created before this field existed) as a fresh player: 0 games, 0 wins,
  // lastSeenAt = 0 means "never logged in after stats-tracking shipped".
  for (const k of Object.keys(dataCache.players)) {
    const p = dataCache.players[k];
    if (!p) continue;
    if (typeof p.gamesPlayed !== 'number') p.gamesPlayed = 0;
    if (typeof p.wins        !== 'number') p.wins = 0;
    if (typeof p.lastSeenAt  !== 'number') p.lastSeenAt = 0;
  }
  return dataCache;
}

async function saveData() {
  const snapshot = JSON.stringify(dataCache, null, 2);
  writeChain = writeChain.then(() =>
    fs.promises.writeFile(DATA_FILE, snapshot, 'utf8')
  );
  await writeChain;
}

async function getPlayer(name) {
  if (!name) return null;
  const data = await loadData();
  return data.players[name] || null;
}

async function getOrCreatePlayer(name, opts = {}) {
  const data = await loadData();
  const existing = data.players[name];
  if (existing) return existing;
  const now = Date.now();
  const player = {
    id: opts.id || name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32) + '-' + crypto.randomBytes(2).toString('hex'),
    name,
    points: typeof opts.points === 'number' ? opts.points : (data.settings.startingStack || 1000),
    created: now,
    // Stats start at 0 — `gamesPlayed > 0` is the leaderboard "playing
    // player" filter, so a brand-new account has to actually participate
    // in a hand before they show up on the public board. lastSeenAt is
    // stamped on every register/action hook below, not on creation.
    gamesPlayed: 0,
    wins: 0,
    lastSeenAt: 0,
  };
  data.players[name] = player;
  await saveData();
  return player;
}

// Per-name Promise chain for serializing read-modify-write on the same
// player record. Concurrent calls against DIFFERENT names run in parallel
// (Node's microtask queue interleaves the read-modify-write blocks), but
// two `incrementStats('Alice', ...)` calls in the same tick serialize:
// the second call's read happens ONLY after the first call's saveData
// resolves, so its `Math.max(0, ... + 1)` correctly reads the post-write
// value. Without this, two concurrent winners-in-the-same-hand race on
// gamesPlayed: both read the same `current` value, both add, last save
// wins — losing one increment.
const incrementQueues = new Map();

function nextForName(name) {
  const prev = incrementQueues.get(name) || Promise.resolve();
  // Swallow errors on the chain tail so one failed call doesn't poison
  // every subsequent call's `.then`. The current call still surfaces
  // its own error to its caller (we do `return next`, not `catch`).
  const tail = prev.catch(() => {});
  incrementQueues.set(name, tail);
  return tail;
}

// Atomically bump a player's stat fields and persist. The optional deltas
// are: `gamesDelta` (hands played), `winsDelta` (hands won), `seenAt`
// (timestamp of last activity). Negative deltas are clamped at 0 so a stray
// "-1" can't push an existing field into the negative. No-op for any
// unknown player (returns null) so a legitimate delete-by-name race doesn't
// throw. Caller's responsibility to fire-and-forget — this function awaits
// `saveData()` so all queued writes are serialized on the existing
// writeChain, but the caller should still .catch(err => log) because we
// don't want a transient fs error to bubble into the engine.
async function incrementStats(name, opts = {}) {
  if (!name) return null;
  const prev = nextForName(name);
  // We chain AFTER `prev` resolves so reads see the prior write's
  // mutations. `await prev` is the line that closes the race window.
  await prev;
  const data = await loadData();
  const p = data.players[name];
  if (!p) return null;
  if (typeof opts.gamesDelta === 'number' && opts.gamesDelta !== 0) {
    p.gamesPlayed = Math.max(0, (p.gamesPlayed || 0) + Math.floor(opts.gamesDelta));
  }
  if (typeof opts.winsDelta === 'number' && opts.winsDelta !== 0) {
    p.wins = Math.max(0, (p.wins || 0) + Math.floor(opts.winsDelta));
  }
  if (typeof opts.seenAt === 'number' && opts.seenAt > 0) {
    // Only overwrite if newer — out-of-order calls (e.g. a slow register
    // callback resolving after a faster action) couldn't otherwise roll a
    // fresher lastSeenAt back to an older one.
    if (opts.seenAt > (p.lastSeenAt || 0)) p.lastSeenAt = opts.seenAt;
  }
  await saveData();
  return p;
}

// Returns the public leaderboard rows for /api/leaderboard. Filters out:
//   - missing/null names
//   - entries with `gamesPlayed === 0` (i.e. never played a hand)
//
// The intent is "real players only — no bots / test fixtures / admin-only
// accounts". Anyone who hasn't participated in a hand won't appear. Sort
// order: points DESC, wins DESC as tie-break, gamesPlayed DESC as a further
// tie-break, then name alphabetically. Caps results at `opts.limit` (1..200,
// default 50) to avoid a giant payload if the data file ever grows.
async function getLeaderboardRows(opts = {}) {
  const data = await loadData();
  const limit = Math.max(1, Math.min(200, opts.limit || 50));
  return Object.values(data.players)
    .filter((p) => p && p.name && (p.gamesPlayed || 0) > 0)
    .sort((a, b) =>
      (b.points || 0) - (a.points || 0) ||
      (b.wins || 0) - (a.wins || 0) ||
      (b.gamesPlayed || 0) - (a.gamesPlayed || 0) ||
      a.name.localeCompare(b.name)
    )
    .slice(0, limit)
    .map((p) => ({
      name: p.name,
      points: Math.max(0, Math.floor(p.points || 0)),
      gamesPlayed: Math.floor(p.gamesPlayed || 0),
      wins: Math.floor(p.wins || 0),
      lastSeenAt: p.lastSeenAt || 0,
    }));
}

async function setPoints(name, points) {
  const data = await loadData();
  if (!data.players[name]) return null;
  data.players[name].points = Math.max(0, Math.floor(points));
  data.players[name].updated = Date.now();
  await saveData();
  return data.players[name];
}

async function addPoints(name, delta) {
  const data = await loadData();
  if (!data.players[name]) return null;
  const current = data.players[name].points || 0;
  data.players[name].points = Math.max(0, current + Math.floor(delta));
  data.players[name].updated = Date.now();
  await saveData();
  return data.players[name];
}

async function getAllPlayers() {
  const data = await loadData();
  return Object.values(data.players);
}

async function deletePlayer(name) {
  const data = await loadData();
  if (!data.players[name]) return false;
  delete data.players[name];
  await saveData();
  return true;
}

async function checkAdminPassword(password) {
  const data = await loadData();
  return data.adminPassword === password;
}

async function setAdminPassword(newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 4) {
    throw new Error('Password too short');
  }
  const data = await loadData();
  data.adminPassword = newPassword;
  await saveData();
  return data.adminPassword;
}

async function getStartingStack() {
  const data = await loadData();
  return data.settings.startingStack || 1000;
}

async function setStartingStack(amount) {
  const data = await loadData();
  data.settings.startingStack = Math.max(1, Math.floor(amount));
  await saveData();
  return data.settings.startingStack;
}

module.exports = {
  loadData,
  saveData,
  getPlayer,
  getOrCreatePlayer,
  setPoints,
  addPoints,
  getAllPlayers,
  deletePlayer,
  checkAdminPassword,
  setAdminPassword,
  getStartingStack,
  setStartingStack,
  incrementStats,
  getLeaderboardRows,
};
