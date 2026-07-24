// MongoDB-backed persistence for player accounts and admin settings.
//
// Storage: a `players` collection (one doc per player, keyed by unique `name`)
// and a single `metas` singleton doc for the admin password + starting stack.
// Per-document atomic operators (`$add`/`$max`/`$cond` inside an aggregation
// pipeline update) replace the previous per-name Promise chain so concurrent
// `incrementStats('Alice', { gamesDelta: 1 })` calls accumulate without lost
// updates — Mongo serializes per-document writes inside the engine.
//
// Public surface is identical to the previous JSON-file implementation
// (`getPlayer`, `getOrCreatePlayer`, `incrementStats`, etc.) so the engine +
// socket-io handlers + admin routes don't need to change their call sites.

'use strict';

const crypto    = require('crypto');
const mongoose  = require('mongoose');

// Connection string. Tests should set MONGO_URI to an in-process Mongo (via
// mongodb-memory-server). Production can also override with MONGO_URI.
const MONGO_URI       = process.env.MONGO_URI || 'mongodb://localhost:27017/friendly-poker';
// Keep engine selection snappy so a misconfigured deployment fails fast
// instead of hanging the first DB call.
const SERVER_SELECTION_TIMEOUT_MS = parseInt(process.env.POKER_MONGO_TIMEOUT_MS || '5000', 10);

let connectPromise = null;

// ----- Models -----
//
// `name` is the natural key — players are addressed by name everywhere in
// the engine, so a unique index on `name` is the constraint that prevents
// two `db.getOrCreatePlayer('Alice')` calls from creating two documents.
//
// `id` is the stable per-account identifier used as `playerId` on seats and
// as the `viewerId` for the table_state publicView. Original generation is
// preserved verbatim from the JSON version (slug + 2 random bytes) so any
// existing-account ids match if you were to import an old data.json.

const playerSchema = new mongoose.Schema({
  name:        { type: String, required: true, unique: true, index: true },
  id:          { type: String, required: true },
  points:      { type: Number, default: 0 },
  // Stats default to 0 — the leaderboard's `gamesPlayed > 0` filter relies
  // on a brand-new account counting as "never played" until it actually
  // participates in a hand. lastSeenAt = 0 means "never logged in after
  // stats-tracking shipped".
  gamesPlayed: { type: Number, default: 0 },
  wins:        { type: Number, default: 0 },
  lastSeenAt:  { type: Number, default: 0 },
  created:     { type: Number, default: () => Date.now() },
  updated:     { type: Number, default: 0 },
}, { versionKey: false });

const Player = mongoose.model('Player', playerSchema);

// Singleton holding the admin password + default starting stack. The fixed
// `_id: 'singleton'` makes it a one-row table by construction; new field
// additions (e.g. a future "table theme" setting) just extend the schema.
const metaSchema = new mongoose.Schema({
  _id:           { type: String, default: 'singleton' },
  adminPassword: { type: String, default: 'admin123' },
  startingStack: { type: Number, default: 1000 },
}, { _id: false, versionKey: false });
const Meta = mongoose.model('Meta', metaSchema);

// ----- Connection -----

async function connect(uri) {
  // Allow tests to point the module at a fresh in-memory mongo by passing
  // a URI on reconnect (e.g. mongodb-memory-server's ephemeral URI).
  if (uri && mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
    connectPromise = null;
  }
  if (mongoose.connection.readyState === 1) return;
  if (connectPromise) return connectPromise;
  const targetUri = uri || MONGO_URI;
  connectPromise = mongoose.connect(targetUri, {
    serverSelectionTimeoutMS: SERVER_SELECTION_TIMEOUT_MS,
  });
  try {
    await connectPromise;
  } finally {
    // Whether or not connect() resolved, clear the cached promise so a
    // retry can establish a new one instead of returning the rejected one.
    connectPromise = null;
  }
  // Make sure indexes exist before any caller races for a unique insert.
  await Player.syncIndexes();
  await Meta.syncIndexes();
}

async function disconnect() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.disconnect();
  connectPromise = null;
}

