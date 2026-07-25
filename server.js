// Friendly Texas Hold'em Poker - server entry point.
//
// Uses Express for HTTP/Socket.IO for real-time. Game state lives in
// `poker.js` (engine) and `rooms.js` (in-memory table manager); player accounts
// are stored in `database.js` (JSON file persistence).

'use strict';

const express  = require('express');
const http     = require('http');
const path     = require('path');
const { Server } = require('socket.io');

const poker  = require('./src/poker');
const db     = require('./src/database');
const { RoomManager, loadPersistedSettingsIntoCache, getCachedSettingsFor } = require('./src/rooms');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new RoomManager();

// ----- Boot-time persistence priming -----
//
// Connect to Mongo and load any persisted table settings BEFORE the
// default tables are created, so ensureDefaultTables() sees the
// settings cache populated. Without this priming, an admin who set
// "Beginners Table" to 25/50 would lose their changes on every restart
// because createTable defaults to 5/10 from DEFAULT_TABLES.
//
// All three steps are awaited sequentially: connect() must succeed
// before loadAllTableSettings() can read; the cache prime must
// complete before ensureDefaultTables() consults it.
//
// If the DB connection fails or returns no rows, we proceed with an
// empty cache — the defaults still apply so the lobby isn't empty.
// Persistence isn't a hard prerequisite for boot.
async function primePersistedSettings() {
  try {
    await db.connect();
    const rows = await db.loadAllTableSettings();
    const loaded = loadPersistedSettingsIntoCache(rows);
    console.log('Loaded ' + loaded + ' persisted table setting(s) from MongoDB.');
  } catch (err) {
    console.error('Persistence prime failed (continuing with in-memory defaults):', err.message);
  }
}

// Fire-and-log; the server.listen() call below is intentionally not
// chained to primePersistedSettings() so the HTTP listener can accept
// connections immediately (lobby pages load fine while the unprimed
// defaults are in place). ensureDefaultTables() runs synchronously and
// uses what's in the cache at THIS moment — which is an empty Map at
// boot. To apply persisted overrides on restart, after the prime
// resolves we look at `rooms.getCachedSettingsFor(t.name)` and route
// any cached override through `rooms.updateTableSettings`. Reading
// from the cache (NOT from `t.smallBlind` etc.) is the bit that
// actually loads the persisted values — those fields on `t` are still
// the in-memory defaults (`ensureDefaultTables` ran with an empty
// cache), so reading from `t` would just re-write the defaults back
// into the table and to the cache. (Initial draft read from `t` and
// was a silent no-op; the BLOCKING boot-reapply bug from the
// code-review pass.) Skip rows that have no cache entry — those
// tables genuinely are configured at their defaults.
primePersistedSettings().then(() => {
  let applied = 0;
  for (const t of rooms.tables.values()) {
    if (!t.default) continue;
    const cached = getCachedSettingsFor(t.name);
    if (!cached) continue;
    const result = rooms.updateTableSettings(t.id, {
      smallBlind:     cached.smallBlind,
      bigBlind:       cached.bigBlind,
      startingStack:  cached.startingStack,
      houseFeePercent: cached.houseFeePercent,
      maxSeats:       cached.maxSeats,
    }, '(boot)');
    if (result.ok) applied += 1;
  }
  if (applied > 0) console.log('Applied ' + applied + ' persisted table setting(s) on boot.');
  broadcastLobby();
}).catch((err) => console.error('Post-prime settings application failed:', err));

// Create the 5 permanent default tables immediately so the lobby is never
// empty — even on a fresh server start with zero connected players.
// (Runs synchronously with an empty settingsCache; the post-prime
// block above re-applies any overrides once Mongo responds.)
rooms.ensureDefaultTables();

// Session tracking. `socketToAdmin` is gone: admin powers are now
// derived from `socket.data.player.isAdmin` (lookup performed at
// register time) instead of a separate, password-gated set. Every
// admin_* handler below reads `socket.data.isAdmin` from the same
// property the server stamped on the socket during `register`, so a
// re-socket (reconnect) picks up the latest flag without a separate
// admin_login round trip.
const playerSockets   = new Map(); // playerName -> Set<socketId>
const socketToPlayer  = new Map(); // socketId -> playerName
const lobbyBroadcastInterval = setInterval(broadcastLobby, 1500);

// AFK kick — every 5s scan every table for seats whose currentActor
// `_actionClockAt` (set in src/poker.js on every applyAction + postBlind
// + currentPlayer rotation) is older than 90 seconds. The RoomManager's
// kickAfkPlayers runs engine.applyAction('fold') and then flags the seat
// removed+disconnected; we then broadcast + broadcastChat (the kick
// message is a system chat entry) + scheduleNextHand if the fold ended
// the hand.
const AFK_KICK_INTERVAL_MS = 5000;
const AFK_KICK_THRESHOLD_MS = 90 * 1000;
// Reentrancy guard: setInterval does not await async bodies, so if
// scheduleNextHand's `await saveStacksToDB` chain ever exceeds 5s under
// disk pressure, two ticks could overlap. The flag skips a tick while
// the previous one is still resolving — negligible skipped ticks for a
// safer serial flow. (lobbyBroadcastInterval has no async work inside
// so it doesn't need this guard.)
let isAfkKicking = false;
setInterval(async () => {
  if (isAfkKicking) return;
  isAfkKicking = true;
  try {
    let kicked, ended;
    try {
      ({ kicked, ended } = rooms.kickAfkPlayers(AFK_KICK_THRESHOLD_MS));
    } catch (err) {
      console.error('kickAfkPlayers error:', err);
      return;
    }
    for (const tid of kicked) {
      broadcastChat(tid);
      broadcastTable(tid);
    }
    for (const tid of ended) {
      try { await scheduleNextHand(tid); }
      catch (err) { console.error('scheduleNextHand after AFK-kick error:', err); }
    }
  } finally {
    isAfkKicking = false;
  }
}, AFK_KICK_INTERVAL_MS);

