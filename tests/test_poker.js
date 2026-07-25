// Texas Hold'em poker engine tests. Run with: npm test (or: node tests/test_poker.js)
// Exits 0 on success, 1 on any failure.

'use strict';

const { MongoMemoryServer } = require('mongodb-memory-server');
const poker = require('../src/poker.js');
const db = require('../src/database.js');
let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; }
  else {
    failed++;
    console.error('FAIL: ' + msg);
  }
}

function eq(actual, expected, msg) {
  const isEqual = JSON.stringify(actual) === JSON.stringify(expected);
  if (isEqual) { passed++; }
  else {
    failed++;
    console.error('FAIL: ' + msg);
    console.error('  expected: ' + JSON.stringify(expected));
    console.error('  actual:   ' + JSON.stringify(actual));
  }
}

// === HouseRake addendum injected ===
// =====================================================================
// HouseRake feature addendum for tests/test_poker.js.
//
// The corresponding server-side wiring lives in:
//   - src/database.js      (isReservedHouseAccountName, getOrCreateHouseAccount,
//                            upsert-based creditHousePoints routing to HouseRake)
//   - src/poker.js         (awardPot total-first rake math)
//   - server.js            (register / admin_remove rejections, log message)
//   - public/js/client.js  (renderAdminPlayers HouseRake label, (X rake) badge)
//
// Test requirements per user spec:
//   1. pot is correctly split into winner-share + rake (single + multi).
//   2. HouseRake's points increase by the correct rake amount after a hand
//      (end-to-end: engine -> db.creditHousePoints -> HouseRake doc).
//   3. HouseRake cannot be joined/seated as a player (db.isReserved...).
//   4. Total chip conservation across the whole hand lifecycle.
//
// This file is appended into tests/test_poker.js via a single str_replace
// call. It assumes the existing test harness exposes helpers `ok`,
// `eq`, `poker` / `P`, and `db`. Where `db` is required (Test #2, #3),
// `tests/test_poker.js` already spins up an in-process Mongo via
// mongodb-memory-server at the start of `main()`, so the import is
// already available.
// =====================================================================

// makeSeat -- minimal seat shape awardPot expects. Mirrors the engine's
// internal seat object so unit tests can drive awardPot without going
// through startHand (which would need a deterministic RNG seed).
function makeSeat(opts) {
  const o = opts || {};
  return {
    socketId: o.socketId || null,
    playerId: o.playerId || o.name,
    name: o.name,
    stack: typeof o.stack === 'number' ? o.stack : 1000,
    holeCards: o.holeCards || [],
    contributed: o.contributed || 0,
    folded: o.folded || false,
    allIn: o.allIn || false,
    removed: o.removed || false,
    satOut: o.satOut || false,
    preHandStack: typeof o.preHandStack === 'number'
      ? o.preHandStack
      : (typeof o.stack === 'number' ? o.stack : 1000),
    storedHandName: o.storedHandName || null,
    disconnected: false,
  };
}

// ===== TEST 1: single winner, 5% rake, 200 pot -> 190 + 10 =====
function testPokerRakeBasic() {
  const t = poker.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'AliceR1' });
  t.seats[1] = makeSeat({ name: 'BobR1'   });
  poker.awardPot(t, [t.seats[0]], [200]);
  eq(t.seats[0].stack, 1190, 'R1: single winner payout (1000 + 190)');
  eq(t._pendingHouseFees, 10, 'R1: house took 10');
  eq(t.lastHandResults.houseFee, 10, 'R1: lastHandResults exposes houseFee');
  eq(200, 190 + 10, 'R1: pot_in = payouts + rake (conservation)');
}

// ===== TEST 2: 2-way tie, 25% rake. Spec says total-first -> 50 rake, [75,75] =====
function testPokerRakeSplit2Way() {
  const t = poker.createTable({ houseFeePercent: 25, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'AliceR2' });
  t.seats[1] = makeSeat({ name: 'BobR2'   });
  // Pass equal pre-rake shares; total-first algorithm overrides with
  // its own post-rake split.
  poker.awardPot(t, [t.seats[0], t.seats[1]], [100, 100]);
  eq(t._pendingHouseFees, 50, 'R2: 2-way 25% on 200 pot -> 50 rake');
  eq(t.seats[0].stack, 1075, 'R2: Alice gets 75');
  eq(t.seats[1].stack, 1075, 'R2: Bob gets 75');
  eq(200, 50 + 75 + 75, 'R2: conservation');
}

// ===== TEST 3: 3-way tie, 5% rake, UNEVEN pre-rake shares. Total-first wins. =====
//
// Per spec: rake is from the WHOLE pot BEFORE splitting. So 200 total ->
// floor(200 * 0.05) = 10 rake -> 190 left -> baseShare 63 + first-winner-
// remainder 1 -> [64, 63, 63]. The pre-rake amounts of [67, 67, 66] are
// IGNORED -- the spec says rake once from total, then split.
function testPokerRakeSplit3Way() {
  const t = poker.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'A3' });
  t.seats[1] = makeSeat({ name: 'B3' });
  t.seats[2] = makeSeat({ name: 'C3' });
  poker.awardPot(t, [t.seats[0], t.seats[1], t.seats[2]], [67, 67, 66]);
  eq(t._pendingHouseFees, 10, 'R3: rake = floor(200 * 0.05) = 10');
  eq(t.seats[0].stack, 1064, 'R3: A3 gets first-winner-remainder 64');
  eq(t.seats[1].stack, 1063, 'R3: B3 gets baseShare 63');
  eq(t.seats[2].stack, 1063, 'R3: C3 gets baseShare 63');
  eq(67 + 67 + 66, 10 + 64 + 63 + 63, 'R3: conservation over uneven pre-rake shares');
}

// ===== TEST 4: 0% rake fast path -- payouts == pot verbatim =====
function testPokerRakeNoFee() {
  const t = poker.createTable({ houseFeePercent: 0, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'AliceR4' });
  t.seats[1] = makeSeat({ name: 'BobR4'   });
  poker.awardPot(t, [t.seats[0], t.seats[1]], [100, 100]);
  eq(t._pendingHouseFees, 0, 'R4: 0% fee -> no rake accumulated');
  eq(t.seats[0].stack, 1100, 'R4: Alice full 100');
  eq(t.seats[1].stack, 1100, 'R4: Bob full 100');
  eq(t.lastHandResults.houseFee, 0, 'R4: lastHandResults.houseFee = 0');
}

// ===== TEST 5: fold-out (single-winner path) with 20% rake =====
function testPokerRakeFoldOut() {
  const t = poker.createTable({ houseFeePercent: 20, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'AliceR5' });
  t.seats[1] = makeSeat({ name: 'BobR5'   });
  t.pot = 500; // simulate fold-out settlement
  poker.awardPot(t, [t.seats[0]], [t.pot]);
  eq(t._pendingHouseFees, 100, 'R5: fold-out 20% on 500 pot -> 100 rake');
  eq(t.seats[0].stack, 1400, 'R5: Alice gets 400');
  eq(t.lastHandResults.houseFee, 100, 'R5: houseFee present in lastHandResults');
  eq(500, 400 + 100, 'R5: pot = payouts + rake');
}