// Test-only: wipe the database. Production code paths should never call
// this; it's exposed so the test suite can reset state without re-requiring
// the module (the previous JSON impl relied on file overwrites + cache
// deletion; with mongo we just drop + recreate).
async function resetForTests() {
  if (mongoose.connection.readyState !== 1) return;
  await mongoose.connection.dropDatabase();
  await Player.syncIndexes();
  await Meta.syncIndexes();
}

// ----- Meta helpers -----

async function getMeta() {
  await connect();
  let meta = await Meta.findById('singleton');
  if (!meta) {
    // Upsert-by-id is race-safe across multiple concurrent first-callers:
    // the unique `_id` index means the second writer hits a duplicate key
    // error which we swallow and re-read.
    try {
      meta = await Meta.create({
        _id: 'singleton',
        adminPassword: 'admin123',
        startingStack: 1000,
      });
    } catch (err) {
      if (err && err.code === 11000) {
        meta = await Meta.findById('singleton');
      } else {
        throw err;
      }
    }
  }
  return meta;
}

// ----- Public API (preserved from the JSON-file version) -----

// `loadData` / `saveData` were used by the JSON impl and are kept as
// thin compatibility shims so any future caller (admin tooling, scripts)
// doesn't break. They return a snapshot shaped the same way as the legacy
// file: `{ players: {name: ...}, adminPassword, settings }`.
async function loadData() {
  await connect();
  const players = await Player.find({}).lean();
  const meta = await getMeta();
  const out = { players: {}, adminPassword: meta.adminPassword, settings: { startingStack: meta.startingStack } };
  for (const p of players) out.players[p.name] = p;
  return out;
}

async function saveData() {
  // No-op: Mongo writes are immediate. Kept so legacy `await db.saveData()`
  // callers (if any are added) don't crash; a snapshot dump would require
  // re-deriving the previous JSON shape and isn't needed right now.
}

async function getPlayer(name) {
  if (!name) return null;
  await connect();
  const p = await Player.findOne({ name }).lean();
  return p || null;
}

async function getOrCreatePlayer(name, opts) {
  if (!name) return null;
  await connect();
  const meta = await getMeta();
  const opts2 = opts || {};
  const existing = await Player.findOne({ name }).lean();
  if (existing) return existing;
  const id = opts2.id || (
    name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 32)
    + '-' + crypto.randomBytes(2).toString('hex')
  );
  const now = Date.now();
  const startingPoints = typeof opts2.points === 'number'
    ? opts2.points
    : (meta.startingStack || 1000);
  // Race-safe first-time create: two concurrent `getOrCreatePlayer('Alice')`
  // calls could both miss the `findOne` and both attempt `create`. The
  // unique-name index makes the second call throw E11000; we catch and
  // re-read so the second caller gets the first caller's doc instead of a
  // duplicate-insert error.
  try {
    const created = await Player.create({
      name,
      id,
      points: startingPoints,
      gamesPlayed: 0,
      wins: 0,
      lastSeenAt: 0,
      created: now,
    });
    return created.toObject();
  } catch (err) {
    if (err && err.code === 11000) {
      const winner = await Player.findOne({ name }).lean();
      if (winner) return winner;
    }
    throw err;
  }
}

