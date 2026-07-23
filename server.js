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
const { RoomManager } = require('./src/rooms');

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { maxHttpBufferSize: 1e6 });

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const rooms = new RoomManager();
// Create the 5 permanent default tables immediately so the lobby is never
// empty — even on a fresh server start with zero connected players.
rooms.ensureDefaultTables();

// Session tracking
const playerSockets   = new Map(); // playerName -> Set<socketId>
const socketToPlayer  = new Map(); // socketId -> playerName
const socketToAdmin   = new Set(); // socketIds currently in admin mode
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
    broadcastTable(tableId);
  }, 3000);
  rooms.nextHandTimers.set(tableId, timer);
  // Tell the table a countdown is happening
  broadcastTable(tableId);
}

async function scheduleNextHand(tableId) {
  const t = rooms.get(tableId);
  if (!t) return;
  await saveStacksToDB(t);
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

app.get('/admin', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/random-names', (_req, res) => {
  res.json({ names: generateNames(8) });
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, tables: rooms.listTables().length });
});

// Public leaderboard. Returns the top N players by points so the lobby
// nav can show off the meta-game without requiring admin login. Only name
// + points are exposed (no IDs / no created timestamps).
//
// Intentionally unauthenticated: this is a friendly-points app where
// surfacing who leads the meta-game is part of the fun. Do not gate this
// behind admin without first auditing whether things like admin_list
// (which still uses socket-side admin) might be confusingly inconsistent.
app.get('/api/leaderboard', async (_req, res) => {
  try {
    const all = await db.getAllPlayers();
    const players = all
      .filter((p) => p && p.name)
      .sort((a, b) => (b.points || 0) - (a.points || 0) || a.name.localeCompare(b.name))
      .slice(0, 50)
      .map((p) => ({ name: p.name, points: Math.max(0, Math.floor(p.points || 0)) }));
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

      if (!playerSockets.has(player.name)) playerSockets.set(player.name, new Set());
      playerSockets.get(player.name).add(socket.id);
      socketToPlayer.set(socket.id, player.name);

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
    // If mid-hand, save stack back before unseat.
    if (t.phase !== poker.PHASE.WAITING && t.phase !== poker.PHASE.HAND_OVER) {
      if (t.seats[sidx]) {
        const seatName = t.seats[sidx].name;
        const stack = t.seats[sidx].stack;
        db.setPoints(seatName, stack).catch(err => console.error('save on leave:', err));
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

  socket.on('admin_login', async ({ password }, cb) => {
    try {
      const ok = await db.checkAdminPassword(password);
      if (!ok) return cb && cb({ ok: false, error: 'Wrong password' });
      socketToAdmin.add(socket.id);
      socket.data.isAdmin = true;
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ ok: false, error: 'Server error' });
    }
  });

  socket.on('admin_logout', (_, cb) => {
    socketToAdmin.delete(socket.id);
    socket.data.isAdmin = false;
    cb && cb({ ok: true });
  });

  socket.on('admin_list', async (_, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false, error: 'Not admin' });
    const players = (await db.getAllPlayers())
      .sort((a, b) => b.points - a.points);
    cb && cb({ ok: true, players });
  });

  socket.on('admin_set_points', async ({ name, points }, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false, error: 'Not admin' });
    const p = await db.setPoints(name, points);
    if (!p) return cb && cb({ ok: false, error: 'No such player' });
    await applyAdminPointsChangeToSeats(name, p.points);
    cb && cb({ ok: true, player: p });
  });

  socket.on('admin_add_points', async ({ name, delta }, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false, error: 'Not admin' });
    const p = await db.addPoints(name, delta);
    if (!p) return cb && cb({ ok: false, error: 'No such player' });
    await applyAdminPointsChangeToSeats(name, p.points);
    cb && cb({ ok: true, player: p });
  });

  socket.on('admin_remove', async ({ name }, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false, error: 'Not admin' });
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

  socket.on('admin_change_password', async ({ newPassword }, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false, error: 'Not admin' });
    try {
      await db.setAdminPassword(newPassword);
      cb && cb({ ok: true });
    } catch (err) {
      cb && cb({ ok: false, error: err.message });
    }
  });

  socket.on('admin_set_starting_stack', async ({ amount }, cb) => {
    if (!socket.data.isAdmin) return cb && cb({ ok: false, error: 'Not admin' });
    await db.setStartingStack(amount);
    cb && cb({ ok: true });
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
    socketToAdmin.delete(socket.id);

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
  console.log('  Admin password: admin123 (change via admin panel)');
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
