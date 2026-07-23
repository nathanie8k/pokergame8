// Texas Hold'em poker engine tests. Run with: node tests/test_poker.js
// Exits 0 on success, 1 on any failure.

'use strict';

const P = require('../src/poker.js');
const { RoomManager, DEFAULT_TABLES } = require('../src/rooms.js');

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

function c(rank, suit) { return { rank, suit: suit || 's' }; }

// ----- Hand evaluation (5-card) -----

// Royal flush (all spades)
eq(P.evaluate5([c(10,'s'),c(11,'s'),c(12,'s'),c(13,'s'),c(14,'s')]),
   [9, 14], 'Royal flush rank');

// Straight flush Q-high (hearts)
eq(P.evaluate5([c(8,'h'),c(9,'h'),c(10,'h'),c(11,'h'),c(12,'h')]),
   [9, 12], 'Straight flush Q-high rank');

// Wheel straight A-2-3-4-5 MIXED suits so it is plain straight, not SF.
eq(P.evaluate5([c(14,'c'),c(2,'h'),c(3,'d'),c(4,'s'),c(5,'c')]),
   [5, 5], 'Wheel straight high = 5');

eq(P.evaluate5([c(14,'c'),c(2,'h'),c(3,'d'),c(4,'s'),c(5,'c')])[0],
   5, 'Wheel straight is plain straight (not SF)');

// Straight 6-high MIXED suits
eq(P.evaluate5([c(2,'c'),c(3,'h'),c(4,'d'),c(5,'s'),c(6,'c')]),
   [5, 6], 'Straight 6-high');

// 7-high straight > 6-high straight
ok(P.compareHands(
     P.evaluate5([c(3,'c'),c(4,'h'),c(5,'d'),c(6,'s'),c(7,'c')]),
     P.evaluate5([c(2,'c'),c(3,'h'),c(4,'d'),c(5,'s'),c(6,'c')])
   ) > 0, '7-high straight > 6-high straight');

// 6-high straight > wheel (A-5)
ok(P.compareHands(
     P.evaluate5([c(2,'c'),c(3,'h'),c(4,'d'),c(5,'s'),c(6,'c')]),
     P.evaluate5([c(14,'c'),c(2,'h'),c(3,'d'),c(4,'s'),c(5,'c')])
   ) > 0, '6-high straight > wheel A-5');

// Four of a kind kicker comparison
ok(P.compareHands(
     P.evaluate5([c(14,'s'),c(14,'h'),c(14,'d'),c(14,'c'),c(3,'s')]),
     P.evaluate5([c(14,'s'),c(14,'h'),c(14,'d'),c(14,'c'),c(2,'s')])
   ) > 0, 'Quads A with K kicker > Quads A with 2 kicker');

// Quads vs quads (rank of the quad breaks)
ok(P.compareHands(
     P.evaluate5([c(14,'s'),c(14,'h'),c(14,'d'),c(14,'c'),c(3,'s')]),
     P.evaluate5([c(13,'s'),c(13,'h'),c(13,'d'),c(13,'c'),c(14,'s')])
   ) > 0, 'Quads A > Quads K');

// Full house - trips beats trips
ok(P.compareHands(
     P.evaluate5([c(14,'s'),c(14,'h'),c(14,'d'),c(2,'s'),c(2,'h')]),
     P.evaluate5([c(13,'s'),c(13,'h'),c(13,'d'),c(14,'s'),c(14,'h')])
   ) > 0, 'A,A,A,2,2 > K,K,K,A,A');

// Flush kicker tie-break (mixed ranks, same kickers, A vs K top)
ok(P.compareHands(
     P.evaluate5([c(14,'h'),c(10,'h'),c(7,'h'),c(5,'h'),c(2,'h')]),
     P.evaluate5([c(13,'h'),c(10,'h'),c(7,'h'),c(5,'h'),c(2,'h')])
   ) > 0, 'Flush A-high > Flush K-high (same kickers)');

