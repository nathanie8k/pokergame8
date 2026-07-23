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
    broadcastTable(tid);
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
    broadcastTable(tid);
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
    // Best-effort: persist stack after each action so disconnect mid-hand loses little.
    if (t.seats[sidx]) {
      db.setPoints(t.seats[sidx].name, t.seats[sidx].stack).catch(() => {});
    }
    broadcastTable(tableId);
    cb && cb({ ok: true });

    if (t.phase === poker.PHASE.HAND_OVER) {
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
            broadcastTable(tid);
          } else {
            seat.folded = true;
          }
        } else {
          seat.removed = true;
        }
      }
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

function shutdown(signal) {
  console.log('\nReceived ' + signal + ' - shutting down...');
  clearInterval(lobbyBroadcastInterval);
  io.close();
  server.close(() => process.exit(0));
}
