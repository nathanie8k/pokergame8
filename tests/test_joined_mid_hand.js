// Mid-hand join tests — a player who sits down while a hand is already
// running must be seated but held out of that hand:
//   seated + `joinedMidHand` flag
//   no cards dealt, no turn, no showdown, no action accepted
//   skipped in the turn order until the hand ends
//   cleared + dealt in normally on the next hand
// Run with: npm test
// Exits 1 on any failure.

'use strict';

const assert = require('assert');
const { RoomManager, loadPersistedSettingsIntoCache } = require('../src/rooms');
const poker = require('../src/poker');

loadPersistedSettingsIntoCache([]);
const rooms = new RoomManager();

const alice = { id: 'p1', name: 'Alice', points: 1000 };
const bob   = { id: 'p2', name: 'Bob',   points: 1000 };
const carol = { id: 'p3', name: 'Carol', points: 1000 };

// ----- a seat taken between hands is a normal seat -----
{
  const t = rooms.createTable({ name: 'Between hands', maxSeats: 6 });
  rooms.seatPlayer(t.id, 0, alice);
  rooms.seatPlayer(t.id, 1, bob);
  assert.strictEqual(t.seats[0].joinedMidHand, false, 'WAITING table seats are normal seats');
  assert.strictEqual(t.seats[1].joinedMidHand, false, 'WAITING table seats are normal seats');

  // HAND_OVER is the other safe window: the hand is settled and the next
  // deal has not started, so a new seat is a full participant.
  t.phase = poker.PHASE.HAND_OVER;
  rooms.seatPlayer(t.id, 2, carol);
  assert.strictEqual(t.seats[2].joinedMidHand, false, 'HAND_OVER is between hands');
}

// ----- a seat taken mid-hand is flagged and dealt nothing -----
const t = rooms.createTable({ name: 'Mid hand', maxSeats: 6 });
rooms.seatPlayer(t.id, 0, alice);
rooms.seatPlayer(t.id, 1, bob);
assert.strictEqual(poker.startHand(t), true, 'two seated players start a hand');
assert.notStrictEqual(t.phase, poker.PHASE.WAITING);

rooms.seatPlayer(t.id, 2, carol);
const joiner = t.seats[2];
assert.strictEqual(joiner.joinedMidHand, true, 'a mid-hand seat is flagged joinedMidHand');
assert.deepStrictEqual(joiner.holeCards, [], 'a mid-hand joiner is dealt no cards');
assert.strictEqual(joiner.folded, false, 'a mid-hand joiner is not folded');
assert.strictEqual(joiner.contributed, 0, 'a mid-hand joiner has nothing on the felt');

// The public view tells clients about the queue state.
{
  const view = rooms.publicView(t.id, carol.id, carol.name);
  assert.strictEqual(view.seats[2].joinedMidHand, true, 'publicView exposes joinedMidHand');
  assert.strictEqual(view.seats[2].holeCards, null, 'publicView still hides the empty hand');
  assert.strictEqual(view.seats[0].joinedMidHand, false, 'players in the hand are not flagged');
  assert.strictEqual(view.seats[1].joinedMidHand, false, 'players in the hand are not flagged');
}

// ----- the joiner is skipped in turn order and cannot act -----
for (let from = 0; from < t.seats.length; from++) {
  assert.notStrictEqual(
    poker.nextActivePlayer(t, from), 2,
    'turn order must never land on a mid-hand joiner (from seat ' + from + ')'
  );
}
assert.strictEqual(poker.canCheck(t, 2), false, 'a mid-hand joiner can never check');
assert.deepStrictEqual(
  poker.applyAction(t, 2, 'check'), { ok: false, error: 'Waiting for next hand' },
  'check is refused for a mid-hand joiner'
);
assert.deepStrictEqual(
  poker.applyAction(t, 2, 'fold'), { ok: false, error: 'Waiting for next hand' },
  'fold is refused for a mid-hand joiner'
);
assert.strictEqual(t.seats[2].folded, false, 'a refused action does not fold the joiner');

// The joiner also cannot poach a seat in the hand's live counts.
assert.strictEqual(poker.countLivePlayers(t), 2, 'live count ignores the mid-hand joiner');
// ...but they DO count as a body for the next deal.
assert.strictEqual(poker.countPlayablePlayers(t), 3, 'the joiner counts for the next hand');

// ----- the running hand finishes without the joiner -----
let guard = 0;
while (t.phase !== poker.PHASE.HAND_OVER && guard++ < 50) {
  const actor = t.currentPlayerIndex;
  assert.ok(actor >= 0, 'a betting round always has an actor');
  assert.notStrictEqual(actor, 2, 'the mid-hand joiner is never asked to act');
  assert.strictEqual(poker.applyAction(t, actor, 'fold').ok, true);
}
assert.strictEqual(t.phase, poker.PHASE.HAND_OVER, 'the hand ends by fold-out');
assert.strictEqual(t.seats[2].contributed, 0, 'the joiner put nothing in the pot');
assert.strictEqual(t.seats[2].acted, false, 'the joiner never took a turn');
assert.strictEqual(t.seats[2].joinedMidHand, true, 'still queued while the table is settling');
assert.strictEqual(t.seats[2].storedHandName, null, 'the joiner is not part of the showdown');

// ----- the next hand clears the flag and deals them in -----
poker.endHand(t);
assert.strictEqual(t.phase, poker.PHASE.WAITING);
assert.strictEqual(t.seats[2].joinedMidHand, true, 'the flag survives until the next deal');

assert.strictEqual(poker.startHand(t), true, 'the next hand starts with three players');
assert.strictEqual(t.seats[2].joinedMidHand, false, 'startHand clears joinedMidHand');
assert.strictEqual(t.seats[2].holeCards.length, 2, 'the former joiner is dealt in');
assert.strictEqual(t.seats[2].folded, false);
assert.strictEqual(t.seats[2].removed, false);

// And they are a normal actor again: the engine can hand them the turn.
let reached = false;
for (let from = 0; from < t.seats.length; from++) {
  if (poker.nextActivePlayer(t, from) === 2) reached = true;
}
assert.strictEqual(reached, true, 'the former joiner is back in the turn order');

// ----- a joiner with a 0 stack does not void the hand in progress -----
{
  const t0 = rooms.createTable({ name: 'Broke joiner', maxSeats: 6 });
  rooms.seatPlayer(t0.id, 0, { id: 'b1', name: 'Dana', points: 1000 });
  rooms.seatPlayer(t0.id, 1, { id: 'b2', name: 'Eve', points: 1000 });
  assert.strictEqual(poker.startHand(t0), true);
  rooms.seatPlayer(t0.id, 2, { id: 'b3', name: 'Finn', points: 0 });
  assert.strictEqual(t0.seats[2].joinedMidHand, true);
  assert.strictEqual(t0.seats[2].stack, 0);
  // Fold the hand out: the broke joiner must not be mistaken for a busted
  // player and refund the hand.
  assert.strictEqual(poker.applyAction(t0, t0.currentPlayerIndex, 'fold').ok, true);
  assert.strictEqual(t0.phase, poker.PHASE.HAND_OVER);
  assert.notStrictEqual(t0.lastHandResults, null, 'the hand still has a real, paid-out winner');
  assert.strictEqual(t0.seats[2].removed, false, 'the broke joiner is not flagged out by this hand');
}

console.log('mid-hand join tests: passed');