// Pair comparison: pair Aces > pair Kings
ok(P.compareHands(
     P.evaluate5([c(14,'s'),c(14,'h'),c(11,'d'),c(8,'s'),c(3,'c')]),
     P.evaluate5([c(13,'s'),c(13,'h'),c(14,'d'),c(11,'s'),c(8,'c')])
   ) > 0, 'Pair Aces > Pair Kings');

// High card kicker tie-break
ok(P.compareHands(
     P.evaluate5([c(14,'s'),c(11,'h'),c(8,'d'),c(5,'s'),c(3,'c')]),
     P.evaluate5([c(14,'s'),c(11,'h'),c(8,'d'),c(5,'s'),c(2,'c')])
   ) > 0, 'A,J,8,5,3 > A,J,8,5,2');

// Identical hands tie
ok(P.compareHands(
     P.evaluate5([c(14,'s'),c(13,'h'),c(12,'d'),c(11,'s'),c(10,'c')]),
     P.evaluate5([c(14,'h'),c(13,'d'),c(12,'s'),c(11,'c'),c(10,'h')])
   ) === 0, 'Identical hands tie');

// ----- Best 5 of 7 -----

{
  const seven = [c(14,'h'),c(11,'h'),c(8,'h'),c(6,'h'),c(2,'h'),c(7,'s'),c(9,'d')];
  eq(P.evaluate7(seven)[0], 6, 'Best 5 of 7 - flush picked over high card subset');
}
{
  const seven = [c(10,'s'),c(11,'s'),c(12,'s'),c(13,'s'),c(14,'s'),c(14,'h'),c(14,'d')];
  eq(P.evaluate7(seven)[0], 9, 'Best 5 of 7 - royal flush beats trips');
}
{
  const seven = [c(14,'s'),c(14,'h'),c(14,'d'),c(14,'c'), c(3,'s'), c(7,'s'), c(9,'s')];
  eq(P.evaluate7(seven)[0], 8, 'Best 5 of 7 - quads picked');
}

// ----- Game state machine -----

function make4PlayerTable() {
  const t = P.createTable({ id:'t', smallBlind:5, bigBlind:10, maxSeats:4 });
  ['A','B','C','D'].forEach((name, i) => {
    t.seats[i] = {
      playerId:name, name, stack:1000,
      holeCards:[], folded:false, allIn:false, removed:false, satOut:false,
      disconnected:false, contributed:0,
    };
  });
  return t;
}

// Dealer button rotates 1 seat per hand.
{
  const t = make4PlayerTable();
  P.startHand(t);
  const b1 = t.buttonIndex;
  P.endHand(t);
  for (const s of t.seats) if (s) { s.contributed=0; s.holeCards=[]; s.folded=false; s.allIn=false; s.removed=false; }
  t.phase = P.PHASE.WAITING;
  P.startHand(t);
  eq(t.buttonIndex, (b1 + 1) % 4, 'Button advances 1 seat per hand');
}

// SB left of button, BB left of SB.
{
  const t = make4PlayerTable();
  P.startHand(t);
  const btn = t.buttonIndex;
  eq(t.sbIndex, (btn + 1) % 4, 'SB left of button');
  eq(t.bbIndex, (btn + 2) % 4, 'BB left of SB');
}

// Heads-up: dealer = SB; SB acts first pre-flop.
{
  const t = P.createTable({ id:'h', smallBlind:5, bigBlind:10, maxSeats:6 });
  t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.seats[2] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.buttonIndex = 0; // advance lands on seat 1 (A)
  P.startHand(t);
  eq(t.buttonIndex, 1, 'Heads-up dealer at A');
  eq(t.sbIndex, 1, 'Heads-up SB = dealer');
  eq(t.bbIndex, 2, 'Heads-up BB = other player');
  eq(t.currentPlayerIndex, 1, 'Heads-up pre-flop: dealer/SB acts first');
}

// BB option: limps + BB check -> Flop.
{
  const t = make4PlayerTable();
  P.startHand(t);
  const bb = t.bbIndex;
  for (let i = 0; i < 20; i++) {
    const cur = t.currentPlayerIndex;
    if (cur === -1) break;
    if (cur === bb) { P.applyAction(t, cur, 'check'); break; }
    P.applyAction(t, cur, 'call');
  }
  eq(t.phase, P.PHASE.FLOP, 'Limped pre-flop + BB check -> FLOP');
  eq(t.communityCards.length, 3, '3 community cards dealt on flop');
}