// ----- Random name generator -----
const ADJ = [
  'Lucky','Brave','Wild','Clever','Happy','Jolly','Sneaky','Bold','Daring',
  'Wise','Cool','Funky','Spicy','Zesty','Smooth','Slick','Flashy','Dapper',
  'Fierce','Gentle','Mighty','Noble','Royal','Shiny','Swift','Tasty','Witty',
  'Cheeky','Cosmic','Crystal','Electric','Frozen','Golden','Hyper','Icy',
  'Jazzy','Lunar','Mystic','Nimble','Pixel','Quantum','Rusty','Silver',
];
const NOUNS = [
  'Tiger','Eagle','Shark','Wolf','Dragon','Phoenix','Lion','Panther',
  'Falcon','Bear','Otter','Fox','Hawk','Cobra','Viper','Jaguar','Lynx',
  'Raven','Stallion','Marlin','Sailfish','Kraken','Hydra','Griffin',
  'Unicorn','Rhino','Bison','Ram','Bull','Moose','Salamander','Turtle',
  'Bee','Crow','Dolphin','Heron','Iguana','Lemur','Newt','Penguin','Robin',
  'Sparrow','Tamarin','Wombat','Yak','Zebra',
];

function generateNames(n) {
  const out = [];
  const seen = new Set();
  let tries = 0;
  while (out.length < n && tries < n * 20) {
    tries++;
    const name = ADJ[Math.floor(Math.random() * ADJ.length)]
               + NOUNS[Math.floor(Math.random() * NOUNS.length)]
               + String(Math.floor(Math.random() * 90 + 10));
    if (!seen.has(name)) { seen.add(name); out.push(name); }
  }
  return out;
}

// ----- Lobby / table state broadcasting -----

function broadcastLobby() {
  io.emit('lobby_update', { tables: rooms.listTables() });
}

function broadcastTable(tableId) {
  const socketsInTable = io.sockets.adapter.rooms.get('table_' + tableId);
  if (!socketsInTable) return;
  for (const sid of socketsInTable) {
    const socket = io.sockets.sockets.get(sid);
    if (!socket) continue;
    // publicView expects a stable viewer identifier that matches each seat's
    // `playerId` (the database id set when the player was seated). Passing the
    // NAME here made isSelf always evaluate false, which broke the viewer's
    // own hole-card reveal AND the action-bar gating. Use the player id.
    const viewerId = socket.data.player && socket.data.player.id;
    if (!viewerId) continue;
    socket.emit('table_state', { table: rooms.publicView(tableId, viewerId) });
  }
  broadcastLobby();
}

function broadcastAllTables() {
  for (const t of rooms.tables.values()) broadcastTable(t.id);
}

// Chat broadcast: send the table's full chat history to every socket in the
// table_X room. Cheaper than a full broadcastTable() because it skips seats,
// pot, action bar state, etc. — only the chat panel re-renders. The whole
// history is sent (not just deltas) so reconnecting players get the backlog
// without any special-casing.
function broadcastChat(tableId) {
  const socketsInTable = io.sockets.adapter.rooms.get('table_' + tableId);
  if (!socketsInTable) return;
  const messages = rooms.chatHistory(tableId);
  for (const sid of socketsInTable) {
    const socket = io.sockets.sockets.get(sid);
    if (!socket) continue;
    socket.emit('chat_update', { tableId, messages });
  }
}

// ----- Persistence helpers -----

async function saveStacksToDB(table) {
  for (const seat of table.seats) {
    if (!seat) continue;
    try { await db.setPoints(seat.name, seat.stack); }
    catch (err) { console.error('save stack error:', err); }
    // If a socket for this player is connected somewhere, update its view too.
    const set = playerSockets.get(seat.name);
    if (set) {
      for (const sid of set) {
        const s = io.sockets.sockets.get(sid);
        if (!s) continue;
        s.data.player = s.data.player ? { ...s.data.player, points: seat.stack } : s.data.player;
        s.emit('hello', { player: s.data.player });
      }
    }
  }
}

async function applyAdminPointsChangeToSeats(name, newPoints) {
  let touched = false;
  for (const t of rooms.tables.values()) {
    for (let i = 0; i < t.seats.length; i++) {
      if (t.seats[i] && t.seats[i].name === name) {
        t.seats[i].stack = newPoints;
        if (newPoints > 0) {
          t.seats[i].removed = false;
          t.seats[i].disconnected = false;
        }
        touched = true;
      }
    }
  }
  if (touched) broadcastAllTables();
}

// ----- Hand lifecycle -----

