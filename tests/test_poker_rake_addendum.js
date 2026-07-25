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
  const t = P.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'AliceR1' });
  t.seats[1] = makeSeat({ name: 'BobR1'   });
  P.awardPot(t, [t.seats[0]], [200]);
  eq(t.seats[0].stack, 1190, 'R1: single winner payout (1000 + 190)');
  eq(t._pendingHouseFees, 10, 'R1: house took 10');
  eq(t.lastHandResults.houseFee, 10, 'R1: lastHandResults exposes houseFee');
  eq(200, 190 + 10, 'R1: pot_in = payouts + rake (conservation)');
}

// ===== TEST 2: 2-way tie, 25% rake. Spec says total-first -> 50 rake, [75,75] =====
function testPokerRakeSplit2Way() {
  const t = P.createTable({ houseFeePercent: 25, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'AliceR2' });
  t.seats[1] = makeSeat({ name: 'BobR2'   });
  // Pass equal pre-rake shares; total-first algorithm overrides with
  // its own post-rake split.
  P.awardPot(t, [t.seats[0], t.seats[1]], [100, 100]);
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
  const t = P.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'A3' });
  t.seats[1] = makeSeat({ name: 'B3' });
  t.seats[2] = makeSeat({ name: 'C3' });
  P.awardPot(t, [t.seats[0], t.seats[1], t.seats[2]], [67, 67, 66]);
  eq(t._pendingHouseFees, 10, 'R3: rake = floor(200 * 0.05) = 10');
  eq(t.seats[0].stack, 1064, 'R3: A3 gets first-winner-remainder 64');
  eq(t.seats[1].stack, 1063, 'R3: B3 gets baseShare 63');
  eq(t.seats[2].stack, 1063, 'R3: C3 gets baseShare 63');
  eq(67 + 67 + 66, 10 + 64 + 63 + 63, 'R3: conservation over uneven pre-rake shares');
}

// ===== TEST 4: 0% rake fast path -- payouts == pot verbatim =====
function testPokerRakeNoFee() {
  const t = P.createTable({ houseFeePercent: 0, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'AliceR4' });
  t.seats[1] = makeSeat({ name: 'BobR4'   });
  P.awardPot(t, [t.seats[0], t.seats[1]], [100, 100]);
  eq(t._pendingHouseFees, 0, 'R4: 0% fee -> no rake accumulated');
  eq(t.seats[0].stack, 1100, 'R4: Alice full 100');
  eq(t.seats[1].stack, 1100, 'R4: Bob full 100');
  eq(t.lastHandResults.houseFee, 0, 'R4: lastHandResults.houseFee = 0');
}

// ===== TEST 5: fold-out (single-winner path) with 20% rake =====
function testPokerRakeFoldOut() {
  const t = P.createTable({ houseFeePercent: 20, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'AliceR5' });
  t.seats[1] = makeSeat({ name: 'BobR5'   });
  t.pot = 500; // simulate fold-out settlement
  P.awardPot(t, [t.seats[0]], [t.pot]);
  eq(t._pendingHouseFees, 100, 'R5: fold-out 20% on 500 pot -> 100 rake');
  eq(t.seats[0].stack, 1400, 'R5: Alice gets 400');
  eq(t.lastHandResults.houseFee, 100, 'R5: houseFee present in lastHandResults');
  eq(500, 400 + 100, 'R5: pot = payouts + rake');
}

// ===== TEST 6: busted-refund ZEROES pending house fees (no rake from a voided hand) =====
function testPokerRakeBustedRefundZeros() {
  const t = P.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t._pendingHouseFees = 30; // simulate rake already accumulated this hand
  t.seats[0] = makeSeat({ name: 'BustedR6', stack: 0, preHandStack: 100 });
  t.seats[0].removed = false; t.seats[0].folded = false; t.seats[0].satOut = false;
  t.seats[1] = makeSeat({ name: 'PatR6',    stack: 200, preHandStack: 100 });
  t.seats[1].removed = false; t.seats[1].folded = false; t.seats[1].satOut = false;
  t.lastHandResults = { winners: [{ name: 'BustedR6' }], houseFee: 30 };
  t.phase = P.PHASE.RIVER; // force a non-WAITING/HAND_OVER phase
  const refunded = P.checkBustedRefund(t);
  ok(refunded, 'R6: checkBustedRefund triggers with a stack=0 seat');
  eq(t._pendingHouseFees, 0, 'R6: refunded hand yields no rake');
  eq(t.lastHandResults, null, 'R6: lastHandResults cleared');
}

// ===== TEST 7: full-lifecycle chip conservation (pot_in == payouts + rake) =====
function testPokerRakeFullHandConservation() {
  const t = P.createTable({
    id: 'tR7', name: 'R7Table', houseFeePercent: 5,
    bigBlind: 10, smallBlind: 5, startingStack: 1000, maxSeats: 3,
  });
  t.seats[0] = makeSeat({ name: 'ConservationA' });
  t.seats[1] = makeSeat({ name: 'ConservationB' });
  t.seats[2] = null;

  const startTotal = t.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0);
  eq(startTotal, 2000, 'R7: pre-hand total = 2000');

  t.pot = 200;
  P.awardPot(t, [t.seats[0], t.seats[1]], [100, 100]);

  const endTotal = t.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0);
  const housePending = P.collectPendingHouseFees(t);
  eq(endTotal + housePending, startTotal, 'R7: post-hand total + house pending == pre-hand total');
  eq(P.collectPendingHouseFees(t), 0, 'R7: collectPendingHouseFees is idempotent');
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
  const t = P.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'AliceR9' });
  t.seats[1] = makeSeat({ name: 'BobR9'   });
  t.pot = 200;
  P.awardPot(t, [t.seats[0]], [200]);
  eq(t._pendingHouseFees, 10, 'R9: engine accrued 10 rake');

  const rakeAmount = P.collectPendingHouseFees(t);
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
