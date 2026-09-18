// RoomManager.moveSeat tests — the seat swap behind the client's
// 3-dot table menu (⋮ → "Change seat"). Run with: npm test
// Exits 1 on any failure.

'use strict';

const assert = require('assert');
const { RoomManager, loadPersistedSettingsIntoCache } = require('../src/rooms');
const poker = require('../src/poker');

loadPersistedSettingsIntoCache([]);
const rooms = new RoomManager();

// ----- happy path (WAITING phase) -----
{
  const t = rooms.createTable({ name: 'Move1', maxSeats: 4, minPoints: 0 });
  const alice = { id: 'p1', name: 'Alice', points: 700, profilePhoto: 'data:image/png;base64,AAAA' };
  const bob   = { id: 'p2', name: 'Bob',   points: 500 };
  rooms.seatPlayer(t.id, 1, alice);
  rooms.seatPlayer(t.id, 3, bob);

  const res = rooms.moveSeat(t.id, 1, 0);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.seatIdx, 0);
  assert.strictEqual(t.seats[1], null, 'old seat must be freed');
  assert.strictEqual(t.seats[0].name, 'Alice', 'player must occupy the new seat');
  assert.strictEqual(t.seats[0].stack, 700, 'stack must carry over');
  assert.strictEqual(t.seats[0].avatar, alice.profilePhoto, 'avatar must carry over');
  assert.strictEqual(t.seats[0].playerId, 'p1', 'playerId must carry over');
  assert.strictEqual(t.seats[3].name, 'Bob', 'other players must be untouched');
  assert.strictEqual(t.phase, poker.PHASE.WAITING);
}

// ----- satOut flag carries over -----
{
  const t = rooms.createTable({ name: 'Move2', maxSeats: 3 });
  rooms.seatPlayer(t.id, 0, { id: 'p1', name: 'Alice', points: 700 });
  t.seats[0].satOut = true;
  const res = rooms.moveSeat(t.id, 0, 2);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(t.seats[2].satOut, true, 'satOut preference must survive the move');
}

// ----- removed (stale) target seat is reclaimable -----
{
  const t = rooms.createTable({ name: 'Move3', maxSeats: 3 });
  rooms.seatPlayer(t.id, 0, { id: 'p1', name: 'Alice', points: 700 });
  rooms.seatPlayer(t.id, 2, { id: 'p9', name: 'Ghost', points: 100 });
  // endHand-style stale occupant: busted seat stays non-null but removed.
  t.seats[2].removed = true;
  const res = rooms.moveSeat(t.id, 0, 2);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(t.seats[2].name, 'Alice');
  assert.strictEqual(t.seats[2].removed, false, 'stale shell must be overwritten');
}

// ----- moving to the same seat is an idempotent no-op -----
{
  const t = rooms.createTable({ name: 'Move4', maxSeats: 3 });
  rooms.seatPlayer(t.id, 0, { id: 'p1', name: 'Alice', points: 700 });
  const res = rooms.moveSeat(t.id, 0, 0);
  assert.strictEqual(res.ok, true);
  assert.strictEqual(res.unchanged, true);
  assert.strictEqual(t.seats[0].name, 'Alice');
}

// ----- occupied target is rejected -----
{
  const t = rooms.createTable({ name: 'Move5', maxSeats: 3 });
  rooms.seatPlayer(t.id, 0, { id: 'p1', name: 'Alice', points: 700 });
  rooms.seatPlayer(t.id, 1, { id: 'p2', name: 'Bob', points: 500 });
  const res = rooms.moveSeat(t.id, 0, 1);
  assert.strictEqual(res.ok, false);
  assert.strictEqual(res.error, 'Seat taken');
  assert.strictEqual(t.seats[0].name, 'Alice', 'source seat must be untouched on failure');
  assert.strictEqual(t.seats[1].name, 'Bob');
}

// ----- mid-hand move is rejected -----
{
  const t = rooms.createTable({ name: 'Move6', maxSeats: 3 });
  rooms.seatPlayer(t.id, 0, { id: 'p1', name: 'Alice', points: 700 });
  rooms.seatPlayer(t.id, 1, { id: 'p2', name: 'Bob', points: 500 });
  // Force a dealt-hand phase without going through startHand's timers.
  t.phase = poker.PHASE.PRE_FLOP;
  const res = rooms.moveSeat(t.id, 0, 2);
  assert.strictEqual(res.ok, false);
  assert.match(res.error, /during a hand/);
  assert.strictEqual(t.seats[0].name, 'Alice', 'mid-hand rejection must leave seats untouched');
  assert.strictEqual(t.seats[2], null);
}

// ----- bad arguments are rejected -----
{
  const t = rooms.createTable({ name: 'Move7', maxSeats: 3 });
  rooms.seatPlayer(t.id, 0, { id: 'p1', name: 'Alice', points: 700 });
  assert.strictEqual(rooms.moveSeat('nope', 0, 1).ok, false, 'unknown table');
  assert.strictEqual(rooms.moveSeat(t.id, -1, 1).ok, false, 'negative source');
  assert.strictEqual(rooms.moveSeat(t.id, 0, 3).ok, false, 'target out of range');
  assert.strictEqual(rooms.moveSeat(t.id, 0, 1.5).ok, false, 'non-integer target');
  assert.strictEqual(rooms.moveSeat(t.id, 2, 1).ok, false, 'empty source seat');
  assert.strictEqual(t.seats[0].name, 'Alice');
  assert.strictEqual(t.seats[1], null);
}

// ----- full end-to-end: engine deals next hand from the NEW seat layout -----
{
  const t = rooms.createTable({ name: 'Move8', maxSeats: 4, smallBlind: 5, bigBlind: 10 });
  const alice = { id: 'p1', name: 'Alice', points: 1000 };
  const bob   = { id: 'p2', name: 'Bob',   points: 1000 };
  rooms.seatPlayer(t.id, 1, alice);
  rooms.seatPlayer(t.id, 3, bob);
  // First hand is dealt from the ORIGINAL layout.
  assert.strictEqual(poker.startHand(t), true);
  assert.strictEqual(t.phase, poker.PHASE.PRE_FLOP);
  // Hand ends (simulate complete hand bookkeeping), then the move happens.
  t.phase = poker.PHASE.HAND_OVER;
  const res = rooms.moveSeat(t.id, 1, 0);
  assert.strictEqual(res.ok, true);
  // Next hand must deal cleanly with the new seat layout.
  assert.strictEqual(poker.startHand(t), true);
  assert.strictEqual(t.phase, poker.PHASE.PRE_FLOP);
  assert.ok(t.seats[0].holeCards.length === 2, 'moved player must be dealt in at the new seat');
  assert.ok(
    (t.seats[2] && t.seats[2].holeCards.length === 2) || (t.seats[3] && t.seats[3].holeCards.length === 2),
    'opponent must be dealt in'
  );
  assert.strictEqual(t.pot, 15, 'blinds must post from the new layout');
}

console.log('move_seat tests: passed');