// Atomic race-safe stat bump. Uses an aggregation pipeline update
// (MongoDB 4.2+) so a single `findOneAndUpdate` call performs the
// `+delta` AND the `max(0, …)` clamp in one server-side operation — no
// read-modify-write, no per-name Promise chain required. Concurrent
// calls on the SAME player still serialize cleanly because Mongo
// serializes per-document writes; concurrent calls on DIFFERENT players
// run in parallel.
//
// `seenAt` uses `$cond` so a slower write with an older timestamp
// cannot regress a fresher `lastSeenAt` (the "older does not regress"
// invariant the JSON version enforced in app code).
async function incrementStats(name, opts) {
  if (!name) return null;
  await connect();
  const opts2 = opts || {};
  const setOps = {};
  if (typeof opts2.gamesDelta === 'number' && opts2.gamesDelta !== 0) {
    const delta = Math.floor(opts2.gamesDelta);
    setOps.gamesPlayed = { $max: [0, { $add: ['$gamesPlayed', delta] }] };
  }
  if (typeof opts2.winsDelta === 'number' && opts2.winsDelta !== 0) {
    const delta = Math.floor(opts2.winsDelta);
    setOps.wins = { $max: [0, { $add: ['$wins', delta] }] };
  }
  if (typeof opts2.seenAt === 'number' && opts2.seenAt > 0) {
    setOps.lastSeenAt = {
      $cond: [{ $gt: [opts2.seenAt, '$lastSeenAt'] }, opts2.seenAt, '$lastSeenAt'],
    };
  }
  if (Object.keys(setOps).length === 0) {
    // Nothing to update — return current state (matches JSON impl's
    // no-op-but-still-persist behavior).
    return Player.findOne({ name }).lean();
  }
  const updated = await Player.findOneAndUpdate(
    { name },
    [{ $set: setOps }],
    { new: true, updatePipeline: true }
  );
  return updated ? updated.toObject() : null;
}

// Public leaderboard rows for /api/leaderboard. Filters out entries with
// no name OR `gamesPlayed === 0` (i.e. never played a hand). Sort order
// matches the prior JSON version: points DESC, wins DESC, gamesPlayed
// DESC, name ASC. Caps results at `opts.limit` (1..200, default 50).
async function getLeaderboardRows(opts) {
  await connect();
  const opts2 = opts || {};
  const limit = Math.max(1, Math.min(200, opts2.limit || 50));
  const players = await Player.find({
    name: { $exists: true, $ne: null, $ne: '' },
    gamesPlayed: { $gt: 0 },
  })
    .sort({ points: -1, wins: -1, gamesPlayed: -1, name: 1 })
    .limit(limit)
    .lean();
  return players.map((p) => ({
    name: p.name,
    points: Math.max(0, Math.floor(p.points || 0)),
    gamesPlayed: Math.floor(p.gamesPlayed || 0),
    wins: Math.floor(p.wins || 0),
    lastSeenAt: p.lastSeenAt || 0,
  }));
}

async function setPoints(name, points) {
  await connect();
  const clean = Math.max(0, Math.floor(points));
  const updated = await Player.findOneAndUpdate(
    { name },
    [{ $set: { points: clean, updated: Date.now() } }],
    { new: true, updatePipeline: true }
  );
  return updated ? updated.toObject() : null;
}

async function addPoints(name, delta) {
  await connect();
  const cleanDelta = Math.floor(delta);
  const updated = await Player.findOneAndUpdate(
    { name },
    [{ $set: { points: { $max: [0, { $add: ['$points', cleanDelta] }] }, updated: Date.now() } }],
    { new: true, updatePipeline: true }
  );
  return updated ? updated.toObject() : null;
}

async function getAllPlayers() {
  await connect();
  return Player.find({}).lean();
}

async function deletePlayer(name) {
  await connect();
  const res = await Player.deleteOne({ name });
  return res.deletedCount > 0;
}

async function checkAdminPassword(password) {
  await connect();
  const meta = await getMeta();
  return meta.adminPassword === password;
}

async function setAdminPassword(newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 4) {
    throw new Error('Password too short');
  }
  await connect();
  const meta = await getMeta();
  meta.adminPassword = newPassword;
  await meta.save();
  return meta.adminPassword;
}

async function getStartingStack() {
  await connect();
  const meta = await getMeta();
  return meta.startingStack || 1000;
}

async function setStartingStack(amount) {
  await connect();
  const clean = Math.max(1, Math.floor(amount));
  const meta = await getMeta();
  meta.startingStack = clean;
  await meta.save();
  return clean;
}

module.exports = {
  // Lifecycle (new)
  connect,
  disconnect,
  resetForTests,
  // Compatibility shims (kept as no-ops or shape-preserving)
  loadData,
  saveData,
  // Pre-existing public API
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