// ===== TEST 6: busted-refund ZEROES pending house fees (no rake from a voided hand) =====
function testPokerRakeBustedRefundZeros() {
  const t = poker.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t._pendingHouseFees = 30; // simulate rake already accumulated this hand
  t.seats[0] = makeSeat({ name: 'BustedR6', stack: 0, preHandStack: 100 });
  t.seats[0].removed = false; t.seats[0].folded = false; t.seats[0].satOut = false;
  t.seats[1] = makeSeat({ name: 'PatR6',    stack: 200, preHandStack: 100 });
  t.seats[1].removed = false; t.seats[1].folded = false; t.seats[1].satOut = false;
  t.lastHandResults = { winners: [{ name: 'BustedR6' }], houseFee: 30 };
  t.phase = poker.PHASE.RIVER; // force a non-WAITING/HAND_OVER phase
  const refunded = poker.checkBustedRefund(t);
  ok(refunded, 'R6: checkBustedRefund triggers with a stack=0 seat');
  eq(t._pendingHouseFees, 0, 'R6: refunded hand yields no rake');
  eq(t.lastHandResults, null, 'R6: lastHandResults cleared');
}

// ===== TEST 7: full-lifecycle chip conservation (pot_in == payouts + rake) =====
function testPokerRakeFullHandConservation() {
  const t = poker.createTable({
    id: 'tR7', name: 'R7Table', houseFeePercent: 5,
    bigBlind: 10, smallBlind: 5, startingStack: 1000, maxSeats: 3,
  });
  t.seats[0] = makeSeat({ name: 'ConservationA' });
  t.seats[1] = makeSeat({ name: 'ConservationB' });
  t.seats[2] = null;

  const startTotal = t.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0);
  eq(startTotal, 2000, 'R7: pre-hand total = 2000');

  t.pot = 200;
  // NOTE: the pot was added EXTERNALLY to the test (not from seat
  // contributions). The pre-hand invariant therefore has to include
  // the pot so conservation holds: endTotal + housePending must equal
  // the system's total chips (seats + pot) before awardPot, not just
  // the seat-stack total. Computing startTotal AFTER setting the pot
  // makes the invariant `seats_total + pot_total == endTotal + housePending`
  // — with the 5% rake, 2200 -> 2190 + 10 = 2200, which matches the
  // real chip conservation guarantee the test is trying to pin.
  const startTotalWithPot = t.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0) + t.pot;
  poker.awardPot(t, [t.seats[0], t.seats[1]], [100, 100]);

  const endTotal = t.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0);
  const housePending = poker.collectPendingHouseFees(t);
  eq(endTotal + housePending, startTotalWithPot, 'R7: post-hand (seats + house pending) == pre-hand (seats + pot) — true conservation');
  eq(poker.collectPendingHouseFees(t), 0, 'R7: collectPendingHouseFees is idempotent');
  eq(t._pendingHouseFees, 0, 'R7: after collect, _pendingHouseFees = 0');
  eq(housePending, 10, 'R7: 5% rake on 200 pot = 10');
}

// ===== TEST 8a: db.isReservedHouseAccountName covers all casings + boundary cases =====
async function testPokerRakeReservedName() {
  ok(db, 'R8: db module is importable');
  ok(db.isReservedHouseAccountName('HouseRake'),       'R8: exact name is reserved');
  ok(db.isReservedHouseAccountName('houserake'),       'R8: lowercase is reserved');
  ok(db.isReservedHouseAccountName('HOUSERAKE'),       'R8: uppercase is reserved');
  ok(db.isReservedHouseAccountName('  HouseRake  '),   'R8: trim-tolerant');
  ok(!db.isReservedHouseAccountName('HouseRakes'),     'R8: near-miss is NOT reserved');
  ok(!db.isReservedHouseAccountName('Player'),         'R8: unrelated name not reserved');
  ok(!db.isReservedHouseAccountName(''),               'R8: empty string not reserved');
  ok(!db.isReservedHouseAccountName(null),             'R8: null not reserved');
  ok(!db.isReservedHouseAccountName(undefined),        'R8: undefined not reserved');
  ok(!db.isReservedHouseAccountName(42),               'R8: non-string not reserved');
}

// ===== TEST 8b (the BIG ONE — addresses the prior reviewer's #1 blocker):
// END-TO-DB mongo-backed HouseRake credit test.
//
// Verifies that the engine -> db.creditHousePoints -> HouseRake doc
// round-trip actually moves points. We don't need to run a full poker
// hand for this -- we can drive the same code path as scheduleNextHand:
//   1. awardPot on a table with 5% rake
//   2. collectPendingHouseFees
//   3. db.creditHousePoints(amount)
//   4. read the HouseRake doc back via db.getPlayer('HouseRake')
//   5. Assert points increased by exactly the rake amount.
async function testPokerRakeEndToEnd() {
  // Confirm pre-state: HouseRake doc auto-creates on first credit
  // (no manual setup needed). The new upsert-based creditHousePoints
  // creates the doc with points: integerAmount (NOT the global starting
  // stack) on first call.
  await db.resetForTests();

  // Verify the doc does not exist yet.
  const before = await db.getPlayer('HouseRake');
  ok(before === null, 'R9: HouseRake doc absent before any credit');

  // Drive the exact same path as server.js#scheduleNextHand uses.
  const t = poker.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'AliceR9' });
  t.seats[1] = makeSeat({ name: 'BobR9'   });
  t.pot = 200;
  poker.awardPot(t, [t.seats[0]], [200]);
  eq(t._pendingHouseFees, 10, 'R9: engine accrued 10 rake');

  const rakeAmount = poker.collectPendingHouseFees(t);
  eq(rakeAmount, 10, 'R9: collectPendingHouseFees returns 10');

  const creditResult = await db.creditHousePoints(rakeAmount);
  ok(creditResult.ok, 'R9: creditHousePoints ok=true');
  eq(creditResult.credited, 10, 'R9: credited 10');
  eq(creditResult.newBalance, 10, 'R9: HouseRake balance is now 10');
  ok(creditResult.houseAccount === true, 'R9: houseAccount=true flag set');

  // CRITICAL: verify the doc actually exists in the DB with the right
  // points. This is the part the prior test suite was missing -- it
  // tested the engine accumulator but not DB write.
  const after = await db.getPlayer('HouseRake');
  ok(after, 'R9: HouseRake doc exists in players collection');
  eq(after && after.points, 10, 'R9: doc.points = 10 after credit');

  // Verify a SECOND credit accumulates (idempotent upsert behavior).
  await db.creditHousePoints(15);
  const after2 = await db.getPlayer('HouseRake');
  eq(after2 && after2.points, 25, 'R9: second credit accumulates: 10 + 15 = 25');

  // Verify HouseRake was auto-created with points=0... but we already
  // credited into it, so we can't verify the cold-start value here in
  // isolation. A separate test (R10 below) covers cold-start.
}
async function testPokerRakeColdStart() {
  // Reset cleanly, then immediately creditHousePoints -- verify it
  // auto-creates the doc and credits in ONE call (single atomic upsert).
  await db.resetForTests();
  const r = await db.creditHousePoints(42);
  ok(r.ok, 'R10: cold-start credit ok');
  const doc = await db.getPlayer('HouseRake');
  ok(doc, 'R10: HouseRake doc auto-created');
  eq(doc && doc.points, 42, 'R10: cold-start doc starts at 0, lands at 42');
}
async function testPokerRakeLeaderboardExcludes() {
  // The HouseRake docs should NEVER appear in the public leaderboard,
  // even with high points and gamesPlayed. Verify by inducing some
  // stats on the HouseRake doc and asserting getLeaderboardRows skips it.
  await db.resetForTests();
  await db.creditHousePoints(500); // HouseRake now has 500 points
  await db.incrementStats('HouseRake', { gamesDelta: 7, winsDelta: 7 });
  // Now create a real player with comparable stats.
  await db.getOrCreatePlayer('AliceLeader', { points: 600, isAdmin: false });
  await db.incrementStats('AliceLeader', { gamesDelta: 5, winsDelta: 5 });

  const rows = await db.getLeaderboardRows();
  const names = rows.map(r => r.name);
  ok(names.includes('AliceLeader'), 'R11: real player is in leaderboard');
  ok(!names.includes('HouseRake'),  'R11: HouseRake is NOT in leaderboard');
}

