// Tests for sr../showdown.js. Run directly:  node tests/test_showdown.js

'use strict';

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
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a === b) { passed++; }
  else {
    failed++;
    console.error('FAIL: ' + msg);
    console.error('  expected: ' + b);
    console.error('  actual:   ' + a);
  }
}

function c(rank, suit) { return { rank, suit }; }

// Pairs with same hand rank so we can ignore suit-mismatch noise; RANK_NAMES
// for pokersolver are 14=A, 13=K, 12=Q, 11=J, 10=T.
const S = require('../src/showdown.js');

{
  // cardToString: 14 -> A, 13 -> K, 12 -> Q, 11 -> J, 10 -> T; rest numeric.
  eq(S.cardToString(c(14, 'h')), 'Ah', 'cardToString: Ace of hearts');
  eq(S.cardToString(c(10, 'd')), 'Td', 'cardToString: Ten of diamonds (T)');
  eq(S.cardToString(c( 2, 'c')), '2c', 'cardToString: Two of clubs');
  eq(S.cardToString(c( 9, 's')), '9s', 'cardToString: Nine of spades');

  // Idempotent: strings pass through unchanged.
  eq(S.cardToString('Kh'), 'Kh', 'cardToString: idempotent on strings');

  // Errors on bad input.
  let threw = false;
  try { S.cardToString(c(15, 's')); } catch (e) { threw = true; }
  ok(threw, 'cardToString throws on out-of-range rank');
  threw = false;
  try { S.cardToString({ rank: 8 }); } catch (e) { threw = true; }
  ok(threw, 'cardToString throws on missing suit');
}

{
  // cardsToStrings: array form.
  eq(S.cardsToStrings([c(14, 's'), c(13, 'h')]), ['As', 'Kh'],
     'cardsToStrings: 2-card array');
  eq(S.cardsToStrings([c(2, 'd'), c(3, 'c'), c(4, 'h'), c(5, 's'), c(6, 'd')]),
     ['2d', '3c', '4h', '5s', '6d'],
     'cardsToStrings: 5-card array');
}

{
  // solvePlayerHand: returns a pokersolver Hand with .name and .descr.
  const hand = S.solvePlayerHand(
    [c(14, 's'), c(13, 's')],                                 // hole: As, Ks
    [c(12, 's'), c(11, 's'), c(10, 's'), c(7, 'h'), c(2, 'd')]  // board: Qs Js Ts 7h 2d
  );
  ok(typeof hand.name === 'string' && hand.name.length > 0,
     'solvePlayerHand: hand.name is a non-empty string');
  ok(typeof hand.descr === 'string' && /Straight Flush|Royal Flush|Ace High/i.test(hand.descr),
     'solvePlayerHand: hand.descr recognises the broadway straight flush');
}

{
  // solvePlayerHand: rejects bad hole-card count.
  let threw = false;
  try { S.solvePlayerHand([c(14, 's')], [c(2, 'h'), c(3, 'h'), c(4, 'h'), c(5, 'h'), c(6, 'h')]); }
  catch (e) { threw = true; }
  ok(threw, 'solvePlayerHand: 1 hole card rejected');
  threw = false;
  try { S.solvePlayerHand(
    [c(14, 's'), c(13, 's')],
    [c(12, 's'), c(11, 's'), c(10, 's'), c(7, 'h'), c(2, 'd'), c(9, 'c')]
  ); } catch (e) { threw = true; }
  ok(threw, 'solvePlayerHand: 6-card board rejected');
}

{
  // determineShowdown: heads-up, A royal flush beats a middling pair.
  const players = [
    { id: 'A', holeCards: [c(10, 's'), c(14, 's')] },          // As Ts of spades
    { id: 'B', holeCards: [c(13, 'h'), c(12, 'h')] },          // Kh Qh of hearts
  ];
  const board = [
    c(11, 's'), c(12, 's'), c(13, 's'),                       // Qs Js Ts
    c(7, 'd'), c(2, 'c'),
  ];
  // Board gives A a royal flush in spades. B has Kh Qh over Qs Js Ts
  // board = pair of queens, king kicker — A wins.
  const r = S.determineShowdown(players, board);
  eq(r.winningHoleIds, ['A'], 'Heads-up: royal flush beats pair of queens');
  const a = r.evaluations.find(e => e.id === 'A');
  const b = r.evaluations.find(e => e.id === 'B');
  ok(a.isWinner === true && b.isWinner === false,
     'Heads-up: evaluations.isWinner flag set correctly');
  ok(/Royal Flush|Straight Flush/i.test(a.handName) || /Royal Flush|Straight Flush.*Ace/i.test(a.handDescr),
     'Heads-up: A recognised as Royal/Straight Flush');

  // B's hand must have a descriptive name on the loser side too so the
  // client can show "B: Pair of Queens".
  ok(/Pair|Two Pair/i.test(b.handName) || /Pair/i.test(b.handDescr),
     'Heads-up: B has descriptive hand name even on losing side');
}