// Fold-out: in a 2-player heads-up, whoevers turn it is folds and the other wins.
// The seat that loses 15 (because they didn't pay it back), wait — actually the
// FOLDER loses their blind posts. The other player receives 5 (SB) + 10 (BB)
// = 15 chips total. Their stack grows from 1000 to 1015.
{
  const t = P.createTable({ id:'fo', smallBlind:5, bigBlind:10, maxSeats:6 });
  t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.seats[3] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.buttonIndex = 1;
  P.startHand(t);
  const firstActor = t.currentPlayerIndex;
  ok(firstActor !== -1, 'Someone is first to act in the heads-up fold-out test');
  P.applyAction(t, firstActor, 'fold');
  eq(t.phase, P.PHASE.HAND_OVER, 'Fold-out -> HAND_OVER');
  // Whichever player DID NOT fold should have won the 15 chips in the pot.
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
  const t = P.createTable({ id:'sit', smallBlind:5, bigBlind:10, maxSeats:6 });
  t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.seats[2] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.buttonIndex = 0;
  P.startHand(t);
  P.endHand(t);
  // next hand: A sits out
  t.seats[1].satOut = true;
  const aStackBefore = t.seats[1].stack;
  for (const s of t.seats) if (s) { s.contributed=0; s.holeCards=[]; s.folded=false; s.allIn=false; s.removed=false; }
  t.phase = P.PHASE.WAITING;
  t.buttonIndex = 1;
  P.startHand(t);
  eq(t.seats[1].holeCards.length, 0, 'Sat-out A receives no hole cards');
  eq(t.seats[1].stack, aStackBefore, 'Sat-out A pays no blinds');
}

// Full raise bumps minRaise.
{
  const t = make4PlayerTable();
  P.startHand(t);
  const cur = t.currentPlayerIndex;
  if (cur !== -1) {
    P.applyAction(t, cur, 'raise', t.bigBlind * 2);
    ok(t.minRaise >= t.bigBlind, 'Full raise bumps minRaise to at least BB');
  }
}

// Heads-up turn alternation: SB (A) acts first preflop, BB (B) acts last.
// Postflop, the first active player LEFT of the button (B, the BB) acts first.
{
  const t = P.createTable({ id:'turn', smallBlind:5, bigBlind:10, maxSeats:6 });
  t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.seats[2] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.buttonIndex = 0;
  P.startHand(t);
  eq(t.currentPlayerIndex, 1, 'Preflop heads-up: dealer/SB (A) acts first');
  ok(P.applyAction(t, 1, 'call').ok, 'A limps');
  eq(t.currentPlayerIndex, 2, 'After A, turn rotates to B (no skip)');
  ok(P.applyAction(t, 2, 'check').ok, 'B checks');
  eq(t.phase, P.PHASE.FLOP, 'Round advances to FLOP after both acted');
  eq(t.currentPlayerIndex, 2, 'Postflop first to act is BB (B) — left of button');
  ok(P.applyAction(t, 2, 'check').ok, 'B checks flop');
  eq(t.currentPlayerIndex, 1, 'Flop turn rotates back to A');
  ok(P.applyAction(t, 1, 'check').ok, 'A checks flop');
  eq(t.phase, P.PHASE.TURN, 'Round advances to TURN');
}

