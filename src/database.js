// MongoDB-backed persistence for player accounts, admin flags, and per-table
// session settings.
//
// Storage layout:
//   - `players` collection: one doc per player, keyed by unique `name`.
//     Each player may carry an `isAdmin` boolean flag (default false). The
//     user flips this flag in the database/admin panel directly — there is
//     NO in-app assignment logic on purpose (the spec is explicit about
//     manual provisioning), so a brand-new install that has no admin set
//     will simply log "no admin" warnings if any house points/rake accrue.
//   - `metas` singleton: retained for global starting stack only. The
//     historical shared `adminPassword` field is deprecated and stripped
//     from the schema — admin auth is now derived from `Player.isAdmin`.
//   - `tableSettings` collection: one doc per persisted table, keyed by
//     `name` (NOT `tableId`). Persisting by name avoids the ID-reset-on-
//     restart problem: in-memory tableIds reset to "t1", "t2", ... on each
//     server boot, but the table name ("Beginners Table", "VIP") is stable
//     across restarts, so name-keyed settings always apply to the right
//     table when it's recreated on startup.
//
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
  // Admin flag. Indexed because every admin_* socket handler lookup uses
  // it as a query filter. Brand-new players default to false; the user
  // flips it directly in the database admin panel (per spec — no in-app
  // assignment logic). Existing docs that pre-date this field will read
  // as `false` because mongoose applies the default at read time.
  isAdmin:     { type: Boolean, default: false, index: true },
  created:     { type: Number, default: () => Date.now() },
  updated:     { type: Number, default: 0 },
}, { versionKey: false });

const Player = mongoose.model('Player', playerSchema);

// Per-table settings, persisted by table NAME (see file header for why
// name > tableId). Used by the admin panel's "edit session settings" flow;
// in-memory table settings remain authoritative for live state, with this
// collection serving as the persistence layer that survives restarts and
// admin edits. Schema is intentionally permissive (all fields default to
// sensible values) so the admin panel can edit any subset and the rest
// fall back to defaults.
//
// Validation bounds live in the `apply*` helpers below (validateBigBlind
// etc.) rather than in the schema, so the form layer surfaces human
// errors as 400 responses instead of Mongoose validation failures.
const tableSettingsSchema = new mongoose.Schema({
  name:            { type: String, required: true, unique: true, index: true },
  bigBlind:        { type: Number, default: 10 },
  smallBlind:      { type: Number, default: 5 },
  startingStack:   { type: Number, default: 1000 },
  houseFeePercent: { type: Number, default: 0 },
  maxSeats:        { type: Number, default: 6 },
  updatedAt:       { type: Number, default: () => Date.now() },
  updatedBy:       { type: String, default: '' },
}, { versionKey: false });

const TableSettings = mongoose.model('TableSettings', tableSettingsSchema);