{
  // determineShowdown: 3-way; one outright winner (quads A).
  const players = [
    { id: 'X', holeCards: [c(14, 'h'), c(14, 'd')] },          // A,A hearts+diamonds
    { id: 'Y', holeCards: [c(13, 'h'), c(12, 'h')] },          // Kh Qh
    { id: 'Z', holeCards: [c( 2, 'c'), c( 3, 'd')] },          // 2c 3d
  ];
  const board = [
    c(14, 's'),                                              // As
    c(14, 'c'),                                              // Ac
    c( 7, 'h'), c( 9, 'd'), c( 4, 'c'),
  ];
  // X has four aces (quads), Y has Kh Qh + As Ac = pair of aces, Z has
  // high card.  X wins outright.
  const r = S.determineShowdown(players, board);
  eq(r.winningHoleIds, ['X'], '3-way: quads A wins outright');
  const x = r.evaluations.find(e => e.id === 'X');
  ok(/Four of a Kind/i.test(x.handName) || /Four of a Kind/i.test(x.handDescr),
     '3-way: X shows Four of a Kind in the descr');
}

{
  // determineShowdown: tied best hand -> multiple winners (split pot).
  //
  // Constructed from a board-driven straight flush where the board
  // itself IS the best 5-card hand and neither player's hole cards
  // upgrade it (holes are off-suit). Both players end up with the
  // IDENTICAL 5-card Q-high hearts straight flush using only board
  // cards. Under standard rules, identical 5-card hands tie.
  //
  // Earlier revisions of this test used [Ah 3s] vs [Kh 3c] with the
  // same board — but the extra h-ace / h-king let one player make a
  // HIGHER straight flush than the other (Kh gives K-high SF, beating
  // L's Q-high SF). Fixed here by keeping both holes OFF-suit so
  // neither player upgrades the board's Q-high hearts SF.
  const players = [
    { id: 'L', holeCards: [c( 2, 'c'), c( 3, 'c')] },           // 2c 3c
    { id: 'R', holeCards: [c( 4, 'd'), c( 5, 'd')] },           // 4d 5d
  ];
  const board = [
    c( 8, 'h'), c( 9, 'h'), c(10, 'h'),                       // 8h 9h Th
    c(11, 'h'), c(12, 'h'),                                   // Jh Qh
  ];
  // L's 7: 2c 3c 8h 9h Th Jh Qh. Best 5 = 8h 9h Th Jh Qh (Q-high
  // hearts straight flush from board).
  // R's 7: 4d 5d 8h 9h Th Jh Qh. Best 5 = same 5 board cards.
  // Both have identical Q-high hearts SF -> tie.
  const r = S.determineShowdown(players, board);
  eq(r.winningHoleIds.sort(), ['L', 'R'],
     'Tied straight flush: board-driven SF, both win');
  ok(r.evaluations.every((e) => e.isWinner === true),
     'Tied straight flush: every flag is isWinner=true');
  ok(/Straight Flush|Royal Flush/i.test(r.evaluations[0].handName)
     || /Straight Flush|Royal Flush|Ace High/i.test(r.evaluations[0].handDescr),
     'Tied hand: descr recognises the straight flush category');
}

{
  // determineShowdown: hand name default fallback is a non-empty string.
  const players = [
    { id: 'S', holeCards: [c(2, 's'), c(2, 'h')] },            // pocket twos
  ];
  const board = [
    c( 9, 's'), c( 8, 'c'), c( 7, 'd'),
    c( 6, 'h'), c( 5, 's'),
  ];
  // Straight 9-high beats the pocket twos' set of twos (because twos only
  // set; straight is category 5 > trips category 4).
  const r = S.determineShowdown(players, board);
  ok(typeof r.evaluations[0].handName === 'string' && r.evaluations[0].handName.length > 0,
     'Single player: handName present');
  ok(typeof r.evaluations[0].handDescr === 'string' && r.evaluations[0].handDescr.length > 0,
     'Single player: handDescr present');
}

{
  // Empty / bad inputs are rejected (defensive — engine never feeds these
  // but tests guard the boundary).
  let threw = false;
  try { S.determineShowdown([], []); } catch (e) { threw = true; }
  ok(threw, 'determineShowdown throws on empty players');
  threw = false;
  try { S.determineShowdown([{ id: 'X', holeCards: [c(2, 's'), c(3, 'h')] }], []); }
  catch (e) { threw = true; }
  ok(threw, 'determineShowdown throws on empty board');
}

console.log('');
console.log('showdown module tests: ' + passed + ' passed, ' + failed + ' failed');
process.exit(failed > 0 ? 1 : 0);