// Regression: all-in / call deadlock.
// A raises preflop, B shoves all-in (lastAggressor = B), A calls to match.
// Before the bug fix, nextActivePlayer returned A again because every other
// seat was filtered (B all-in, all other seats empty), so the engine handed
// A another turn on the same round and froze the hand. The fix changes the
// loop bound to `i < n` so the just-acted seat is never returned to itself.
{
  const t = P.createTable({ id:'turnLock', smallBlind:5, bigBlind:10, maxSeats:6 });
  t.seats[1] = { playerId:'A', name:'A', stack:200, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.seats[2] = { playerId:'B', name:'B', stack:100, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.buttonIndex = 0;
  P.startHand(t);
  ok(t.seats[1].allIn === false && t.seats[2].allIn === false, 'Both seated, no one all-in yet');
  ok(P.applyAction(t, t.currentPlayerIndex, 'raise', 30).ok, 'A raises to 30');
  ok(P.applyAction(t, t.currentPlayerIndex, 'all_in').ok, 'B shoves all-in');
  ok(t.seats[2].allIn === true, 'B is all-in');
  ok(P.applyAction(t, t.currentPlayerIndex, 'call').ok, 'A calls the all-in');
  eq(t.phase, P.PHASE.HAND_OVER, 'Hand reaches HAND_OVER via auto-fast-forward (no infinite loop on A)');
  // After HAND_OVER, no further action should be accepted.
  const res = P.applyAction(t, 1, 'call');
  ok(!res.ok, 'No further action accepted once hand is over');
}

// Auto-advance when every live player is all-in.
// Before the bug fix, heads-up where both players shoved pre-flop would
// deal the flop, set currentPlayerIndex = -1 (nobody to act), then deadlock:
// only applyAction ever calls advancePhase, and no socket event could fire
// with currentPlayerIndex === -1. The fix is advancePhase recursing when the
// freshly-started round has no active player, so the remaining community
// cards are dealt automatically until resolveShowdown runs.
{
  const t = P.createTable({ id:'ai', smallBlind:5, bigBlind:10, maxSeats:6 });
  t.seats[1] = { playerId:'A', name:'A', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.seats[2] = { playerId:'B', name:'B', stack:1000, holeCards:[], folded:false, allIn:false, removed:false, satOut:false, disconnected:false, contributed:0 };
  t.buttonIndex = 0;
  P.startHand(t);
  // Both players shove their entire stack pre-flop.
  ok(P.applyAction(t, t.currentPlayerIndex, 'all_in').ok, 'First all-in applied');
  ok(P.applyAction(t, t.currentPlayerIndex, 'all_in').ok, 'Second all-in applied');
  eq(t.phase, P.PHASE.HAND_OVER, 'All-in pre-flop auto-advances to HAND_OVER (no deadlock)');
  eq(t.communityCards.length, 5, 'All 5 community cards dealt once nobody can act');
  // Chips must be conserved (no leak in the auto-advance path).
  const totalChips = t.seats.filter(s => s && !s.removed).reduce((a, s) => a + s.stack, 0);
  eq(totalChips, 2000, 'Chips conserved across both all-in players (2000 total)');
  // And a winner must be paid out (or split equally to both).
  const winners = t.seats.filter(s => s && s.stack > 0);
  ok(winners.length >= 1, 'At least one player has chips after auto-advance to showdown');
  // Sanity: lastHandResults is populated so the client can render a banner.
  ok(!!t.lastHandResults && t.lastHandResults.winners.length >= 1,
     'lastHandResults populated for client banner');
}

console.log('');
// ----- Default tables / auto-delete empty tables -----

// Helper: clear removed seats like scheduleNextHand does after endHand.
function simulateHandCleanup(t) {
  for (let i = 0; i < t.seats.length; i++) {
    if (t.seats[i] && t.seats[i].removed) t.seats[i] = null;
  }
}

// Helper: insert a seat at `idx` for the auto-delete setup. Bypasses
// P.startHand so we don't depend on the poker engine's seeding logic.
function seatAt(t, idx, playerId, name, stack) {
  t.seats[idx] = {
    playerId, name, stack,
    holeCards: [], folded: false, allIn: false,
    removed: false, satOut: false, disconnected: false,
    contributed: 0,
  };
}

// ensureDefaultTables creates the 5 default tables exactly once on a fresh
// RoomManager. Each has the documented stakes, the default flag, and a sane
// seat count.
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

// ensureDefaultTables is idempotent: running it twice doesn't double-up.
{
  const rooms = new RoomManager();
  rooms.ensureDefaultTables();
  rooms.ensureDefaultTables();
  eq(rooms.tables.size, 5,
     'ensureDefaultTables is idempotent (still 5 tables after a second call)');
}

// A default table survives when the last seated player leaves and the hand
// ends with zero occupied seats.
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'default-empty', smallBlind:5, bigBlind:10, maxSeats:6 });
  t.default = true;
  // Hand ended; the only seated player just got removed (e.g. disconnected).
  seatAt(t, 1, 'A', 'A', 0);
  t.seats[1].removed = true;        // post-hand cleanup will null this seat
  simulateHandCleanup(t);
  if (rooms.shouldDeleteAfterHand(t)) rooms.remove(t.id);
  ok(rooms.has(t.id),
     'Default table with zero occupied seats survives HAND_OVER cleanup');
}