function tryStartHand(tableId) {
  const t = rooms.get(tableId);
  if (!t) return;
  if (t.phase !== poker.PHASE.WAITING) return;
  if (poker.countPlayablePlayers(t) < 2) return;
  // Cancel existing timer if any.
  if (rooms.nextHandTimers.has(tableId)) {
    clearTimeout(rooms.nextHandTimers.get(tableId));
    rooms.nextHandTimers.delete(tableId);
  }
  const timer = setTimeout(() => {
    rooms.nextHandTimers.delete(tableId);
    const table = rooms.get(tableId);
    if (!table) return;
    if (table.phase !== poker.PHASE.WAITING) return;
    if (poker.countPlayablePlayers(table) < 2) return;
    poker.startHand(table);
    // Persist stacks immediately after startHand so a server crash mid-hand
    // doesn't lose the SB/BB posts. startHand deducts from SB + BB via
    // postBlind, and those stack changes were not previously saved back to
    // data.json until the hand's HAND_OVER phase. Without this hook, a
    // crash right before any player's first action would silently revert
    // SB/BB seats back to their pre-hand balance on the next server start.
    saveStacksToDB(table).catch((err) => console.error('save stacks on startHand:', err));
    // Bump gamesPlayed for every seated, chip-bearing, non-sitting-out
    // player. Mirrors the same gate `poker.startHand` uses for dealing
    // cards + posting blinds, so the count reflects hands they actually
    // participated in (sat-out players are correctly skipped). Doing this
    // AFTER startHand succeeded guarantees we only count hands that
    // actually launched — startHand returns false (and sets phase to
    // WAITING) when fewer than two players can play. Fire-and-forget to
    // avoid blocking the broadcast cycle on a disk write.
    for (const s of table.seats) {
      if (s && !s.removed && s.stack > 0 && !s.satOut) {
        db.incrementStats(s.name, { gamesDelta: 1 })
          .catch((err) => console.error('gamesPlayed increment error:', err));
      }
    }
    broadcastTable(tableId);
  }, 3000);
  rooms.nextHandTimers.set(tableId, timer);
  // Tell the table a countdown is happening
  broadcastTable(tableId);
}

// Records wins for any HAND_OVER hand that produced a real winner set.
// MUST be called BEFORE poker.endHand(t), because endHand wipes
// `table.lastHandResults` down to null. Busted-refund hands set
// lastHandResults=null inside checkBustedRefund, so those hands
// deliberately don't get counted (the meta-game rule is: "XXX got out,
// refunded" -- no formal winner). Fire-and-forget — each increment is a
// standalone fs.writeFile scheduled onto the existing writeChain.
function recordHandOutcomes(table) {
  if (table.phase !== poker.PHASE.HAND_OVER) return;
  if (!table.lastHandResults || !Array.isArray(table.lastHandResults.winners)) return;
  for (const w of table.lastHandResults.winners) {
    if (!w || !w.name) continue;
    db.incrementStats(w.name, { winsDelta: 1 })
      .catch((err) => console.error('wins increment error:', err));
  }
  // Also stamp lastSeenAt on every still-seated seat: they showed up
  // and finished a hand this session. Skip removed/busted seats here
  // because `lastSeenAt` is a recency signal — a seat that ended the
  // hand as `removed: true` shouldn't bump it (they're out).
  for (const s of table.seats) {
    if (!s || s.removed) continue;
    db.incrementStats(s.name, { seenAt: Date.now() })
      .catch((err) => console.error('seenAt stamp error:', err));
  }
}

async function scheduleNextHand(tableId) {
  const t = rooms.get(tableId);
  if (!t) return;
  await saveStacksToDB(t);
  // Captured results BEFORE endHand wipes lastHandResults. Busted-refund
  // hands already null-ed their winners inside checkBustedRefund, so the
  // filter below correctly skips them.
  recordHandOutcomes(t);
  // House-fee routing: spend the in-memory `_pendingHouseFees` accumulator
  // and forward it to the primary admin user. MUST run AFTER saveStacksToDB
  // (so the players' chip counts reflect the post-awardPot state) and
  // BEFORE poker.endHand (which doesn't touch _pendingHouseFees but
  // conceptually belongs to "this hand is settled"). Busted-refund clear
  // any pending fees inside checkBustedRefund, so a refunded hand never
  // pays the house.
  //
  // `collectPendingHouseFees` zeroes the accumulator and returns the
  // amount; we then call `db.creditHousePoints` which looks up the
  // admin user by isAdmin=true. If no admin exists, log a warning and
  // move on — the credits simply sit in an uncredited state.
  const houseFees = poker.collectPendingHouseFees(t);
  if (houseFees > 0) {
    db.creditHousePoints(houseFees)
      .then((r) => {
        if (r.ok) {
          console.log('House fee: +' + r.credited + ' to ' + r.adminName + ' (balance ' + r.newBalance + ')');
        } else if (r.reason === 'no_admin') {
          console.warn('House fee: ' + houseFees + ' credits dropped — no player has isAdmin=true.');
        } else {
          console.warn('House fee: credit failed (' + r.reason + ') for ' + houseFees + ' chips.');
        }
      })
      .catch((err) => console.error('House fee credit error:', err));
  }
  poker.endHand(t);
  // Cleanup removed seats (disconnect / leave / busted).
  for (let i = 0; i < t.seats.length; i++) {
    if (t.seats[i] && t.seats[i].removed) t.seats[i] = null;
  }
  // Auto-delete empty non-default tables so the lobby doesn't accumulate
  // ghost tables over time. Default/starter tables (see ensureDefaultTables)
  // stay forever even with zero seats — they're the permanent lobby entry
  // points.
  if (rooms.shouldDeleteAfterHand(t)) {
    // Chat belongs to this session of players; clear it before the table
    // is removed. clearChatIfEmpty is a no-op here only if the seat check
    // returns true, which won't happen in the auto-delete branch.
    rooms.clearChatIfEmpty(tableId);
    rooms.remove(tableId);
    broadcastLobby();
    return;
  }
  broadcastTable(tableId);
  broadcastLobby();
  tryStartHand(tableId);
}

