// Texas Hold'em poker engine tests. Run with: node tests/test_poker.js
// Exits 0 on success, 1 on any failure.

'use strict';

const P = require('../src/poker.js');

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
console.log('Poker engine tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