// A non-default table with zero occupied seats is auto-deleted at HAND_OVER.
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

// A non-default table with at least one seat survives cleanup (it stays
// waiting in the lobby for that player to come back or for others to join).
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'custom-occupied', smallBlind:20, bigBlind:40, maxSeats:6 });
  seatAt(t, 1, 'A', 'A', 0);   // A leaves / busted -> removed post-hand
  t.seats[1].removed = true;
  seatAt(t, 3, 'B', 'B', 1000); // B still seated with chips
  simulateHandCleanup(t);
  if (rooms.shouldDeleteAfterHand(t)) rooms.remove(t.id);
  ok(rooms.has(t.id),
     'Non-default table with at least one seated player survives cleanup');
}

// ----- Per-table chat (resets when everyone is out) -----

// addChatMessage appends a user message with kind='user'
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

// addChatMessage strips newlines + trims so paste floods can't push history
// out of the visible scroll area.
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'chat-clean', smallBlind:5, bigBlind:10, maxSeats:6 });
  rooms.addChatMessage(t.id, 'Bob', '  line1\nline2\r\nline3  ');
  eq(rooms.chatHistory(t.id)[0].text, 'line1 line2 line3',
     'Newlines collapsed to spaces + trimmed');
}

// addChatMessage rejects empty / whitespace-only input
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'chat-empty', smallBlind:5, bigBlind:10, maxSeats:6 });
  ok(!rooms.addChatMessage(t.id, 'A', '').ok,
     'addChatMessage rejects empty string');
  ok(!rooms.addChatMessage(t.id, 'A', '   \n  ').ok,
     'addChatMessage rejects whitespace-only string');
  eq(rooms.chatHistory(t.id).length, 0, 'No messages added for empty inputs');
}

// addChatMessage caps at 100 entries to bound memory.
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'chat-cap', smallBlind:5, bigBlind:10, maxSeats:6 });
  for (let i = 0; i < 110; i++) rooms.addChatMessage(t.id, 'A', 'msg ' + i);
  const hist = rooms.chatHistory(t.id);
  eq(hist.length, 100, 'Chat history capped at 100 messages');
  eq(hist[0].text, 'msg 10', 'Oldest messages dropped (FIFO)');
  eq(hist[99].text, 'msg 109', 'Newest message preserved');
}

// addSystemMessage appends a system message (no from field)
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

// clearChatIfEmpty: false when a seat is occupied (chat preserved)
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

// clearChatIfEmpty: true when no seats occupied, chat wiped
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'chat-clear', smallBlind:5, bigBlind:10, maxSeats:6 });
  rooms.addChatMessage(t.id, 'Alice', 'hello');
  ok(rooms.clearChatIfEmpty(t.id),
     'clearChatIfEmpty returns true when no seats occupied + chat non-empty');
  eq(rooms.chatHistory(t.id).length, 0,
     'Chat history wiped on clear');
}

// clearChatIfEmpty: no-op when chat already empty
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'chat-noop', smallBlind:5, bigBlind:10, maxSeats:6 });
  ok(!rooms.clearChatIfEmpty(t.id),
     'clearChatIfEmpty returns false when chat already empty (no-op)');
}

