// Tests for the standalone BettingRound class.
//
// These tests pin down the off-by-one bug from the original
// `moveToNextPlayer` snippet, which used a `do { ... } while (isFolded)`
// loop that could land back on the same player we started from when
// every other seat was folded/all-in/sat-out. Symptom: the engine hands
// the just-acted seat ANOTHER turn, freezing the table.
//
// Run with:
//   node --test tests/test_betting_round.js
// or via:
//   npm run test:betting

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { BettingRound } = require('../src/betting_round.js');

function player(id, opts) {
  opts = opts || {};
  return {
    id,
    isFolded: false,
    allIn: false,
    satOut: false,
    currentBet: 0,
    stack: 1000,
    ...opts,
  };
}

// =====================================================================
// 1. nextActingPlayer pin-down tests
// =====================================================================
//
// The central off-by-one bug. The buggy loop would return `from` itself
// when every other seat was inactive. The fixed version uses a strict
// `i < n` loop and returns -1 when nobody else can act.
//
// Each case below configures the players such that ONLY the seat at
// index `from` is active (note: I labeled the result as expected in
// every configuration -- the buggy version would return `from` here).

test('nextActingPlayer: when only `from` can act, returns -1 (never `from`)', () => {
  // [from, [folds for A,B,C], [allIns], [satOuts]]. Each row is
  // configured so only `from` is the single active seat.
  const cases = [
    // from=0=A only active
    [0, [false, true,  true ], [false, false, false], [false, false, false]],
    [0, [false, true,  false], [false, false, true ], [false, false, false]],
    [0, [false, true,  false], [false, false, false], [false, false, true ]],
    // from=1=B only active
    [1, [true,  false, true ], [false, false, false], [false, false, false]],
    [1, [true,  false, false], [false, false, true ], [false, false, false]],
    [1, [false, false, true ], [true,  false, false], [false, false, false]],
    // from=2=C only active
    [2, [true,  true,  false], [false, false, false], [false, false, false]],
    [2, [true,  false, false], [false, true,  false], [false, false, false]],
  ];
  for (const [from, folds, allIns, satOuts] of cases) {
    const players = [
      player('A', { isFolded: folds[0], allIn: allIns[0], satOut: satOuts[0] }),
      player('B', { isFolded: folds[1], allIn: allIns[1], satOut: satOuts[1] }),
      player('C', { isFolded: folds[2], allIn: allIns[2], satOut: satOuts[2] }),
    ];
    const br = new BettingRound(players);
    const result = br.nextActingPlayer(from);
    assert.strictEqual(result, -1,
      'nextActingPlayer(' + from + ') with folds=[' + folds +
      '] allIns=[' + allIns + '] satOuts=[' + satOuts +
      '] should return -1, got ' + result);
    // Critical assertion: never return `from`.
    assert.notStrictEqual(result, from,
      'nextActingPlayer must NEVER return `from` itself (off-by-one bug).');
  }
});

test('nextActingPlayer: when another seat can act, skips inactive seats and never returns `from`', () => {
  // [from, players (mutable flags), expected next]
  const cases = [
    [0, [
      player('A'),
      player('B', { isFolded: true }),
      player('C'),
    ], 2], // 0 -> 2 (skip B folded)
    [0, [
      player('A'),
      player('B'),
      player('C', { isFolded: true }),
    ], 1], // 0 -> 1 (skip C folded, wrap)
    [2, [
      player('A'),
      player('B'),
      player('C', { isFolded: true }),
    ], 0], // 2 -> 0 (skip C folded, wrap to A)

    [0, [
      player('A'),
      player('B', { allIn: true }),
      player('C'),
    ], 2], // 0 -> 2 (skip B all-in)
    [2, [
      player('A'),
      player('B', { allIn: true }),
      player('C'),
    ], 0], // 2 -> 0 (skip B all-in, wrap)

    [0, [
      player('A'),
      player('B', { satOut: true }),
      player('C'),
    ], 2], // 0 -> 2 (skip B sat out)
  ];
  for (const [from, players, expected] of cases) {
    const br = new BettingRound(players);
    const result = br.nextActingPlayer(from);
    assert.strictEqual(result, expected,
      'Case from=' + from + ': expected ' + expected + ', got ' + result);
    assert.notStrictEqual(result, from,
      'nextActingPlayer must NOT return `from` itself (off-by-one bug).');
  }
});