// ----- HTTP routes -----
//
// The legacy static `admin.html` page was removed when admin auth
// migrated from a shared password to per-user isAdmin (see the
// `register` handler below). Admin functionality now lives inside the
// main SPA at /view-admin, gated by socket.data.player.isAdmin on
// both client and server sides.

app.get('/api/random-names', (_req, res) => {
  res.json({ names: generateNames(8) });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, tables: rooms.listTables().length });
});

// Public leaderboard. Returns the top N "playing" players (i.e. ones who
// have actually participated in at least one hand) sorted by points, then
// wins, then games played, then name. Bot-like entries (admin/test fixtures
// that never played) are filtered out at the database layer via
// db.getLeaderboardRows().
//
// Intentionally unauthenticated: this is a friendly-points app where
// surfacing who leads the meta-game is part of the fun. Do not gate this
// behind admin without first auditing whether things like admin_list
// (which still uses socket-side admin) might be confusingly inconsistent.
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const players = await db.getLeaderboardRows({ limit: 50 });
    res.json({ players });
  } catch (err) {
    console.error('leaderboard error:', err);
    res.status(500).json({ error: 'Failed' });
  }
});

// ----- Socket.io handlers -----

io.on('connection', (socket) => {
  socket.on('register', async ({ name }, cb) => {
    try {
      const trimmed = String(name || '').trim();
      if (!trimmed) return cb && cb({ ok: false, error: 'Name required' });
      if (trimmed.length > 20) return cb && cb({ ok: false, error: 'Name too long' });
      if (trimmed.length < 2) return cb && cb({ ok: false, error: 'Name too short' });
      // Disallow chars that confuse logs.
      if (!/^[\w .'\-]+$/.test(trimmed)) return cb && cb({ ok: false, error: 'Invalid characters' });

      const points = await db.getStartingStack();
      const player = await db.getOrCreatePlayer(trimmed, { points });
      socket.data.playerName = player.name;
      socket.data.player = player;
      // Admin flag is now derived from the persisted Player doc — no
      // separate `admin_login` round-trip required. The flag is
      // captured at socket-connect time so admin_* handlers can
      // consult socket.data.isAdmin without an extra DB round trip on
      // every request. A subsequent isAdmin flip in MongoDB won't
      // promote/downgrade this socket until it reconnects; that's an
      // intentional trade-off — see the spec note "no in-app
      // assignment logic needed".
      socket.data.isAdmin = player.isAdmin === true;

      if (!playerSockets.has(player.name)) playerSockets.set(player.name, new Set());
      playerSockets.get(player.name).add(socket.id);
      socketToPlayer.set(socket.id, player.name);

      // Stamp lastSeenAt on every login (new account, returning player,
      // any future reconnection). gamesPlayed + wins are NOT touched here
      // — those are derived from actual hand participation. Fire-and-forget
      // so a slow disk write never delays the hello packet.
      db.incrementStats(player.name, { seenAt: Date.now() })
        .catch((err) => console.error('register stats error:', err));

      socket.emit('hello', { player });
      cb && cb({ ok: true, player });
      broadcastLobby();
    } catch (err) {
      console.error('register error', err);
      cb && cb({ ok: false, error: 'Server error' });
      socket.emit('server_message', { level: 'error', text: 'Server error' });
    }
  });

  socket.on('create_table', ({ name, smallBlind, bigBlind, maxSeats }, cb) => {
    if (!socket.data.player) return cb && cb({ ok: false, error: 'Not logged in' });
    if (!socket.data.isTableCreator) socket.data.isTableCreator = true;
    const sb = clampInt(smallBlind, 1, 1000, 5);
    const bb = clampInt(bigBlind, sb + 1, sb * 100, 10);
    const ms = clampInt(maxSeats, 2, 9, 6);
    const table = rooms.createTable({
      name: (name || '').trim() || ('Table ' + socket.data.player.name),
      smallBlind: sb,
      bigBlind: bb,
      maxSeats: ms,
    });
    broadcastLobby();
    cb && cb({ ok: true, tableId: table.id });
  });

  socket.on('join_table', ({ tableId, seatIdx }, cb) => {
    const player = socket.data.player;
    if (!player) return cb && cb({ ok: false, error: 'Not logged in' });
    const t = rooms.get(tableId);
    if (!t) return cb && cb({ ok: false, error: 'No such table' });
    if (socket.data.tableId && socket.data.tableId !== tableId) {
      return cb && cb({ ok: false, error: 'Already at a table; leave first' });
    }
    if (socket.data.tableId === tableId) {
      return cb && cb({ ok: false, error: 'Already joined' });
    }
    let targetSeat;
    if (typeof seatIdx === 'number' && seatIdx >= 0 && seatIdx < t.seats.length) {
      targetSeat = seatIdx;
    } else {
      targetSeat = rooms.findEmptySeat(tableId);
    }
    if (targetSeat === -1) return cb && cb({ ok: false, error: 'No empty seats' });
    // A seat counts as "taken" ONLY when it's both non-null AND not flagged
    // as removed. The lobby's seatsTaken count (and rooms.findEmptySeat,
    // which both ignore removed seats) treat removed seats as empty, so the
    // take-check has to agree or a player who sees "0/6 seats" in the lobby
    // gets a "Seat taken" toast when they hit Join. The disconnect handler
    // flags seats removed=true but doesn't null them outside mid-hand, and
    // endHand flags busted players the same way — both can leave stale
    // removed-but-non-null seats behind that need to be reclaimable.
    if (t.seats[targetSeat] && !t.seats[targetSeat].removed) return cb && cb({ ok: false, error: 'Seat taken' });

    const result = rooms.seatPlayer(tableId, targetSeat, player);
    if (!result.ok) return cb && cb({ ok: false, error: result.error });

    socket.join('table_' + tableId);
    socket.data.tableId = tableId;
    socket.data.seatIdx = targetSeat;
    broadcastTable(tableId);
    tryStartHand(tableId);
    cb && cb({ ok: true, seatIdx: targetSeat });
  });

  socket.on('leave_table', (_, cb) => {
    const tid = socket.data.tableId;
    const sidx = socket.data.seatIdx;
    if (!tid || sidx == null) return cb && cb({ ok: false, error: 'Not at a table' });
    const t = rooms.get(tid);
    if (!t) return cb && cb({ ok: false, error: 'No such table' });
    // If mid-hand, save stack back + (if leaving player is the current
    // actor) run the same `fold + applyAction` the disconnect handler
    // does. Without this mirror, bettingRoundComplete would still point
    // at a removed-but-not-folded seat and the rotation wouldn't advance
    // — freezing the hand. The fold via the engine also lets fold-out
    // resolve cleanly (awardPot in advancePhase) and triggers the
    // busted-refund hook if the seat ended the hand at stack===0.
    if (t.phase !== poker.PHASE.WAITING && t.phase !== poker.PHASE.HAND_OVER) {
      if (t.seats[sidx]) {
        const seatName = t.seats[sidx].name;
        const stack = t.seats[sidx].stack;
        db.setPoints(seatName, stack).catch(err => console.error('save on leave:', err));
        if (t.currentPlayerIndex === sidx) {
          const result = poker.applyAction(t, sidx, 'fold');
          if (result && result.ok) {
            // The fold may have resolved the hand (fold-out → awardPot
            // grew another seat's stack). Persist every seat so a server
            // crash here doesn't revert pre-fold snapshots.
            saveStacksToDB(t).catch((err) => console.error('save stacks on leave fold:', err));
            // The busted-refund hook mirrors the disconnect path: if any
            // seat ended the hand at stack===0, emit the system chat so
            // other players see why the engine just reset balances.
            if (t.phase === poker.PHASE.HAND_OVER) {
              rooms.emitBustedRefundIfAny(tid);
              broadcastChat(tid);
              scheduleNextHand(tid);
            }
          }
        }
      }
    }
    rooms.unseat(tid, sidx);
    // Clear chat when the leaving player was the last seated one. Chat
    // history belongs to the current session of players; when the session
    // ends, the history is wiped so the next joiner sees an empty panel.
    rooms.clearChatIfEmpty(tid);
    socket.leave('table_' + tid);
    socket.data.tableId = null;
    socket.data.seatIdx = null;
    // Auto-delete empty NON-DEFAULT tables that have no live seats AT
    // THE MOMENT OF LEAVE (rather than waiting for the next
    // scheduleNextHand to fire shouldDeleteAfterHand at HAND_OVER).
    // A non-default table whose creator sat alone + then left should
    // vanish from the lobby immediately rather than ghosting on with
    // 0/6 seats and confusing everyone. Default tables (the 5
    // permanent ones shipped with the server) are exempt — see
    // shouldDeleteAfterHand's `if (table.default) return false`.
    if (rooms.shouldDeleteAfterHand(t)) {
      rooms.remove(tid);
      // Skip per-table broadcasts — the table is gone. Just refresh
      // the lobby so the deleted card disappears for every connected
      // client.
      broadcastLobby();
      cb && cb({ ok: true });
      return;
    }
    broadcastTable(tid);
    broadcastLobby();
    tryStartHand(tid);
    cb && cb({ ok: true });
  });

  socket.on('sit_out', (_, cb) => {
    const tid = socket.data.tableId;
    const sidx = socket.data.seatIdx;
    if (!tid || sidx == null) return cb && cb({ ok: false, error: 'Not seated' });
    const t = rooms.get(tid);
    if (!t) return cb && cb({ ok: false, error: 'No such table' });
    if (!t.seats[sidx]) return cb && cb({ ok: false, error: 'Empty seat' });
    const result = poker.applyAction(t, sidx, 'sit_out');
    if (!result.ok) return cb && cb({ ok: false, error: result.error });
    db.incrementStats(player.name, { seenAt: Date.now() })
      .catch((err) => console.error('sit_out stats error:', err));
    // Sit-out mid-hand folds the seat. If this is the last live player to
    // fold, `awardPot` mutates another seat's stack inside `advancePhase`.
    // Persist every seat so the winner's grown stack reaches DB before any
    // crash (scheduleNextHand runs async and could miss a server halt).
    saveStacksToDB(t).catch((err) => console.error('save stacks on sit_out:', err));
    // Busted-refund hook: a sit-out may still trigger checkBustedRefund
    // (e.g. all-in player + remaining live player sits out → fold-out →
    // awardPot → checkBustedRefund). Emit the system chat so other
    // players see why balances were just reset.
    if (t.phase === poker.PHASE.HAND_OVER) {
      rooms.emitBustedRefundIfAny(tid);
      broadcastChat(tid);
      scheduleNextHand(tid);
    } else {
      broadcastTable(tid);
    }
    cb && cb({ ok: true });
  });

  socket.on('sit_in', (_, cb) => {
    const tid = socket.data.tableId;
    const sidx = socket.data.seatIdx;
    if (!tid || sidx == null) return cb && cb({ ok: false, error: 'Not seated' });
    const t = rooms.get(tid);
    if (!t) return cb && cb({ ok: false, error: 'No such table' });
    if (!t.seats[sidx]) return cb && cb({ ok: false, error: 'Empty seat' });
    if (t.seats[sidx].stack <= 0) return cb && cb({ ok: false, error: 'No chips (ask admin to add)' });
    const result = poker.applyAction(t, sidx, 'sit_in');
    if (!result.ok) return cb && cb({ ok: false, error: result.error });
    db.incrementStats(player.name, { seenAt: Date.now() })
      .catch((err) => console.error('sit_in stats error:', err));
    saveStacksToDB(t).catch((err) => console.error('save stacks on sit_in:', err));
    // Busted-refund hook (mirrors sit_out): the engine's end-of-round
    // block in applyAction may flip the table to HAND_OVER + set
    // t._bustedRefundThisHand even on a sit_in (rare — only if it
    // triggered a fold-out somehow). Surface the chat consistently.
    if (t.phase === poker.PHASE.HAND_OVER) {
      rooms.emitBustedRefundIfAny(tid);
      broadcastChat(tid);
      scheduleNextHand(tid);
    } else {
      broadcastTable(tid);
    }
    cb && cb({ ok: true });
  });

  socket.on('chat_message', ({ tableId, text }, cb) => {
    const player = socket.data.player;
    if (!player) return cb && cb({ ok: false, error: 'Not logged in' });
    // Per-socket rate limit: 500ms between sends. Prevents leaning-on-Enter
    // spam from causing broadcast storms + client-side repaint lag. The
    // HTML maxlength=200 attribute already caps paste length on the client;
    // rooms.addChatMessage slices to 200 server-side as defense-in-depth.
    const now = Date.now();
    if (socket.data.lastChatAt && now - socket.data.lastChatAt < 500) {
      return cb && cb({ ok: false, error: 'Slow down' });
    }
    socket.data.lastChatAt = now;
    const result = rooms.addChatMessage(tableId, player.name, text);
    if (!result.ok) return cb && cb(result);
    broadcastChat(tableId);
    cb && cb({ ok: true });
  });

  socket.on('action', ({ tableId, type, amount }, cb) => {
    const player = socket.data.player;
    if (!player) return cb && cb({ ok: false, error: 'Not logged in' });
    const t = rooms.get(tableId);
    if (!t) return cb && cb({ ok: false, error: 'No such table' });
    const sidx = socket.data.seatIdx;
    if (sidx == null) return cb && cb({ ok: false, error: 'Not seated' });
    if (!t.seats[sidx] || t.seats[sidx].name !== player.name) {
      return cb && cb({ ok: false, error: 'Not your seat' });
    }
    const result = poker.applyAction(t, sidx, type, amount);
    if (!result.ok) {
      cb && cb({ ok: false, error: result.error });
      // Surface as a 'server_message' toast for the user (avoid collision
      // with socket.io's reserved 'error' event).
      socket.emit('server_message', { level: 'error', text: result.error });
      return;
    }
    db.incrementStats(player.name, { seenAt: Date.now() })
      .catch((err) => console.error('action seenAt error:', err));
    // Best-effort: persist ALL stacks after each action so a server crash
    // mid-hand loses little. The actor's own save was the historical default,
    // but a fold-out resolves the pot inside `awardPot` (called from
    // `advancePhase` when `liveCount <= 1`), which boosts a *different*
    // seat's stack — that winner's stack is otherwise only persisted at
    // HAND_OVER via `scheduleNextHand`'s saveStacksToDB. Saving the whole
    // table here guarantees the DB matches memory at every action boundary,
    // not just at hand end.
    saveStacksToDB(t).catch((err) => console.error('save stacks on action:', err));
    broadcastTable(tableId);
    cb && cb({ ok: true });

    if (t.phase === poker.PHASE.HAND_OVER) {
      // Busted-refund hook: if any seat ended the hand with stack===0
      // (the engine fired checkBustedRefund between awardPot and the
      // end-of-round block), surface it in chat so players see their
      // balances magically reset and understand why. The helper
      // centralizes the wording + marker-clear so every caller
      // (action / sit_out / sit_in / AFK loop) emits the same line.
      rooms.emitBustedRefundIfAny(tableId);
      broadcastChat(tableId);
      scheduleNextHand(tableId);
    }
  });

  socket.on('random_names', (_, cb) => {
    cb && cb({ names: generateNames(8) });
  });

  // ----- Admin handlers -----
  //
  // Every admin_* socket below reads `socket.data.isAdmin`, which is
  // stamped from `player.isAdmin` during `register`. There is no
  // password step — per the spec, admin provisioning happens entirely
  // out-of-band (manual Mongo update + isAdmin=true on the host's
  // own player doc). All admin endpoints (including the legacy ones
  // for player point management inherited from the prior shared-
  // password flow) therefore reject with `{ ok: false, error:
  // 'Not admin' }` if the requesting socket isn't flagged.
  //
  // Helper so every handler's auth line stays identical + greppable
  // for audits. Tests cover each handler with both an admin and a
  // non-admin socket to lock down the rejection path.
  function requireAdmin(cb) {
    if (!socket.data.isAdmin) {
      if (cb) cb({ ok: false, error: 'Not admin' });
      return false;
    }
    return true;
  }

  socket.on('admin_list', async (_, cb) => {
    if (!requireAdmin(cb)) return;
    const players = (await db.getAllPlayers())
      .sort((a, b) => b.points - a.points);
    cb && cb({ ok: true, players });
  });

  socket.on('admin_set_points', async ({ name, points }, cb) => {
    if (!requireAdmin(cb)) return;
    const p = await db.setPoints(name, points);
    if (!p) return cb && cb({ ok: false, error: 'No such player' });
    await applyAdminPointsChangeToSeats(name, p.points);
    cb && cb({ ok: true, player: p });
  });

  socket.on('admin_add_points', async ({ name, delta }, cb) => {
    if (!requireAdmin(cb)) return;
    const p = await db.addPoints(name, delta);
    if (!p) return cb && cb({ ok: false, error: 'No such player' });
    await applyAdminPointsChangeToSeats(name, p.points);
    cb && cb({ ok: true, player: p });
  });

  socket.on('admin_remove', async ({ name }, cb) => {
    if (!requireAdmin(cb)) return;
    await db.deletePlayer(name);
    // Also clear from any seat.
    for (const t of rooms.tables.values()) {
      for (let i = 0; i < t.seats.length; i++) {
        if (t.seats[i] && t.seats[i].name === name) t.seats[i] = null;
      }
    }
    broadcastAllTables();
    cb && cb({ ok: true });
  });

  // Global starting stack (sets the default for brand-new players in
  // meta.startingStack). Kept as an admin endpoint separate from the
  // per-table `startingStack` editable in admin_update_session —
  // they're different surfaces with different scopes.
  socket.on('admin_set_starting_stack', async ({ amount }, cb) => {
    if (!requireAdmin(cb)) return;
    await db.setStartingStack(amount);
    cb && cb({ ok: true });
  });

  // ----- New admin endpoints (per-user isAdmin flow) -----

  // ----- Legacy shared-password admin auth (restored per user spec) -----
  //
  // The admin modal in public/index.html asks the host for a shared
  // password (default 'admin123', stored on the meta singleton) and
  // unlocks every gated admin_* handler below. The flow coexists with
  // the per-Player `isAdmin` flag set at register time — both paths
  // simply set `socket.data.isAdmin = true` so the existing
  // requireAdmin() gate works without changes.
  //
  // Server returns no distinguishing info on a wrong password — just
  // `{ ok: false, error: 'Wrong password' }` — so a brute-force
  // guesser can't tell wrong-password from an internal fault.
  socket.on('admin_login', async ({ password }, cb) => {
    try {
      const expected = await db.getAdminPassword();
      if (typeof password !== 'string' || password !== expected) {
        return cb && cb({ ok: false, error: 'Wrong password' });
      }
      socket.data.isAdmin = true;
      // Include the current global starting stack + admin password hint
      // in the ack so the modal can pre-populate the input on first
      // open without a separate round-trip. (Avoids the "blank input"
      // UX bug where the host had to type blind.)
      const startingStack = await db.getStartingStack();
      return cb && cb({ ok: true, startingStack });
    } catch (err) {
      console.error('admin_login error:', err);
      return cb && cb({ ok: false, error: 'Server error' });
    }
  });

  // Change the shared admin password. Requires active admin session on
  // this socket (set via admin_login OR via the register-time isAdmin
  // gate). The old password is verified BEFORE the new one is
  // persisted — a typo in the user's CURRENT password leaves the
  // stored value untouched.
  socket.on('admin_change_password', async ({ oldPassword, newPassword }, cb) => {
    if (!requireAdmin(cb)) return;
    if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
      return cb && cb({ ok: false, error: 'Bad payload' });
    }
    if (newPassword.length < 3 || newPassword.length > 200) {
      return cb && cb({ ok: false, error: 'Password must be 3–200 characters' });
    }
    try {
      const current = await db.getAdminPassword();
      if (oldPassword !== current) {
        return cb && cb({ ok: false, error: 'Current password is wrong' });
      }
      await db.setAdminPassword(newPassword);
      return cb && cb({ ok: true });
    } catch (err) {
      console.error('admin_change_password error:', err);
      return cb && cb({ ok: false, error: 'Server error' });
    }
  });

  // Bulk list every active table + its editable settings in one
  // payload. The admin panel uses this to populate its session-list
  // card grid; subsequent edits target a single tableId via
  // admin_update_session. Read-only — no auth-gated mutation paths
  // are exposed on this endpoint.
  socket.on('admin_list_sessions', (_, cb) => {
    if (!requireAdmin(cb)) return;
    cb && cb({ ok: true, sessions: rooms.listTables() });
  });

  // Single-table settings edit. Server runs the requested fields
  // through `db.validateTableSettings` (clamping + smallBlind < bigBlind
  // invariant) BEFORE applying, and `rooms.updateTableSettings` (which
  // itself rejects mid-hand edits). Persistence is the second half of
  // the write — if the upsert fails, we roll the in-memory values back
  // from the supplied `previous` snapshot so the client can detect the
  // divergence on its next admin_list_sessions poll.
  socket.on('admin_update_session', async ({ tableId, settings }, cb) => {
    if (!requireAdmin(cb)) return;
    const t = rooms.get(tableId);
    if (!t) return cb && cb({ ok: false, error: 'No such table' });
    // Snapshot the previous in-memory values so we can roll back on
    // upsert failure. The admin panel's optimistic UI flips first;
    // this keep-then-revert sequence hides any disk-write latency.
    const previous = {
      bigBlind: t.bigBlind,
      smallBlind: t.smallBlind,
      startingStack: t.startingStack,
      houseFeePercent: t.houseFeePercent,
      maxSeats: t.maxSeats,
    };
    // Validate + apply in-memory.
    const validated = db.validateTableSettings(
      Object.assign({}, previous, settings || {}),
      previous
    );
    const applied = rooms.updateTableSettings(tableId, validated, socket.data.player.name);
    if (!applied.ok) {
      return cb && cb({ ok: false, error: applied.error });
    }
    // Persist to MongoDB keyed by table NAME (see database.js for why
    // name > tableId). Fire-and-confirm: we await the upsert so the
    // callback can reflect success/failure, but we don't block the
    // broadcast on this — broadcastTable below runs eagerly so the
    // admin + every viewer sees the new settings immediately.
    try {
      await db.upsertTableSettings(t.name, applied.settings, socket.data.player.name);
    } catch (err) {
      // Roll back the in-memory change. The cache row we just wrote
      // via updateTableSettings also needs to flip back so a restart
      // doesn't restore the unpersisted values.
      rooms.updateTableSettings(tableId, previous, socket.data.player.name)
        .catch(() => {}); // best-effort
      return cb && cb({ ok: false, error: 'Persist failed: ' + err.message });
    }
    // Live broadcast: the in-memory state has already mutated, so a
    // broadcastTable loop lets every viewer (including the admin's
    // own socket) see the updated blinds in the lobby card + the
    // active table view.
    broadcastTable(tableId);
    broadcastLobby();
    cb && cb({ ok: true, settings: applied.settings });
  });

  // Returns the host's admin player doc + balance. The admin panel
  // shows "House: <name> • <balance> pts" in its header; this is the
  // endpoint that populates it. If no admin exists, returns
  // `{ ok: false, reason: 'no_admin' }` so the panel renders a
  // "Configure admin in MongoDB" hint instead of crashing.
  socket.on('admin_get_house_info', async (_, cb) => {
    if (!requireAdmin(cb)) return;
    const admin = await db.getPrimaryAdminPlayer();
    if (!admin) return cb && cb({ ok: false, reason: 'no_admin' });
    cb && cb({
      ok: true,
      admin: {
        name: admin.name,
        id: admin.id,
        points: admin.points,
      },
    });
  });

  socket.on('disconnect', () => {
    const name = socketToPlayer.get(socket.id);
    if (name) {
      const set = playerSockets.get(name);
      if (set) {
        set.delete(socket.id);
        if (set.size === 0) playerSockets.delete(name);
      }
    }
    socketToPlayer.delete(socket.id);

    const tid = socket.data.tableId;
    const sidx = socket.data.seatIdx;
    if (tid != null && sidx != null) {
      const t = rooms.get(tid);
      if (t && t.seats[sidx]) {
        const seat = t.seats[sidx];
        seat.disconnected = true;
        if (t.phase !== poker.PHASE.WAITING && t.phase !== poker.PHASE.HAND_OVER) {
          seat.removed = true;
          if (t.currentPlayerIndex === sidx) {
            poker.applyAction(t, sidx, 'fold');
            // Mid-hand disconnect-folds can resolve the hand via fold-out,
            // which lets `awardPot` push the pot into another seat's stack.
            // Save every seat so a crash here doesn't revert the disconnected
            // crash-recovery to the pre-fold snapshot for the winner.
            saveStacksToDB(t).catch((err) => console.error('save stacks on disconnect fold:', err));
            broadcastTable(tid);
          } else {
            seat.folded = true;
          }
        } else {
          seat.removed = true;
        }
      }
      // Clear chat when the disconnected player was the last seated one.
      rooms.clearChatIfEmpty(tid);
    }
    broadcastLobby();
  });
});

function clampInt(value, min, max, fallback) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

// ----- Start server -----

server.listen(PORT, HOST, () => {
  console.log('=================================================');
  console.log('  Friendly Poker server is up!');
  console.log('  Open: http://localhost:' + PORT);
  console.log('  Admin: set is_admin=true on the Player doc in MongoDB.');
  console.log('  No shared admin password — isAdmin flag is the only gate.');
  console.log('=================================================');
});

process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function shutdown(signal) {
  console.log('\nReceived ' + signal + ' - shutting down...');
  clearInterval(lobbyBroadcastInterval);
  // BEFORE snapshotting, stop every code path that could mutate seat stacks:
  //   1. tryStartHand's 3-second setTimeout (rooms.nextHandTimers) — its
  //      callback calls poker.startHand, which posts blinds and adjusts
  //      seat stacks.
  //   2. io.close() — disconnects live sockets, which fires our disconnect
  //      handler. That handler applies 'fold' (stacks unchanged for the
  //      folder but awardPot may grow the winner), and is exactly the
  //      final stack state we want to persist.
  // Awaiting io.close() means we wait for all disconnect handlers to drain
  // before snapshotting — no post-snapshot mutation is possible.
  for (const [tid, timer] of rooms.nextHandTimers.entries()) {
    clearTimeout(timer);
    rooms.nextHandTimers.delete(tid);
  }
  await new Promise((resolve) => io.close(() => resolve()));
  // Persist every seated player's stack so a graceful restart (e.g. a
  // deployment) doesn't lose in-flight chips.
  for (const t of rooms.tables.values()) {
    try { await saveStacksToDB(t); }
    catch (err) { console.error('shutdown save error:', err); }
  }
  await new Promise((resolve) => server.close(() => resolve()));
  process.exit(0);
}