// End-to-end lifecycle: chat stays while at least one seat is still
// "live" (a seated non-removed player), clears once everyone is out.
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'chat-e2e', smallBlind:5, bigBlind:10, maxSeats:6 });
  seatAt(t, 0, 'A', 'A', 1000);
  seatAt(t, 2, 'B', 'B', 1000);
  P.startHand(t);
  rooms.addChatMessage(t.id, 'A', 'gg');
  // B leaves mid-hand: seat is marked removed+folded but NOT nulled yet.
  rooms.unseat(t.id, 2);
  ok(t.seats[2] && t.seats[2].removed,
     'Mid-hand leave: B\'s seat is non-null + removed');
  ok(!rooms.clearChatIfEmpty(t.id),
     'clearChatIfEmpty no-ops while A is still seated');
  eq(rooms.chatHistory(t.id).length, 1,
     'Chat preserved while A is still here');
  // Now A also leaves mid-hand: both seats are non-null + removed. The
  // hasLivePlayer check returns false (every seat is either null OR
  // removed), so the chat clears immediately — no need to wait for the
  // post-hand cleanup loop. This is the "reset when everyone is out"
  // semantic the user asked for.
  rooms.unseat(t.id, 0);
  ok(t.seats[0] && t.seats[0].removed && t.seats[2] && t.seats[2].removed,
     'Both seats are non-null + removed after both players leave');
  ok(rooms.clearChatIfEmpty(t.id),
     'clearChatIfEmpty triggers when every seat is removed');
  eq(rooms.chatHistory(t.id).length, 0,
     'Chat history wiped when everyone is out');
}

// publicView exposes chatMessages so a fresh joiner sees the history.
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

// ----- Reclaimeable removed seats ("Seat taken" false-positive fix) -----
//
// Regression for: clicking Join from the lobby when seatsTaken is 0 toasts
// "Seat taken". Root cause was a take-check / findEmptySeat definition
// mismatch: server.js#join_table and rooms.seatPlayer rejected non-null
// seats regardless of the `removed` flag, but the lobby's seatsTaken count
// (and findEmptySeat) already treat removed seats as empty. The disconnect
// handler and endHand can leave seats in non-null + removed=true state
// between hands, so the user-facing behavior broke once any player left.

// 1) rooms.seatPlayer accepts a removed-but-non-null seat (the fix).
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'reclaim', smallBlind:5, bigBlind:10, maxSeats:6 });
  // Simulate Player A disconnected: seat object is non-null but flagged
  // removed + disconnected — the exact preserved state that triggered the bug.
  seatAt(t, 0, 'A', 'A', 1000);
  t.seats[0].removed = true;
  t.seats[0].disconnected = true;
  // Sanity: lobby says 0 seats taken (matching what the user actually saw).
  const lobby = rooms.listTables().find((x) => x.id === t.id);
  eq(lobby.seatsTaken, 0,
     'Lobby seatsTaken excludes a stale removed-but-non-null seat');
  // Player B now joins. Previously this returned `{ ok:false, error:"Seat taken" }`.
  const result = rooms.seatPlayer(t.id, 0, { id:'B', name:'B', points:750 });
  ok(result.ok === true && result.error === undefined,
     'rooms.seatPlayer accepts reclaimeing a removed-but-non-null seat');
  eq(t.seats[0].name, 'B', 'Seat is now bound to the new player');
  ok(t.seats[0].removed === false && t.seats[0].disconnected === false,
     'New seat data is fully reset (removed=false, disconnected=false)');
}

// 2) rooms.seatPlayer STILL rejects a normal occupied (non-null, non-removed) seat.
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'occupied', smallBlind:5, bigBlind:10, maxSeats:6 });
  seatAt(t, 0, 'A', 'A', 1000);
  const result = rooms.seatPlayer(t.id, 0, { id:'B', name:'B', points:750 });
  ok(!result.ok && result.error === 'Seat taken',
     'rooms.seatPlayer still rejects a normal occupied seat');
}

// 3) findEmptySeat matches the take-check semantics (returns the lowest
//    index of a removed-but-non-null seat).
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'findEmpty', smallBlind:5, bigBlind:10, maxSeats:6 });
  seatAt(t, 0, 'A', 'A', 0);  t.seats[0].removed = true; // busted seat
  seatAt(t, 3, 'B', 'B', 0);  t.seats[3].removed = true; // busted seat
  eq(rooms.findEmptySeat(t.id), 0,
     'findEmptySeat returns the lowest index of a removed-but-non-null seat');
}