// =====================================================================
// 2. Single-actor scenarios
// =====================================================================
//
// When only one player can act, the round must close after their first
// action; the buggy version would re-prompt the same player.

test('single actor: A is only acting player; CHECK closes the round', () => {
  const players = [
    player('A'),
    player('B', { isFolded: true }),
    player('C', { isFolded: true }),
  ];
  const br = new BettingRound(players);
  const r = br.handlePlayerAction('CHECK');
  assert.strictEqual(r.ok, true, 'CHECK accepted');
  assert.strictEqual(r.complete, true,
    'Round must close after A\'s CHECK when only A can act (no re-prompt).');
});

test('single actor: A is only acting player; BET closes the round', () => {
  const players = [
    player('A', { stack: 100 }),
    player('B', { isFolded: true }),
    player('C', { isFolded: true }),
  ];
  const br = new BettingRound(players);
  const r = br.handlePlayerAction('BET', 50);
  assert.strictEqual(r.ok, true, 'BET accepted');
  assert.strictEqual(r.complete, true,
    'Round must close after A\'s BET when only A can act (no re-prompt).');
  assert.strictEqual(players[0].stack, 50, 'A paid 50');
  assert.strictEqual(players[0].currentBet, 50);
  assert.strictEqual(br.currentHighestBet, 50);
});

test('single actor: A folds (only A can act); round closes', () => {
  const players = [
    player('A'),
    player('B', { allIn: true }),
    player('C', { satOut: true }),
  ];
  const br = new BettingRound(players);
  const r = br.handlePlayerAction('FOLD');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.complete, true,
    'After the last acting player folds, round closes (no one left).');
});

// =====================================================================
// 3. Raise-then-call sequence
// =====================================================================
//
// A opens with BET (currentHighestBet is 0 in a fresh round, so BET is
// the opening action; RAISE without a prior bet is a 'Use bet' error).
// B calls. Both have acted on this bet level; both matched. Round closes
// without cycling back to A.

test('bet-then-call: round closes within bounded steps, no re-prompt of A', () => {
  const players = [
    player('A', { stack: 1000 }),
    player('B', { stack: 1000 }),
    player('C', { stack: 1000, isFolded: true }), // pre-folded to keep it 2-actor
  ];
  const br = new BettingRound(players);

  // Step 1: A opens with BET.
  let r = br.handlePlayerAction('BET', 100);
  assert.strictEqual(r.ok, true, 'A BET accepted');
  assert.strictEqual(r.complete, false, 'A BET does not close (B still to act)');
  assert.strictEqual(br.currentIndex, 1,
    'After A BET, turn rotates 0 -> 1 (never back to 0 — the off-by-one bug).');
  assert.strictEqual(players[0].stack, 900, 'A paid 100');
  assert.strictEqual(br.currentHighestBet, 100, 'currentHighestBet = 100');

  // Step 2: B calls. Both have acted since A's BET; both matched. Round closes.
  r = br.handlePlayerAction('CALL');
  assert.strictEqual(r.ok, true, 'B CALL accepted');
  assert.strictEqual(r.complete, true,
    'After B calls, both matched AND acted since last bet -> round closes.');
  assert.strictEqual(players[1].stack, 900, 'B paid 100');
  assert.strictEqual(players[0].currentBet, 100);
  assert.strictEqual(players[1].currentBet, 100);
});

test('bet-then-raise-then-call: re-raise re-opens the round exactly once', () => {
  const players = [
    player('A', { stack: 1000 }),
    player('B', { stack: 1000 }),
  ];
  const br = new BettingRound(players);

  // Track WHO ACTED each step (pre-action currentIndex). On round close
  // the engine doesn't advance currentIndex, so post-action reads would
  // duplicate the closer's index.
  const order = [];
  function step(action, amount) {
    const actor = br.currentIndex;
    const r = br.handlePlayerAction(action, amount);
    order.push(actor);
    return r;
  }

  let r = step('BET', 50);          // A opens
  assert.strictEqual(r.complete, false, 'A BET (B still to act)');
  assert.strictEqual(br.currentHighestBet, 50);

  r = step('RAISE', 200);           // B raises
  assert.strictEqual(r.complete, false,
    'B RAISE re-opens the round (actedSinceBet reset to {B})');
  assert.strictEqual(br.currentHighestBet, 200, 'currentHighestBet bumped to 200');

  r = step('CALL');                 // A calls the re-raise
  assert.strictEqual(r.complete, true,
    'After A calls the re-raise, both have acted on new level -> round closes.');
  assert.strictEqual(players[0].stack, 800, 'A paid 200');
  assert.strictEqual(players[1].stack, 800, 'B paid 200');
  assert.strictEqual(players[0].currentBet, 200);
  assert.strictEqual(players[1].currentBet, 200);

  // Belt-and-braces: no two consecutive turns on the same seat. This is
  // the precise invariant the original do-while `moveToNextPlayer` loop
  // violated. We deliberately do NOT assert a fixed shape of `order`
  // (e.g. deep-equal to [0, 1, 0]) so this test stays robust if the
  // sequence grows in a future scenario.
  for (let i = 0; i < order.length - 1; i++) {
    assert.notStrictEqual(order[i], order[i + 1],
      'Two consecutive turns on the same seat at order[' + i + '] := ' + order[i] +
      ' (off-by-one bug from the original do-while loop)');
  }
});