// `metas` singleton keeps the global starting stack (default for
// brand-new players) AND the legacy shared admin password (restored
// per user spec). Both fields are co-located on the singleton doc so
// the admin modal can read/write them via two helpers
// (`getAdminPassword`/`setAdminPassword`) without scanning the
// collection. New deployments land on `admin123` by default; the
// in-admin "Change password" form lets the host rotate once logged in.
// Production deployments should set MONGO once and call
// setAdminPassword on first boot.
const metaSchema = new mongoose.Schema({
  _id:           { type: String, default: 'singleton' },
  startingStack: { type: Number, default: 1000 },
  adminPassword: { type: String, default: 'admin123' },
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
  await TableSettings.syncIndexes();
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
  await TableSettings.syncIndexes();
}

// ----- Meta helpers -----

async function getMeta() {
  await connect();
  let meta = await Meta.findById('singleton');
  if (!meta) {
    // Upsert-by-id is race-safe across multiple concurrent first-callers:
    // the unique `_id` index means the second writer hits a duplicate key
    // error which we swallow and re-read. No more `adminPassword` in the
    // seed defaults — that field is dead.
    try {
      meta = await Meta.create({
        _id: 'singleton',
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
  // Note: `adminPassword` is read AS-IS — we no longer strip it. The
  // legacy shared-password admin flow was reinstated per user spec and
  // getAdminPassword() / setAdminPassword() rely on this field existing
  // on the singleton doc. New singleton docs (no explicit insert) get
  // the schema default ('admin123') from the field declaration above.
  return meta;
}

// ----- Public API (preserved from the JSON-file version) -----

// `loadData` / `saveData` were used by the JSON impl and are kept as
// thin compatibility shims so any future caller (admin tooling, scripts)
// doesn't break. They return a snapshot shaped the same way as the legacy
// file: `{ players: {name: ...}, settings }` (adminPassword removed).
async function loadData() {
  await connect();
  const players = await Player.find({}).lean();
  const meta = await getMeta();
  const out = { players: {}, settings: { startingStack: meta.startingStack } };
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
  // isAdmin is opt-in via opts2.isAdmin so tests + setup scripts can
  // create an admin user without poking Mongo directly. Production code
  // paths leave it as false (the default) — the user flips the flag
  // via the database admin panel.
  const isAdmin = opts2.isAdmin === true;
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
      isAdmin,
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

// ----- Legacy shared admin password (restored per spec) -----
//
// The admin modal in `public/index.html` prompts for a single password
// shared across all hosts. The password unlocks the modal contents.
// Default 'admin123' on first boot; the in-modal "Change password"
// form calls `setAdminPassword` to rotate. Reads return the literal
// stored value with a safe fallback in case the singleton doc was
// inserted before the schema carried the field.
async function getAdminPassword() {
  await connect();
  const meta = await getMeta();
  return (typeof meta.adminPassword === 'string' && meta.adminPassword)
    ? meta.adminPassword
    : 'admin123';
}

async function setAdminPassword(newPassword) {
  if (typeof newPassword !== 'string') {
    throw new Error('setAdminPassword: newPassword must be a string');
  }
  if (newPassword.length < 3 || newPassword.length > 200) {
    throw new Error('setAdminPassword: password length must be 3..200 chars');
  }
  await connect();
  const meta = await getMeta();
  meta.adminPassword = newPassword;
  await meta.save();
  return newPassword;
}

// ----- Admin / house-points helpers -----
//
// Per-user isAdmin replaces the prior shared-password system. The admin
// power is derived at register time (server.js attaches the flag to the
// socket) and consulted by every admin_* socket handler. This collection
// of helpers centralizes the query/mutation paths so callers don't have
// to construct Player queries directly.

// List all players with isAdmin=true. Returns lean docs with the minimum
// shape the admin panel needs (`name`, `id`, `isAdmin`, `points`). If no
// admin exists, returns an empty array — callers should treat this as the
// "no house = no fee sink" case and route fees to a logger or skip them
// entirely.
async function getAdminPlayers() {
  await connect();
  return Player.find({ isAdmin: true })
    .sort({ name: 1 })
    .select({ name: 1, id: 1, isAdmin: 1, points: 1 })
    .lean();
}

// Single-row lookup for callers that only need the primary admin (e.g.
// the server's house-points routing in scheduleNextHand). Picks the
// lexicographically-first admin name to make the choice deterministic
// across calls (Mongo doesn't guarantee a stable order on a filtered
// find without a sort + tie-breaker).
async function getPrimaryAdminPlayer() {
  await connect();
  return Player.findOne({ isAdmin: true })
    .sort({ name: 1, created: 1 })
    .select({ name: 1, id: 1, isAdmin: 1, points: 1 })
    .lean();
}

// Manually flip the admin flag for a player. Exposed so a Node.js REPL
// or migration script can do `db.setUserAdmin('Admin', true)` instead of
// poking Mongo directly. Production callers rarely need this — the spec
// is explicit that the user manages the flag themselves.
async function setUserAdmin(name, isAdmin) {
  if (!name || typeof name !== 'string') {
    throw new Error('setUserAdmin: name (string) required');
  }
  if (typeof isAdmin !== 'boolean') {
    throw new Error('setUserAdmin: isAdmin (boolean) required');
  }
  await connect();
  const updated = await Player.findOneAndUpdate(
    { name },
    [{ $set: { isAdmin, updated: Date.now() } }],
    { new: true, updatePipeline: true }
  );
  return updated ? updated.toObject() : null;
}

// Credit "house points" to whichever player has isAdmin=true. Used by
// server.js#scheduleNextHand to route rake / fee receipts to the host,
// and by future "house-leak" code paths (integer-division remainder, if
// it ever arises). Atomic `$add` on the admin's `points` field so two
// concurrent settlements can't lose updates.
//
// Returns:
//   { ok: true,  credited, adminName, adminId, newBalance }
//   { ok: false, reason: 'no_admin' | 'admin_disappeared' | 'invalid_amount',
//     credited: 0 }
//
// Importantly: if no admin exists yet (fresh install before the user flips
// their own flag), the call returns `no_admin` and credits NOTHING rather
// than crashing. This is the spec's "points should automatically be
// credited to whichever user has is_admin" — if there is no such user,
// the points simply don't go anywhere. Callers should log a warning.
async function creditHousePoints(amount) {
  if (typeof amount !== 'number' || !isFinite(amount) || amount <= 0) {
    return { ok: false, reason: 'invalid_amount', credited: 0 };
  }
  await connect();
  const integerAmount = Math.floor(amount);
  if (integerAmount <= 0) {
    return { ok: false, reason: 'invalid_amount', credited: 0 };
  }
  const admin = await getPrimaryAdminPlayer();
  if (!admin) return { ok: false, reason: 'no_admin', credited: 0 };
  const updated = await Player.findOneAndUpdate(
    { _id: admin._id, isAdmin: true },
    [{
      $set: {
        points: { $add: [{ $ifNull: ['$points', 0] }, integerAmount] },
        updated: Date.now(),
      },
    }],
    { new: true, updatePipeline: true }
  );
  if (!updated) return { ok: false, reason: 'admin_disappeared', credited: 0 };
  return {
    ok: true,
    credited: integerAmount,
    adminName: updated.name,
    adminId: updated.id,
    newBalance: updated.points,
  };
}

// ----- Table-settings helpers -----
//
// Persistence layer for the per-table editing flow in the admin panel.
// The in-memory `table` object in RoomManager remains authoritative for
// live state — these helpers are the long-lived backup so an admin edit
// sticks across server restarts.
//
// KEY DESIGN: persisted by `name` (NOT tableId). TableIds reset to "t1",
// "t2", ... on every server boot because RoomManager.idCounter resets;
// persisting by name keeps the persisted settings bound to the
// (stable) display name users see in the lobby. See file header for the
// full discussion of why name > tableId.

// Validate-and-clamp helpers. Bounds chosen for a friendlier "playable"
// poker app: positive integers for chip values, smallBlind <= bigBlind
// (after individual clamps), house fee 0..50% (anything higher than 50%
// is punitive and almost certainly a typo), maxSeats 2..9 (existing
// engine clamp).
function clampInt(value, lo, hi, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}
function clampFloat(value, lo, hi, fallback) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
}

function validateTableSettings(input, fallback) {
  // Default to the supplied fallback (the in-memory table's current
  // settings) so partial edits keep unspecified fields stable.
  const fb = fallback || {};
  const bigBlind   = clampInt(input.bigBlind,    1, 1000000, fb.bigBlind || 10);
  const smallBlind = clampInt(input.smallBlind,  1, 999999,  fb.smallBlind || 5);
  const startingStack = clampInt(input.startingStack, 1, 1000000, fb.startingStack || 1000);
  const houseFeePercent = clampFloat(input.houseFeePercent, 0, 50, fb.houseFeePercent || 0);
  const maxSeats  = clampInt(input.maxSeats, 2, 9, fb.maxSeats || 6);
  // Sanity invariant: smallBlind must be strictly less than bigBlind
  // (equality leaves no raise room). If the user typed them equal, lift
  // smallBlind down to max(1, bigBlind-1) so the table is still
  // playable. Failure-to-satisfy is silent (auto-correction) rather
  // than 400-return — admin panels are friendlier when they "fix
  // obvious typos" instead of rejecting.
  const safeSmallBlind = Math.min(smallBlind, Math.max(1, bigBlind - 1));
  return {
    bigBlind,
    smallBlind: safeSmallBlind,
    startingStack,
    houseFeePercent,
    maxSeats,
  };
}

async function getTableSettings(name) {
  if (!name) return null;
  await connect();
  const doc = await TableSettings.findOne({ name }).lean();
  return doc || null;
}

async function upsertTableSettings(name, settings, updatedBy) {
  if (!name) throw new Error('upsertTableSettings: name required');
  await connect();
  const doc = {
    name,
    bigBlind:        settings.bigBlind,
    smallBlind:      settings.smallBlind,
    startingStack:   settings.startingStack,
    houseFeePercent: settings.houseFeePercent,
    maxSeats:        settings.maxSeats,
    updatedAt:       Date.now(),
    updatedBy:       updatedBy || '',
  };
  await TableSettings.findOneAndUpdate(
    { name },
    { $set: doc },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  return TableSettings.findOne({ name }).lean();
}

async function deleteTableSettings(name) {
  if (!name) return false;
  await connect();
  const r = await TableSettings.deleteOne({ name });
  return r.deletedCount > 0;
}

async function loadAllTableSettings() {
  await connect();
  return TableSettings.find({}).lean();
}

module.exports = {
  // Lifecycle
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
  getStartingStack,
  setStartingStack,
  incrementStats,
  getLeaderboardRows,
  // Admin / house-points
  getAdminPlayers,
  getPrimaryAdminPlayer,
  setUserAdmin,
  creditHousePoints,
  // Legacy shared-password helpers (modal uses these)
  getAdminPassword,
  setAdminPassword,
  // Table-settings persistence
  getTableSettings,
  upsertTableSettings,
  deleteTableSettings,
  loadAllTableSettings,
  // Validation helper (exposed for the server's admin route to reuse)
  validateTableSettings,
};