// 4) end-to-end bug scenario: after endHand, busted seats are non-null +
//    removed=true; lobby shows 0 seats; new seatPlayer calls succeed.
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'busted-afterhand', smallBlind:5, bigBlind:10, maxSeats:6 });
  seatAt(t, 0, 'A', 'A', 1000);
  seatAt(t, 2, 'B', 'B', 1000);
  P.startHand(t);
  P.endHand(t);
  // Force both players to 0 chips — endHand flags 0-stack seats removed=true,
  // exactly the persisted state the original bug was triggered by.
  for (const s of t.seats) if (s) s.stack = 0;
  for (const s of t.seats) if (s && s.stack <= 0) s.removed = true;
  ok(t.seats[0] && t.seats[0].removed === true,
     'Post-hand: busted seat is non-null with removed=true');
  eq(rooms.listTables().find((x) => x.id === t.id).seatsTaken, 0,
     'Post-hand: lobby reports 0 occupied seats');
  // New players walking in. Previously got "Seat taken"; now they reclame.
  const r0 = rooms.seatPlayer(t.id, 0, { id:'C', name:'C', points:500 });
  const r2 = rooms.seatPlayer(t.id, 2, { id:'D', name:'D', points:500 });
  ok(r0.ok, 'Post-bust: new player can reclaim a removed seat at index 0');
  ok(r2.ok, 'Post-bust: new player can reclaim a removed seat at index 2');
  eq(rooms.listTables().find((x) => x.id === t.id).seatsTaken, 2,
     'Post-reclaim: lobby reports both new seats as occupied');
}

// 5) Mid-hand reclaim: a player whose seat was marked removed+folded by
//    the leave-mid-hand path can be replaced by a fresh joiner before the
//    hand finishes. Visually the seat shows as an empty pill (matching
//    what the lobby's seatsTaken count has been advertising all along),
//    so the server's take-check agreeing is the correct invariant.
{
  const rooms = new RoomManager();
  const t = rooms.createTable({ name:'mid-hand-reclaim', smallBlind:5, bigBlind:10, maxSeats:6 });
  seatAt(t, 0, 'A', 'A', 1000);
  seatAt(t, 3, 'B', 'B', 1000);
  P.startHand(t);
  // Mid-hand leave: Player B's seat is folded + removed + queued for cleanup.
  rooms.unseat(t.id, 3);
  ok(t.seats[3] && t.seats[3].removed === true && t.seats[3].folded === true,
     'Mid-hand leave marks B\'s seat non-null with removed=true + folded=true');
  // Player C joins mid-hand. The lobby's seatsTaken doesn't count seat 3,
  // so the visible "0/6" math has always suggested the seat is empty; the
  // server now agrees and lets C overwrite the stale entry in-place.
  const reclame = rooms.seatPlayer(t.id, 3, { id:'C', name:'C', points:500 });
  ok(reclame.ok, 'Mid-hand: new player can reclaim a removed+folded seat');
  ok(t.seats[3] && t.seats[3].removed === false && t.seats[3].folded === false,
     'Mid-hand: reclaiming resets the seat\'s removed/folded flags');
  // Mid-hand leave queued seat 3 in _pendingUnseat. Reclaiming has to drop
  // that stale entry: finishPendingUnseat only nulls when removed=true, and
  // the new occupant has removed=false, so a leftover entry would silently
  // leak in the array forever.
  eq(t._pendingUnseat, [],
     'Mid-hand: reclaiming drops the stale _pendingUnseat entry from the prior leave');
  // The hand should still run cleanly to completion without crashing.
  P.endHand(t);
  eq(t.phase, P.PHASE.WAITING, 'Mid-hand reclaim: hand completes normally on endHand');
  // After endHand, C is still seated (stack > 0) and ready for next hand.
  ok(t.seats[3] && t.seats[3].name === 'C' && t.seats[3].stack === 500,
     'Mid-hand reclaim: new player is intact at end of hand');
}

console.log('Room / default-table tests: ' + passed + ' passed (cumulative), ' + failed + ' failed (cumulative)');
console.log('');
console.log('Poker engine tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