test('repeated raises bounded: many raises+calls terminate (no infinite loop)', () => {
  // Stress test the off-by-one fix: an alternating sequence of opens
  // and calls/raises must terminate. The buggy version would loop on
  // itself indefinitely.
  const players = [
    player('A', { stack: 10000 }),
    player('B', { stack: 10000 }),
  ];
  const br = new BettingRound(players);

  // Pre-action currentIndex (= who is acting this step). Reading post
  // action would duplicate the closer when the round finishes.
  const order = [];
  let safety = 0;
  let lastWasRaise = false;
  let r;
  while (safety < 50) {
    let action, amount;
    if (!lastWasRaise && br.currentHighestBet === 0) {
      action = 'BET';
      amount = 50;
    } else if (!lastWasRaise) {
      action = 'RAISE';
      amount = br.currentHighestBet + 50;
    } else {
      action = 'CALL';
      amount = 0;
    }
    order.push(br.currentIndex);
    r = br.handlePlayerAction(action, amount);
    lastWasRaise = (action === 'RAISE');
    if (r.complete) break;
    safety++;
  }
  assert.ok(safety < 50, 'Bounded number of turns (no infinite loop). safety=' + safety);
  for (let i = 0; i < order.length - 1; i++) {
    assert.notStrictEqual(order[i], order[i + 1],
      'Two consecutive turns on seat ' + order[i]);
  }
});

// =====================================================================
// 4. Fold-out
// =====================================================================

test('fold-out: A, B, C all fold; turn rotates once each; round closes', () => {
  const players = [
    player('A'),
    player('B'),
    player('C'),
  ];
  const br = new BettingRound(players);

  let r = br.handlePlayerAction('FOLD');
  assert.strictEqual(r.ok, true, 'A folds');
  assert.strictEqual(r.complete, false, 'B still to act');
  assert.strictEqual(br.currentIndex, 1, 'A fold -> B');

  r = br.handlePlayerAction('FOLD');
  assert.strictEqual(r.ok, true, 'B folds');
  assert.strictEqual(br.currentIndex, 2, 'B fold -> C');

  r = br.handlePlayerAction('FOLD');
  assert.strictEqual(r.ok, true, 'C folds');
  assert.strictEqual(r.complete, true, 'After C folds, nobody acts -> round closes');
  assert.strictEqual(players.filter((p) => !p.isFolded).length, 0);
});

// =====================================================================
// 5. Action validation
// =====================================================================

test('CALL with nothing to call is rejected', () => {
  const players = [player('A'), player('B')];
  const br = new BettingRound(players);
  const r = br.handlePlayerAction('CALL');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'Nothing to call');
});

test('CHECK with a pending bet is rejected', () => {
  const players = [player('A', { stack: 1000 }), player('B', { stack: 1000 })];
  const br = new BettingRound(players);
  br.handlePlayerAction('BET', 50);
  const r = br.handlePlayerAction('CHECK');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'Cannot check');
});

test('RAISE to non-exceeding amount is rejected', () => {
  const players = [player('A', { stack: 1000 }), player('B', { stack: 1000 })];
  const br = new BettingRound(players);
  br.handlePlayerAction('BET', 50);
  const r = br.handlePlayerAction('RAISE', 30);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'Must exceed current bet');
});