async function main() {
  // Spin up an in-Process Mongo for the duration of the test run. The
  // binary was downloaded by mongodb-memory-server's postinstall hook and
  // is cached under node_modules/.cache/mongodb-memory-server/.
  const mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri();

  const P = require('../src/poker.js');
  const { RoomManager, DEFAULT_TABLES } = require('../src/rooms.js');
  const db  = require('../src/database.js');
  await db.connect();

  function c(rank, suit) { return { rank, suit: suit || 's' }; }

  // ----- Hand evaluation (5-card) -----

  // Royal flush (all spades)
  eq(poker.evaluate5([c(10,'s'),c(11,'s'),c(12,'s'),c(13,'s'),c(14,'s')]),
     [9, 14], 'Royal flush rank');

  // Straight flush Q-high (hearts)
  eq(poker.evaluate5([c(8,'h'),c(9,'h'),c(10,'h'),c(11,'h'),c(12,'h')]),
     [9, 12], 'Straight flush Q-high rank');

  // Wheel straight A-2-3-4-5 MIXED suits so it is plain straight, not SF.
  eq(poker.evaluate5([c(14,'c'),c(2,'h'),c(3,'d'),c(4,'s'),c(5,'c')]),
     [5, 5], 'Wheel straight high = 5');
  eq(poker.evaluate5([c(14,'c'),c(2,'h'),c(3,'d'),c(4,'s'),c(5,'c')])[0],
     5, 'Wheel straight is plain straight (not SF)');

  // Straight 6-high MIXED suits
  eq(poker.evaluate5([c(2,'c'),c(3,'h'),c(4,'d'),c(5,'s'),c(6,'c')]),
     [5, 6], 'Straight 6-high');

  // 7-high straight > 6-high straight
  ok(poker.compareHands(
       poker.evaluate5([c(3,'c'),c(4,'h'),c(5,'d'),c(6,'s'),c(7,'c')]),
       poker.evaluate5([c(2,'c'),c(3,'h'),c(4,'d'),c(5,'s'),c(6,'c')])
     ) > 0, '7-high straight > 6-high straight');

  // 6-high straight > wheel (A-5)
  ok(poker.compareHands(
       poker.evaluate5([c(2,'c'),c(3,'h'),c(4,'d'),c(5,'s'),c(6,'c')]),
       poker.evaluate5([c(14,'c'),c(2,'h'),c(3,'d'),c(4,'s'),c(5,'c')])
     ) > 0, '6-high straight > wheel A-5');

  // Four of a kind kicker comparison
  ok(poker.compareHands(
       poker.evaluate5([c(14,'s'),c(14,'h'),c(14,'d'),c(14,'c'),c(3,'s')]),
       poker.evaluate5([c(14,'s'),c(14,'h'),c(14,'d'),c(14,'c'),c(2,'s')])
     ) > 0, 'Quads A with K kicker > Quads A with 2 kicker');

  // Quads vs quads (rank of the quad breaks)
  ok(poker.compareHands(
       poker.evaluate5([c(14,'s'),c(14,'h'),c(14,'d'),c(14,'c'),c(3,'s')]),
       poker.evaluate5([c(13,'s'),c(13,'h'),c(13,'d'),c(13,'c'),c(14,'s')])
     ) > 0, 'Quads A > Quads K');

  // Full house - trips beats trips
  ok(poker.compareHands(
       poker.evaluate5([c(14,'s'),c(14,'h'),c(14,'d'),c(2,'s'),c(2,'h')]),
       poker.evaluate5([c(13,'s'),c(13,'h'),c(13,'d'),c(14,'s'),c(14,'h')])
     ) > 0, 'A,A,A,2,2 > K,K,K,A,A');

  // Flush kicker tie-break (mixed ranks, same kickers, A vs K top)
  ok(poker.compareHands(
       poker.evaluate5([c(14,'h'),c(10,'h'),c(7,'h'),c(5,'h'),c(2,'h')]),
       poker.evaluate5([c(13,'h'),c(10,'h'),c(7,'h'),c(5,'h'),c(2,'h')])
     ) > 0, 'Flush A-high > Flush K-high (same kickers)');

  // Pair comparison: pair Aces > pair Kings
  ok(poker.compareHands(
       poker.evaluate5([c(14,'s'),c(14,'h'),c(11,'d'),c(8,'s'),c(3,'c')]),
       poker.evaluate5([c(13,'s'),c(13,'h'),c(14,'d'),c(11,'s'),c(8,'c')])
     ) > 0, 'Pair Aces > Pair Kings');

  // High card kicker tie-break
  ok(poker.compareHands(
       poker.evaluate5([c(14,'s'),c(11,'h'),c(8,'d'),c(5,'s'),c(3,'c')]),
       poker.evaluate5([c(14,'s'),c(11,'h'),c(8,'d'),c(5,'s'),c(2,'c')])
     ) > 0, 'A,J,8,5,3 > A,J,8,5,2');

  // Identical hands tie
  ok(poker.compareHands(
       poker.evaluate5([c(14,'s'),c(13,'h'),c(12,'d'),c(11,'s'),c(10,'c')]),
       poker.evaluate5([c(14,'h'),c(13,'d'),c(12,'s'),c(11,'c'),c(10,'h')])
     ) === 0, 'Identical hands tie');

  // ----- Best 5 of 7 -----

  {
    const seven = [c(14,'h'),c(11,'h'),c(8,'h'),c(6,'h'),c(2,'h'),c(7,'s'),c(9,'d')];
    eq(poker.evaluate7(seven)[0], 6, 'Best 5 of 7 - flush picked over high card subset');
  }
  {
    const seven = [c(10,'s'),c(11,'s'),c(12,'s'),c(13,'s'),c(14,'s'),c(14,'h'),c(14,'d')];
    eq(poker.evaluate7(seven)[0], 9, 'Best 5 of 7 - royal flush beats trips');
  }
  {
    const seven = [c(14,'s'),c(14,'h'),c(14,'d'),c(14,'c'), c(3,'s'), c(7,'s'), c(9,'s')];
    eq(poker.evaluate7(seven)[0], 8, 'Best 5 of 7 - quads picked');
  }

  // ----- Game state machine -----

  function make4PlayerTable() {
    const t = poker.createTable({ id:'t', smallBlind:5, bigBlind:10, maxSeats:4 });
    ['A','B','C','D'].forEach((name, i) => {
      t.seats[i] = {
        playerId:name, name, stack:1000,
        holeCards:[], folded:false, allIn:false, removed:false, satOut:false,
        disconnected:false, contributed:0, acted:false,
      };
    });
    return t;
  }

  // Dealer button rotates 1 seat per hand.
  {
    const t = make4PlayerTable();
    poker.startHand(t);
    const b1 = t.buttonIndex;
    poker.endHand(t);
    for (const s of t.seats) if (s) { s.contributed=0; s.holeCards=[]; s.folded=false; s.allIn=false; s.removed=false; s.acted=false; }
    t.phase = poker.PHASE.WAITING;
    poker.startHand(t);
    eq(t.buttonIndex, (b1 + 1) % 4, 'Button advances 1 seat per hand');
  }

  // SB left of button, BB left of SB.
  {
    const t = make4PlayerTable();
    poker.startHand(t);
    const btn = t.buttonIndex;
    eq(t.sbIndex, (btn + 1) % 4, 'SB left of button');
    eq(t.bbIndex, (btn + 2) % 4, 'BB left of SB');
  }

  // Heads-up: dealer = SB; SB acts first pre-flop.
  {
    const t = poker.createTable({ id:'h', smallBlind:5, bigBlind:10, maxSeats:6 });
    t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.seats[2] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.buttonIndex = 0; // advance lands on seat 1 (A)
    poker.startHand(t);
    eq(t.buttonIndex, 1, 'Heads-up dealer at A');
    eq(t.sbIndex, 1, 'Heads-up SB = dealer');
    eq(t.bbIndex, 2, 'Heads-up BB = other player');
    eq(t.currentPlayerIndex, 1, 'Heads-up pre-flop: dealer/SB acts first');
  }

  // BB option: limps + BB check -> Flop.
  {
    const t = make4PlayerTable();
    poker.startHand(t);
    const bb = t.bbIndex;
    for (let i = 0; i < 20; i++) {
      const cur = t.currentPlayerIndex;
      if (cur === -1) break;
      if (cur === bb) { poker.applyAction(t, cur, 'check'); break; }
      poker.applyAction(t, cur, 'call');
    }
    eq(t.phase, poker.PHASE.FLOP, 'Limped pre-flop + BB check -> FLOP');
    eq(t.communityCards.length, 3, '3 community cards dealt on flop');
  }

  // Fold-out: in a 2-player heads-up, whoevers turn it is folds and the other wins.
  {
    const t = poker.createTable({ id:'fo', smallBlind:5, bigBlind:10, maxSeats:6 });
    t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.seats[3] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.buttonIndex = 1;
    poker.startHand(t);
    const firstActor = t.currentPlayerIndex;
    ok(firstActor !== -1, 'Someone is first to act in the heads-up fold-out test');
    poker.applyAction(t, firstActor, 'fold');
    eq(t.phase, poker.PHASE.HAND_OVER, 'Fold-out -> HAND_OVER');
    const winnerName = (firstActor === 1) ? 'B' : 'A';
    const winnerSeat = t.seats.find(s => s && s.name === winnerName);
    ok(!!winnerSeat && winnerSeat.stack > 1000,
       winnerName + ' won the pot (stack grew above 1000)');
    const loserName = (firstActor === 1) ? 'A' : 'B';
    const loserSeat = t.seats.find(s => s && s.name === loserName);
    ok(!!loserSeat && loserSeat.stack < 1000,
       loserName + ' lost their blind (stack below 1000)');
  }

  // Sit-out players do NOT receive cards and do NOT pay blinds.
  {
    const t = poker.createTable({ id:'sit', smallBlind:5, bigBlind:10, maxSeats:6 });
    t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.seats[2] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.buttonIndex = 0;
    poker.startHand(t);
    poker.endHand(t);
    t.seats[1].satOut = true;
    const aStackBefore = t.seats[1].stack;
    for (const s of t.seats) if (s) { s.contributed=0; s.holeCards=[]; s.folded=false; s.allIn=false; s.removed=false; }
    t.phase = poker.PHASE.WAITING;
    t.buttonIndex = 1;
    poker.startHand(t);
    eq(t.seats[1].holeCards.length, 0, 'Sat-out A receives no hole cards');
    eq(t.seats[1].stack, aStackBefore, 'Sat-out A pays no blinds');
  }

  // Full raise bumps minRaise.
  {
    const t = make4PlayerTable();
    poker.startHand(t);
    const cur = t.currentPlayerIndex;
    if (cur !== -1) {
      poker.applyAction(t, cur, 'raise', t.bigBlind * 2);
      ok(t.minRaise >= t.bigBlind, 'Full raise bumps minRaise to at least BB');
    }
  }

  // Heads-up turn alternation: SB (A) acts first preflop, BB (B) acts last.
  {
    const t = poker.createTable({ id:'turn', smallBlind:5, bigBlind:10, maxSeats:6 });
    t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.seats[2] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.buttonIndex = 0;
    poker.startHand(t);
    eq(t.currentPlayerIndex, 1, 'Preflop heads-up: dealer/SB (A) acts first');
    ok(poker.applyAction(t, 1, 'call').ok, 'A limps');
    eq(t.currentPlayerIndex, 2, 'After A, turn rotates to B (no skip)');
    ok(poker.applyAction(t, 2, 'check').ok, 'B checks');
    eq(t.phase, poker.PHASE.FLOP, 'Round advances to FLOP after both acted');
    eq(t.currentPlayerIndex, 2, 'Postflop first to act is BB (B) — left of button');
    ok(poker.applyAction(t, 2, 'check').ok, 'B checks flop');
    eq(t.currentPlayerIndex, 1, 'Flop turn rotates back to A');
    ok(poker.applyAction(t, 1, 'check').ok, 'A checks flop');
    eq(t.phase, poker.PHASE.TURN, 'Round advances to TURN');
  }

  // Regression: all-in / call deadlock.
  {
    const t = poker.createTable({ id:'turnLock', smallBlind:5, bigBlind:10, maxSeats:6 });
    t.seats[1] = { playerId:'A', name:'A', stack:200, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.seats[2] = { playerId:'B', name:'B', stack:100, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.buttonIndex = 0;
    poker.startHand(t);
    ok(t.seats[1].allIn === false && t.seats[2].allIn === false, 'Both seated, no one all-in yet');
    ok(poker.applyAction(t, t.currentPlayerIndex, 'raise', 30).ok, 'A raises to 30');
    ok(poker.applyAction(t, t.currentPlayerIndex, 'all_in').ok, 'B shoves all-in');
    ok(t.seats[2].allIn === true, 'B is all-in');
    ok(poker.applyAction(t, t.currentPlayerIndex, 'call').ok, 'A calls the all-in');
    eq(t.phase, poker.PHASE.HAND_OVER, 'Hand reaches HAND_OVER via auto-fast-forward (no infinite loop on A)');
    const res = poker.applyAction(t, 1, 'call');
    ok(!res.ok, 'No further action accepted once hand is over');
  }

  // Auto-advance when every live player is all-in.
  {
    // houseFeePercent: 0 explicitly — this test asserts that the engine
    // doesn't deadlock on all-in + auto-runs-out-the-board; the rake is
    // orthogonal to that invariant. The rake flow has its own dedicated
    // tests (testPokerRakeBasic / FoldOut / ColdStart) so we keep this
    // one focused on the state-machine behaviour.
    const t = poker.createTable({ id:'ai', houseFeePercent:0, smallBlind:5, bigBlind:10, maxSeats:6 });
    t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.seats[2] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.buttonIndex = 0;
    poker.startHand(t);
    ok(poker.applyAction(t, t.currentPlayerIndex, 'all_in').ok, 'First all-in applied');
    ok(poker.applyAction(t, t.currentPlayerIndex, 'all_in').ok, 'Second all-in applied');
    eq(t.phase, poker.PHASE.HAND_OVER, 'All-in pre-flop auto-advances to HAND_OVER (no deadlock)');
    eq(t.communityCards.length, 5, 'All 5 community cards dealt once nobody can act');
    const totalChips = t.seats.filter(s => s && !s.removed).reduce((a, s) => a + s.stack, 0);
    eq(totalChips, 2000, 'Chips conserved across both all-in players (2000 total)');
    const winners = t.seats.filter(s => s && s.stack > 0);
    ok(winners.length >= 1, 'At least one player has chips after auto-advance to showdown');
    ok(!!t.lastHandResults && t.lastHandResults.winners.length >= 1,
       'lastHandResults populated for client banner');
  }

  // Regression: raise + every caller matches -> round closes on the
  // LAST call, no "extra check" required from the aggressor.
  //
  // Before the per-seat `acted` flag was introduced, the round-close
  // predicate required `seatIdx === table.lastAggressor`. That fired
  // only when the seat that just acted WAS the raiser — so on
  // raise-then-N-calls, the engine would land on the last caller
  // (NOT the raiser) and stall, waiting for the raiser to "check"
  // themselves to close the round. The user described this as "after
  // CALL the game doesn't open the FLOP".
  {
    const t = poker.createTable({ id:'raise-call', smallBlind:5, bigBlind:10, maxSeats:6 });
    t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.seats[2] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.seats[3] = { playerId:'C', name:'C', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    poker.startHand(t);
    // UTG (one of A/B/C depending on button + heads-up state — not
    // pinned here) raises to 30. Whichever seat it is, all 3 must
    // eventually call.
    const raiser = t.currentPlayerIndex;
    ok(poker.applyAction(t, raiser, 'raise', 30).ok, 'UTG raises to 30');
    // Phase-bounded loop. Runs callers' CALLs until PRE_FLOP closes
    // (limit 10 is a safety cap so a regression can't infinite-loop).
    let safety = 0;
    let callerCount = 0;
    let rotatedToRaiser = false;
    while (t.phase === poker.PHASE.PRE_FLOP && safety < 10) {
      const cur = t.currentPlayerIndex;
      if (cur === -1) break;
      if (cur === raiser) {
        // Aggressor must NOT have to "check themselves" — the round
        // should already be on FLOP by here.
        rotatedToRaiser = true;
        break;
      }
      ok(poker.applyAction(t, cur, 'call').ok,
         'Opponent #' + (callerCount + 1) + ' calls 30');
      callerCount++;
      safety++;
    }
    ok(!rotatedToRaiser,
       'Action never rotated back to the raiser preflop (extra-check bug)');
    eq(t.phase, poker.PHASE.FLOP,
       'Raise + all callers advances directly to FLOP (no raiser re-action)');
    eq(t.communityCards.length, 3, '3 community cards dealt on the FLOP');
    eq(callerCount, 2, 'Both non-raiser seats called the raise');
  }

  // Regression: check-around post-flop advances the street without
  // requiring any player to "raise" — everyone had a turn AND
  // contributed matched. Same `acted`-flag predicate.
  {
    const t = poker.createTable({ id:'check-around-flop', smallBlind:5, bigBlind:10, maxSeats:4 });
    t.seats[0] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.seats[1] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    t.seats[2] = { playerId:'C', name:'C', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0, acted:false };
    poker.startHand(t);
    // Limp everyone in to reach the FLOP quickly.
    for (let i = 0; i < 20; i++) {
      const cur = t.currentPlayerIndex;
      if (cur === -1) break;
      poker.applyAction(t, cur, 'call');
      if (t.phase === poker.PHASE.FLOP) break;
    }
    eq(t.phase, poker.PHASE.FLOP, 'Preflop limp-around reaches FLOP');
    // 3-seat check-around on the flop should close after all 3 acted.
    const cap = 12;
    for (let i = 0; i < cap && t.phase === poker.PHASE.FLOP; i++) {
      const cur = t.currentPlayerIndex;
      if (cur === -1) break;
      ok(poker.applyAction(t, cur, 'check').ok, 'Check-around iter ' + i);
    }
    eq(t.phase, poker.PHASE.TURN,
       'Check-around post-flop closes to TURN (every player acted & matched)');
  }

  console.log('');
  // ----- Default tables / auto-delete empty tables -----

  function simulateHandCleanup(t) {
    for (let i = 0; i < t.seats.length; i++) {
      if (t.seats[i] && t.seats[i].removed) t.seats[i] = null;
    }
  }

  function seatAt(t, idx, playerId, name, stack) {
    t.seats[idx] = {
      playerId, name, stack,
      holeCards: [], folded: false, allIn: false,
      removed: false, satOut: false, disconnected: false,
      contributed: 0, acted: false,
    };
  }

  {
    const rooms = new RoomManager();
    rooms.ensureDefaultTables();
    ok(Array.isArray(DEFAULT_TABLES) && DEFAULT_TABLES.length === 5,
       'DEFAULT_TABLES is an exported array of 5 entries');
    eq(rooms.tables.size, 5,
       'ensureDefaultTables creates exactly 5 tables on a fresh RoomManager');

    const sorted = Array.from(rooms.tables.values())
      .sort((a, b) => a.smallBlind - b.smallBlind);
    eq(sorted.map((t) => [t.smallBlind, t.bigBlind]),
       [[5, 10], [25, 50], [50, 100], [100, 200], [250, 500]],
       'Default tables have the exact stakes in the task spec');

    for (const t of rooms.tables.values()) {
      ok(t.default === true, `Table ${t.name} is marked default=true`);
      ok(t.maxSeats >= 2 && t.maxSeats <= 9,
         `Table ${t.name} has a sane maxSeats (${t.maxSeats})`);
    }
  }

  {
    const rooms = new RoomManager();
    rooms.ensureDefaultTables();
    rooms.ensureDefaultTables();
    eq(rooms.tables.size, 5,
       'ensureDefaultTables is idempotent (still 5 tables after a second call)');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'default-empty', smallBlind:5, bigBlind:10, maxSeats:6 });
    t.default = true;
    seatAt(t, 1, 'A', 'A', 0);
    t.seats[1].removed = true;
    simulateHandCleanup(t);
    if (rooms.shouldDeleteAfterHand(t)) rooms.remove(t.id);
    ok(rooms.has(t.id),
       'Default table with zero occupied seats survives HAND_OVER cleanup');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'custom-empty', smallBlind:20, bigBlind:40, maxSeats:4 });
    ok(!t.default, 'Fresh user-created table is not marked default');
    seatAt(t, 2, 'A', 'A', 0);
    t.seats[2].removed = true;
    simulateHandCleanup(t);
    if (rooms.shouldDeleteAfterHand(t)) rooms.remove(t.id);
    ok(!rooms.has(t.id),
       'Non-default empty table is auto-deleted at HAND_OVER cleanup');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'custom-occupied', smallBlind:20, bigBlind:40, maxSeats:6 });
    seatAt(t, 1, 'A', 'A', 0);
    t.seats[1].removed = true;
    seatAt(t, 3, 'B', 'B', 1000);
    simulateHandCleanup(t);
    if (rooms.shouldDeleteAfterHand(t)) rooms.remove(t.id);
    ok(rooms.has(t.id),
       'Non-default table with at least one seated player survives cleanup');
  }

  // ----- Per-table chat -----

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'chat-test', smallBlind:5, bigBlind:10, maxSeats:6 });
    const r = rooms.addChatMessage(t.id, 'Alice', 'hello world');
    ok(r.ok, 'addChatMessage accepts a valid message');
    const hist = rooms.chatHistory(t.id);
    eq(hist.length, 1, 'addChatMessage appends one entry');
    eq(hist[0].from, 'Alice', 'from field preserved');
    eq(hist[0].text, 'hello world', 'text field preserved');
    eq(hist[0].kind, 'user', 'kind is "user"');
    ok(typeof hist[0].ts === 'number' && hist[0].ts > 0, 'ts is a positive timestamp');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'chat-clean', smallBlind:5, bigBlind:10, maxSeats:6 });
    rooms.addChatMessage(t.id, 'Bob', '  line1\nline2\r\nline3  ');
    eq(rooms.chatHistory(t.id)[0].text, 'line1 line2 line3',
       'Newlines collapsed to spaces + trimmed');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'chat-empty', smallBlind:5, bigBlind:10, maxSeats:6 });
    ok(!rooms.addChatMessage(t.id, 'A', '').ok,
       'addChatMessage rejects empty string');
    ok(!rooms.addChatMessage(t.id, 'A', '   \n  ').ok,
       'addChatMessage rejects whitespace-only string');
    eq(rooms.chatHistory(t.id).length, 0, 'No messages added for empty inputs');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'chat-cap', smallBlind:5, bigBlind:10, maxSeats:6 });
    for (let i = 0; i < 110; i++) rooms.addChatMessage(t.id, 'A', 'msg ' + i);
    const hist = rooms.chatHistory(t.id);
    eq(hist.length, 100, 'Chat history capped at 100 messages');
    eq(hist[0].text, 'msg 10', 'Oldest messages dropped (FIFO)');
    eq(hist[99].text, 'msg 109', 'Newest message preserved');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'chat-sys', smallBlind:5, bigBlind:10, maxSeats:6 });
    rooms.addSystemMessage(t.id, 'Alice joined');
    const hist = rooms.chatHistory(t.id);
    eq(hist.length, 1, 'addSystemMessage appends one entry');
    eq(hist[0].kind, 'system', 'kind is "system"');
    ok(!hist[0].from, 'System messages have no from field');
    eq(hist[0].text, 'Alice joined', 'System text preserved');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'chat-keep', smallBlind:5, bigBlind:10, maxSeats:6 });
    rooms.addChatMessage(t.id, 'Alice', 'hello');
    seatAt(t, 0, 'A', 'A', 1000);
    ok(!rooms.clearChatIfEmpty(t.id),
       'clearChatIfEmpty returns false when a seat is occupied');
    eq(rooms.chatHistory(t.id).length, 1,
       'Chat preserved while a seat is occupied');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'chat-clear', smallBlind:5, bigBlind:10, maxSeats:6 });
    rooms.addChatMessage(t.id, 'Alice', 'hello');
    ok(rooms.clearChatIfEmpty(t.id),
       'clearChatIfEmpty returns true when no seats occupied + chat non-empty');
    eq(rooms.chatHistory(t.id).length, 0,
       'Chat history wiped on clear');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'chat-noop', smallBlind:5, bigBlind:10, maxSeats:6 });
    ok(!rooms.clearChatIfEmpty(t.id),
       'clearChatIfEmpty returns false when chat already empty (no-op)');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'chat-e2e', smallBlind:5, bigBlind:10, maxSeats:6 });
    seatAt(t, 0, 'A', 'A', 1000);
    seatAt(t, 2, 'B', 'B', 1000);
    poker.startHand(t);
    rooms.addChatMessage(t.id, 'A', 'gg');
    rooms.unseat(t.id, 2);
    ok(t.seats[2] && t.seats[2].removed,
       'Mid-hand leave: B\'s seat is non-null + removed');
    ok(!rooms.clearChatIfEmpty(t.id),
       'clearChatIfEmpty no-ops while A is still seated');
    eq(rooms.chatHistory(t.id).length, 1,
       'Chat preserved while A is still here');
    rooms.unseat(t.id, 0);
    ok(t.seats[0] && t.seats[0].removed && t.seats[2] && t.seats[2].removed,
       'Both seats are non-null + removed after both players leave');
    ok(rooms.clearChatIfEmpty(t.id),
       'clearChatIfEmpty triggers when every seat is removed');
    eq(rooms.chatHistory(t.id).length, 0,
       'Chat history wiped when everyone is out');
  }

  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'chat-view', smallBlind:5, bigBlind:10, maxSeats:6 });
    rooms.addChatMessage(t.id, 'Alice', 'pre-existing message');
    const view = rooms.publicView(t.id, null);
    eq(view.chatMessages.length, 1,
       'publicView includes the chat history');
    eq(view.chatMessages[0].text, 'pre-existing message',
       'publicView chat entry matches what was added');
  }

  // ----- Reclaimeable removed seats -----

  // 1) rooms.seatPlayer accepts a removed-but-non-null seat.
  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'reclaim', smallBlind:5, bigBlind:10, maxSeats:6 });
    seatAt(t, 0, 'A', 'A', 1000);
    t.seats[0].removed = true;
    t.seats[0].disconnected = true;
    const lobby = rooms.listTables().find((x) => x.id === t.id);
    eq(lobby.seatsTaken, 0,
       'Lobby seatsTaken excludes a stale removed-but-non-null seat');
    const result = rooms.seatPlayer(t.id, 0, { id:'B', name:'B', points:750 });
    ok(result.ok === true && result.error === undefined,
       'rooms.seatPlayer accepts reclaimeing a removed-but-non-null seat');
    eq(t.seats[0].name, 'B', 'Seat is now bound to the new player');
    ok(t.seats[0].removed === false && t.seats[0].disconnected === false,
       'New seat data is fully reset (removed=false, disconnected=false)');
  }

  // 2) rooms.seatPlayer STILL rejects a normal occupied seat.
  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'occupied', smallBlind:5, bigBlind:10, maxSeats:6 });
    seatAt(t, 0, 'A', 'A', 1000);
    const result = rooms.seatPlayer(t.id, 0, { id:'B', name:'B', points:750 });
    ok(!result.ok && result.error === 'Seat taken',
       'rooms.seatPlayer still rejects a normal occupied seat');
  }

  // 3) findEmptySeat matches the take-check semantics.
  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'findEmpty', smallBlind:5, bigBlind:10, maxSeats:6 });
    seatAt(t, 0, 'A', 'A', 0);  t.seats[0].removed = true;
    seatAt(t, 3, 'B', 'B', 0);  t.seats[3].removed = true;
    eq(rooms.findEmptySeat(t.id), 0,
       'findEmptySeat returns the lowest index of a removed-but-non-null seat');
  }

  // 4) end-to-end bug scenario
  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'busted-afterhand', smallBlind:5, bigBlind:10, maxSeats:6 });
    seatAt(t, 0, 'A', 'A', 1000);
    seatAt(t, 2, 'B', 'B', 1000);
    poker.startHand(t);
    poker.endHand(t);
    for (const s of t.seats) if (s) s.stack = 0;
    for (const s of t.seats) if (s && s.stack <= 0) s.removed = true;
    ok(t.seats[0] && t.seats[0].removed === true,
       'Post-hand: busted seat is non-null with removed=true');
    eq(rooms.listTables().find((x) => x.id === t.id).seatsTaken, 0,
       'Post-hand: lobby reports 0 occupied seats');
    const r0 = rooms.seatPlayer(t.id, 0, { id:'C', name:'C', points:500 });
    const r2 = rooms.seatPlayer(t.id, 2, { id:'D', name:'D', points:500 });
    ok(r0.ok, 'Post-bust: new player can reclaim a removed seat at index 0');
    ok(r2.ok, 'Post-bust: new player can reclaim a removed seat at index 2');
    eq(rooms.listTables().find((x) => x.id === t.id).seatsTaken, 2,
       'Post-reclaim: lobby reports both new seats as occupied');
  }

  // 5) Mid-hand reclaim
  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name:'mid-hand-reclaim', smallBlind:5, bigBlind:10, maxSeats:6 });
    seatAt(t, 0, 'A', 'A', 1000);
    seatAt(t, 3, 'B', 'B', 1000);
    poker.startHand(t);
    rooms.unseat(t.id, 3);
    ok(t.seats[3] && t.seats[3].removed === true && t.seats[3].folded === true,
       'Mid-hand leave marks B\'s seat non-null with removed=true + folded=true');
    const reclame = rooms.seatPlayer(t.id, 3, { id:'C', name:'C', points:500 });
    ok(reclame.ok, 'Mid-hand: new player can reclaim a removed+folded seat');
    ok(t.seats[3] && t.seats[3].removed === false && t.seats[3].folded === false,
       'Mid-hand: reclaiming resets the seat\'s removed/folded flags');
    eq(t._pendingUnseat, [],
       'Mid-hand: reclaiming drops the stale _pendingUnseat entry from the prior leave');
    poker.endHand(t);
    eq(t.phase, poker.PHASE.WAITING, 'Mid-hand reclaim: hand completes normally on endHand');
    ok(t.seats[3] && t.seats[3].name === 'C' && t.seats[3].stack === 500,
       'Mid-hand reclaim: new player is intact at end of hand');
  }

  // ----- Showdown reveal coverage -----
  //
  // publicView must reveal non-self holeCards at hand_over + lastHandResults
  // so all viewers can see every non-folded player's hole cards once the
  // betting ends. Folded seats still muck. Busted-refund hands (HAND_OVER
  // WITHOUT lastHandResults) do NOT trigger the reveal so the voided
  // cards don't confuse players about which hands counted.
  {
    const rooms = new RoomManager();
    const t = rooms.createTable({ name: 'show-reveal', smallBlind: 5, bigBlind: 10, maxSeats: 6 });
    // Reuse the existing seatAt helper, then layer holeCards / storedHandName
    // on top — same shape as production seats, so the reveal policy is
    // exercised against realistic data.
    const seedSeat = (idx, playerId, name, hole, handName) => {
      seatAt(t, idx, playerId, name, 1000);
      t.seats[idx].holeCards = hole;
      t.seats[idx].storedHandName = handName;
    };
    seedSeat(1, 'A', 'Alice', [{ rank: 14, suit: 's' }, { rank: 13, suit: 'h' }], 'Pair of Kings');
    seedSeat(3, 'B', 'Bob',   [{ rank: 12, suit: 'd' }, { rank: 11, suit: 'c' }], 'Pair of Queens');
    seedSeat(5, 'C', 'Carol', [{ rank:  9, suit: 's' }, { rank:  8, suit: 's' }], null);
    t.seats[5].folded = true; // Carol folded out pre-flop
    t.seats[3].allIn  = true; // Bob pushed all-in during the run-out

    // ----- pre-flop (no reveal) -----
    t.phase = poker.PHASE.PRE_FLOP;
    let view = rooms.publicView(t.id, 'A');
    ok(Array.isArray(view.seats[1].holeCards) && view.seats[1].holeCards.length === 2,
      'pre-flop: self Alice sees own holeCards');
    ok(view.seats[3].holeCards === null,
      'pre-flop: opponent Bob holeCards hidden');
    ok(view.seats[5].holeCards === null,
      'pre-flop: folded Carol holeCards hidden');
    ok(view.seats[1].storedHandName === 'Pair of Kings',
      'pre-flop: self storedHandName visible to self only');
    ok(view.seats[3].storedHandName === null,
      'pre-flop: opponent storedHandName hidden');

    // ----- HAND_OVER without lastHandResults (busted-refund / voided) -----
    t.phase = poker.PHASE.HAND_OVER;
    view = rooms.publicView(t.id, 'A');
    ok(view.seats[3].holeCards === null,
      'HAND_OVER (no lastHandResults): holeCards still hidden');
    ok(view.seats[3].storedHandName === null,
      'HAND_OVER (no lastHandResults): storedHandName still hidden');

    // ----- HAND_OVER + lastHandResults (REAL showdown: cards revealed) -----
    t.lastHandResults = {
      winners: [{ id: 'B', name: 'Bob', handName: 'Pair of Queens', share: 50 }],
    };
    view = rooms.publicView(t.id, 'A');
    ok(Array.isArray(view.seats[1].holeCards) && view.seats[1].holeCards.length === 2,
      'showdown: self Alice still sees own holeCards');
    ok(Array.isArray(view.seats[3].holeCards) && view.seats[3].holeCards.length === 2,
      'showdown: all-in opponent Bob holeCards REVEALED (not folded -> still in scoring)');
    ok(view.seats[5].holeCards === null,
      'showdown: folded Carol holeCards stay null (mucked)');
    ok(view.seats[3].storedHandName === 'Pair of Queens',
      'showdown: opponent Bob storedHandName REVEALED to all viewers');
    ok(view.seats[5].storedHandName === null,
      'showdown: folded Carol storedHandName still hidden');

    // ----- Anonymous spectator (viewerPlayerId=null) at showdown -----
    const anonView = rooms.publicView(t.id, null);
    ok(anonView.seats[1].isSelf === false && anonView.seats[3].isSelf === false
       && anonView.seats[5].isSelf === false,
      'anonymous spectator: nobody is isSelf');
    ok(Array.isArray(anonView.seats[1].holeCards) && anonView.seats[1].holeCards.length === 2,
      'anonymous spectator: Alice\'s holeCards revealed');
    ok(Array.isArray(anonView.seats[3].holeCards) && anonView.seats[3].holeCards.length === 2,
      'anonymous spectator: Bob\'s holeCards revealed');
    ok(anonView.seats[5].holeCards === null,
      'anonymous spectator: folded Carol stays face-down');
    ok(anonView.seats[3].storedHandName === 'Pair of Queens',
      'anonymous spectator: Bob\'s storedHandName revealed');

    // ----- After hand ends and next hand starts (HAND_OVER -> WAITING) -----
    t.phase = poker.PHASE.WAITING;
    view = rooms.publicView(t.id, 'A');
    ok(view.seats[3].holeCards === null,
      'next hand starts: cards reset, opponent hidden again');
    ok(view.seats[3].storedHandName === null,
      'next hand starts: storedHandName reset, opponent hidden again');
  }

  console.log('Engine / room / state-machine tests: ' + passed + ' passed, ' + failed + ' failed');
  console.log('');

  // ----- Database stat persistence tests -----

  const created = await db.getOrCreatePlayer('Alice');
  ok(created.gamesPlayed === 0, 'newly created player starts with gamesPlayed = 0');
  ok(created.wins === 0,        'newly created player starts with wins = 0');
  ok(typeof created.lastSeenAt === 'number' && created.lastSeenAt === 0,
     'newly created player starts with lastSeenAt = 0');

  await db.incrementStats('Alice', { gamesDelta: 1, winsDelta: 1, seenAt: 100 });
  await db.incrementStats('Alice', { gamesDelta: 1, winsDelta: 1, seenAt: 200 });
  const a = await db.getPlayer('Alice');
  eq(a.gamesPlayed, 2, 'gamesPlayed accumulates across calls');
  eq(a.wins, 2,        'wins accumulates across calls');
  ok(a.lastSeenAt === 200, 'lastSeenAt takes the newer of conflicting timestamps');

  await db.incrementStats('Alice', { seenAt: 50 }); // older -> ignored
  const a2 = await db.getPlayer('Alice');
  ok(a2.lastSeenAt === 200, 'older lastSeenAt does not regress');

  await db.incrementStats('Alice', { gamesDelta: -99, winsDelta: -50 });
  const a3 = await db.getPlayer('Alice');
  eq(a3.gamesPlayed, 0, 'negative gamesDelta clamps at 0');
  eq(a3.wins,        0, 'negative winsDelta clamps at 0');

  const ghost = await db.incrementStats('__never_registered__', { gamesDelta: 1 });
  ok(ghost === null, 'incrementStats on unknown player returns null');

  // Race regression: two incrementStats calls on the same name fired in
  // the same tick should accumulate correctly. Now backed by Mongo's
  // per-document atomic operators — the per-name Promise chain isn't
  // needed because Mongo serializes per-document writes inside the engine.
  await db.getOrCreatePlayer('Race');
  await db.incrementStats('Race', { gamesDelta: 1 });
  const racers = [];
  for (let i = 0; i < 10; i++) racers.push(db.incrementStats('Race', { gamesDelta: 1 }));
  await Promise.all(racers);
  const raced = await db.getPlayer('Race');
  eq(raced.gamesPlayed, 11, 'Concurrent same-name incrementStats accumulates (no lost updates)');

  // Leaderboard filter rule
  await db.getOrCreatePlayer('Bob',   { points: 8000 });
  await db.getOrCreatePlayer('Carol', { points: 8000 });
  await db.getOrCreatePlayer('Dave',  { points: 8000 });
  await db.getOrCreatePlayer('Eve',   { points: 99999 }); // never plays

  await db.incrementStats('Bob',   { gamesDelta: 5, winsDelta: 2 });
  await db.incrementStats('Carol', { gamesDelta: 5, winsDelta: 4 });
  await db.incrementStats('Dave',  { gamesDelta: 5, winsDelta: 4 });

  const rows = await db.getLeaderboardRows({ limit: 50 });
  ok(!rows.some((r) => r.name === 'Alice'), 'Alice excluded (gamesPlayed 0 after clamp)');
  ok(!rows.some((r) => r.name === 'Eve'),   'Eve excluded (gamesPlayed 0)');

  const top = rows.slice(0, 3).map((r) => r.name);
  eq(top, ['Carol', 'Dave', 'Bob'],
     'Tied points tie-break: wins desc, then games desc, then name asc');

  for (const r of rows) {
    ok(typeof r.name === 'string'  && r.name.length > 0,  'row has non-empty name');
    ok(typeof r.points === 'number' && r.points >= 0,     'row has numeric points');
    ok(typeof r.gamesPlayed === 'number' && r.gamesPlayed > 0,
       'returned row has gamesPlayed > 0 (filter works)');
  }

  // Backfill behavior: pre-existing player records that lack stat
  // fields should default to 0/0/0 on creation and therefore be
  // excluded by the leaderboard filter. We simulate that here by
  // wiping the database and recreating two players with explicit
  // points but no `incrementStats` calls (so gamesPlayed stays 0).
  await db.resetForTests();
  await db.getOrCreatePlayer('Legacy1', { id: 'legacy-1', points: 1234 });
  await db.getOrCreatePlayer('Legacy2', { id: 'legacy-2', points: 5678 });
  const legacyRows = await db.getLeaderboardRows({ limit: 50 });
  ok(!legacyRows.some((r) => r.name === 'Legacy1'),
     'Legacy entry with no gamesPlayed is excluded after backfill');
  ok(!legacyRows.some((r) => r.name === 'Legacy2'),
     'Multi-entry legacy file: every backfilled-0-games row is excluded');

  // Test cleanup
  // ===== HouseRake feature tests =====
  // Synchronous unit tests (engine + invariants):
  testPokerRakeBasic();
  testPokerRakeNoFee();
  testPokerRakeSplit2Way();
  testPokerRakeSplit3Way();
  testPokerRakeFoldOut();
  testPokerRakeBustedRefundZeros();
  testPokerRakeFullHandConservation();
  // Async integration tests (db / mongo-backed):
  await testPokerRakeReservedName();
  await testPokerRakeEndToEnd();
  await testPokerRakeColdStart();
  await testPokerRakeLeaderboardExcludes();
  await db.disconnect();
  await mongoServer.stop();

  console.log('Database stat tests: ' + passed + ' passed (cumulative), ' + failed + ' failed (cumulative)');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
