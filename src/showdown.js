// Server-side showdown module.
//
// Texas Hold'em end-of-hand showdown. Bridges the engine's in-memory
// card representation ({rank, suit}) to the format expected by the
// `pokersolver` npm package (rank+suit strings like "Ah", "Td", "2s"),
// evaluates each non-folded player's best 5-card hand off the board,
// and returns per-player results + winners.
//
// Why a dedicated module: keeps `poker.js` focused on the betting-round
// state machine and isolates the heavy "find the best hand" work in one
// place. The wiring in `poker.js#resolveShowdown` is a thin call into
// `determineShowdown` below.
//
// This module is the live evaluation path used by the engine. The older
// `evaluate5/evaluate7/compareHands/handRankName` helpers in
// `src/poker.js` are kept for backwards-compat with the existing test
// suite but are no longer on the showdown critical path.

'use strict';

const { Hand } = require('pokersolver');

// ----- Format conversion -----
//
// Engine uses { rank: 2..14, suit: 's'|'h'|'d'|'c' }. Pokersolver expects
// rank+suit STRING like "Ah", "Td", "2s". 14 -> A, 13 -> K, 12 -> Q,
// 11 -> J, 10 -> T. Suits stay as one-letter (we already use the same
// one-letter codes: 's', 'h', 'd', 'c').
const RANK_TO_LETTER = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J', 10: 'T',
   9: '9',  8: '8',  7: '7',  6: '6',  5: '5',
   4: '4',  3: '3',  2: '2',
};

function cardToString(card) {
  // Accept already-formatted strings (used by tests) AND the engine's
  // { rank, suit } objects. Idempotent.
  if (typeof card === 'string') return card;
  const letter = RANK_TO_LETTER[card.rank];
  if (!letter) {
    throw new Error('showdown.cardToString: unknown rank ' + card.rank);
  }
  if (!card.suit || typeof card.suit !== 'string') {
    throw new Error('showdown.cardToString: missing suit');
  }
  return letter + card.suit;
}

function cardsToStrings(cards) {
  return cards.map(cardToString);
}

// ----- Evaluation -----

// Solve a single player's best 5-card hand off (hole + board). Returns
// the raw `pokersolver.Hand` object so callers can re-use its compare
// API if they want. Tests use `.name` (e.g. "Two Pair") and `.descr`
// (e.g. "Two Pair, Aces & Kings") directly.
function solvePlayerHand(holeCards, boardCards) {
  if (!Array.isArray(holeCards) || !Array.isArray(boardCards)) {
    throw new Error('showdown.solvePlayerHand: both arguments must be arrays');
  }
  if (holeCards.length !== 2) {
    throw new Error('showdown.solvePlayerHand: holeCards must be exactly 2 cards, got ' + holeCards.length);
  }
  // Texas Hold'em board has 0..5 community cards (pre-flop / flop / turn /
  // river). Anything > 5 is malformed: the engine never produces a >5-card
  // board and a manual >5-card call would propagate a category bug to the
  // UI banner (`storedHandName`). Reject explicitly so the test suite
  // catches accidental 6-card boards.
  if (boardCards.length > 5) {
    throw new Error('showdown.solvePlayerHand: boardCards must be at most 5 cards, got ' + boardCards.length);
  }
  return Hand.solve(cardsToStrings(holeCards.concat(boardCards)));
}

// Run a full showdown across N players + a 5-card board.
//
// players: array of { id: any, holeCards: [{rank, suit}] }
// boardCards: array of 5 board cards [{rank, suit}]
//
// Returns:
//   {
//     evaluations: [{ id, hand: Hand, handName, handDescr, isWinner }],
//     winningHandObjects: [Hand, ...]      // raw winning Hand objects
//     winningHoleIds: [id, ...]            // ids of winning players
//   }
//
// Ties yield multiple winners (split-pot). Folded players must be
// filtered out by the caller — `determineShowdown` does NOT look at any
// `folded` flag because the engine never feeds folded seats into here.
function determineShowdown(players, boardCards) {
  if (!Array.isArray(players) || players.length === 0) {
    throw new Error('showdown.determineShowdown: players must be a non-empty array');
  }
  if (!Array.isArray(boardCards) || boardCards.length !== 5) {
    throw new Error('showdown.determineShowdown: boardCards must be exactly 5 cards');
  }

  const evaluations = players.map((p) => {
    const hand = solvePlayerHand(p.holeCards, boardCards);
    return {
      id: p.id,
      hand: hand,
      handName: hand.name,
      handDescr: hand.descr,
      isWinner: false,
    };
  });

  const winningHands = Hand.winners(evaluations.map((e) => e.hand));
  // Mark winners. `winningHands.includes` is identity-based — when
  // there's a tie, ALL tied hands are returned by winners().
  for (const e of evaluations) {
    if (winningHands.indexOf(e.hand) !== -1) e.isWinner = true;
  }

  return {
    evaluations: evaluations,
    winningHandObjects: winningHands,
    winningHoleIds: evaluations.filter((e) => e.isWinner).map((e) => e.id),
  };
}

module.exports = {
  cardToString,
  cardsToStrings,
  solvePlayerHand,
  determineShowdown,
  // Re-export the underlying solver so callers (or tests) can poke at
  // it without taking its own dependency on the npm package directly.
  _pokerSolverHand: Hand,
};