test('BET when a current bet exists is rejected (use RAISE)', () => {
  const players = [player('A', { stack: 1000 }), player('B', { stack: 1000 })];
  const br = new BettingRound(players);
  br.handlePlayerAction('BET', 50);
  const r = br.handlePlayerAction('BET', 100);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'Use raise');
});

test('BET with insufficient stack is rejected (no state mutation)', () => {
  // A is the first actor; A has only 20 chips. A opening BET of 200
  // must be rejected on stack grounds, not just validated through.
  const players = [player('A', { stack: 20 }), player('B')];
  const br = new BettingRound(players);
  const r = br.handlePlayerAction('BET', 200);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'Not enough chips');
  assert.strictEqual(players[0].currentBet, 0, 'A\'s bet untouched');
  assert.strictEqual(br.currentHighestBet, 0, 'bet level untouched');
  assert.strictEqual(players[0].stack, 20, 'A\'s stack untouched');
});

test('RAISE with insufficient stack is rejected (no state mutation)', () => {
  // A opens with BET 50 (succeeds). B tries to RAISE 200 but only has
  // 20 chips — must be rejected.
  const players = [
    player('A', { stack: 1000 }),
    player('B', { stack: 20 }),
  ];
  const br = new BettingRound(players);
  assert.ok(br.handlePlayerAction('BET', 50).ok, 'A opens with BET 50');
  const r = br.handlePlayerAction('RAISE', 200);
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'Not enough chips');
  assert.strictEqual(players[1].currentBet, 0, 'B\'s bet untouched');
  assert.strictEqual(br.currentHighestBet, 50, 'bet level untouched');
  assert.strictEqual(players[1].stack, 20, 'B\'s stack untouched');
});

// =====================================================================
// 6. Action-level off-by-one pin-down (all-in player mid-action)
// =====================================================================
//
// These tests put an all-in player in the seat between the actor and the
// next legal actor. The buggy `moveToNextPlayer` only skipped isFolded,
// so it would have handed the turn to the all-in seat, breaking play.
// The fixed version's strict skip of (folded || allIn || satOut) keeps
// the turn rotating past non-acting seats.

test('all-in player skipped mid-action: turn rotates past non-acting seat', () => {
  // 4 players. C is already all-in (e.g. blinds posted) BEFORE the round
  // starts. C is NOT isFolded, so the buggy loop would deliver C the turn
  // whenever scanning past it -- this test catches that at the action
  // level (not just on direct nextActingPlayer calls).
  const players = [
    player('A', { stack: 1000 }),                  // 0
    player('B', { stack: 1000 }),                  // 1
    player('C', { stack: 0, allIn: true }),        // 2: all-in, not folded
    player('D', { stack: 1000 }),                  // 3
  ];
  const br = new BettingRound(players);

  // A opens with BET 50.
  let r = br.handlePlayerAction('BET', 50);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(br.currentIndex, 1,
    'After A BET, turn must go to B (=1). Buggy impl would hand it to the ' +
    'all-in C (=2) because its check is only `isFolded`.');

  // B RAISEs to 200.
  r = br.handlePlayerAction('RAISE', 200);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(br.currentIndex, 3,
    'After B RAISE, turn must go to D (=3) past the all-in C (=2). ' +
    'Buggy impl returns 2 here.');

  // D CALLs to 200.
  r = br.handlePlayerAction('CALL');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(br.currentIndex, 0,
    'After D CALL (A still to act on the raise), turn goes back to A.');

  // A CALLs to 200. Round closes.
  r = br.handlePlayerAction('CALL');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.complete, true,
    'A calls to match 200 -> all matched + all acted -> round closes.');
  assert.strictEqual(players[0].stack, 800, 'A paid 200');
  assert.strictEqual(players[1].stack, 800, 'B paid 200');
  assert.strictEqual(players[3].stack, 800, 'D paid 200');
  assert.strictEqual(players[2].stack, 0,  'C remains all-in with stack=0');
  assert.strictEqual(players[2].allIn, true, 'C still flagged all-in');
});

test('action on a folded/all-in/sat-out seat is rejected', () => {
  const players = [
    player('A', { isFolded: true }),
    player('B'),
  ];
  const br = new BettingRound(players);
  assert.strictEqual(br.currentIndex, 1, 'firstActorIndex skips folded A');
  // Point at the folded A directly to exercise the "Cannot act" guard.
  br.currentIndex = 0;
  const r = br.handlePlayerAction('CHECK');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.error, 'Cannot act');
});
