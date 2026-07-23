// Texas Hold'em poker engine.
// Provides: deck creation/shuffling, hand evaluation (best 5 of 7 cards), and the
// full game state machine (blinds, betting rounds, showdown).
//
// A card is { rank: 2..14 (14 = Ace), suit: 's'|'h'|'d'|'c' }.

'use strict';

const SUITS = ['s', 'h', 'd', 'c'];
const RANK_NAMES = {
  14: 'A', 13: 'K', 12: 'Q', 11: 'J',
  10: '10', 9: '9', 8: '8', 7: '7',
  6: '6', 5: '5', 4: '4', 3: '3', 2: '2',
};
const PHASE = {
  WAITING: 'waiting',
  PRE_FLOP: 'pre_flop',
  FLOP: 'flop',
  TURN: 'turn',
  RIVER: 'river',
  SHOWDOWN: 'showdown',
  HAND_OVER: 'hand_over',
};

// ----- Card / deck helpers -----

function rankLabel(r) { return RANK_NAMES[r] || String(r); }

function freshDeck() {
  const deck = [];
  for (const s of SUITS) {
    for (let r = 2; r <= 14; r++) deck.push({ rank: r, suit: s });
  }
  return deck;
}

function shuffle(deck) {
  const c = (typeof require !== 'undefined' && require('crypto').webcrypto)
    ? require('crypto').webcrypto
    : globalThis.crypto;
  const a = deck.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const buf = new Uint32Array(1);
    c.getRandomValues(buf);
    const j = Math.floor((buf[0] / 0x100000000) * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ----- Hand evaluation -----
//
// Hand rank is a small array compared lexicographically; bigger wins.
// Categories: 9 SF, 8 quads, 7 full house, 6 flush, 5 straight,
//             4 trips, 3 two pair, 2 pair, 1 high card.

function compareHands(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const av = a[i] === undefined ? 0 : a[i];
    const bv = b[i] === undefined ? 0 : b[i];
    if (av !== bv) return av - bv;
  }
  return 0;
}

function rankCounts(cards) {
  const m = new Map();
  for (const c of cards) m.set(c.rank, (m.get(c.rank) || 0) + 1);
  return Array.from(m.entries())
    .sort((x, y) => y[1] - x[1] || y[0] - x[0]);
}

function evaluate5(cards) {
  if (cards.length !== 5) throw new Error('evaluate5 needs 5 cards');

  const ranks = cards.map(c => c.rank).sort((a, b) => b - a);
  const suits = cards.map(c => c.suit);
  const isFlush = suits.every(s => s === suits[0]);

  const rc = rankCounts(cards);
  const counts = rc.map(x => x[1]);
  const ranksByCount = rc.map(x => x[0]);

  let straightHigh = 0;
  const uniqueDesc = Array.from(new Set(ranks)).sort((a, b) => b - a);
  if (uniqueDesc.length === 5) {
    if (uniqueDesc[0] - uniqueDesc[4] === 4) {
      straightHigh = uniqueDesc[0];
    } else if (
      uniqueDesc[0] === 14 && uniqueDesc[1] === 5 &&
      uniqueDesc[2] === 4 && uniqueDesc[3] === 3 && uniqueDesc[4] === 2
    ) {
      straightHigh = 5; // wheel A-2-3-4-5
    }
  }
  const isStraight = straightHigh !== 0;

  if (isFlush && isStraight) return [9, straightHigh];
  if (counts[0] === 4)        return [8, ranksByCount[0], ranksByCount[1]];
  if (counts[0] === 3 && counts[1] === 2) return [7, ranksByCount[0], ranksByCount[1]];
  if (isFlush)                return [6, ranks[0], ranks[1], ranks[2], ranks[3], ranks[4]];
  if (isStraight)             return [5, straightHigh];
  if (counts[0] === 3)        return [4, ranksByCount[0], ranksByCount[1], ranksByCount[2]];
  if (counts[0] === 2 && counts[1] === 2) return [3, ranksByCount[0], ranksByCount[1], ranksByCount[2]];
  if (counts[0] === 2)        return [2, ranksByCount[0], ranksByCount[1], ranksByCount[2], ranksByCount[3]];
  return [1, ranks[0], ranks[1], ranks[2], ranks[3], ranks[4]];
}

function* combinations(n, k) {
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield idx.slice();
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

function evaluate7(cards) {
  if (cards.length !== 7) throw new Error('evaluate7 needs 7 cards');
  let best = null;
  for (const ix of combinations(7, 5)) {
    const sub = ix.map(i => cards[i]);
    const rank = evaluate5(sub);
    if (!best || compareHands(rank, best) > 0) best = rank;
  }
  return best;
}

function handRankName(rank) {
  const n = rankLabel;
  switch (rank[0]) {
    case 9: return rank[1] === 14 ? 'Royal Flush' : `Straight Flush, ${n(rank[1])} high`;
    case 8: return `Four of a Kind, ${n(rank[1])}s`;
    case 7: return `Full House, ${n(rank[1])}s over ${n(rank[2])}s`;
    case 6: return `Flush, ${n(rank[1])} high`;
    case 5: return `Straight, ${n(rank[1])} high`;
    case 4: return `Three of a Kind, ${n(rank[1])}s`;
    case 3: return `Two Pair, ${n(rank[1])}s and ${n(rank[2])}s`;
    case 2: return `Pair of ${n(rank[1])}s`;
    case 1: return `High Card ${n(rank[1])}`;
    default: return 'Unknown';
  }
}

function determineWinners(players) {
  // players: [{ id, handCards: 7 cards }]
  if (players.length === 0) return [];
  const evaluated = players.map(p => ({ id: p.id, rank: evaluate7(p.handCards) }));
  let best = evaluated[0].rank;
  for (let i = 1; i < evaluated.length; i++) {
    if (compareHands(evaluated[i].rank, best) > 0) best = evaluated[i].rank;
  }
  return evaluated.filter(e => compareHands(e.rank, best) === 0).map(e => e.id);
}

// ----- Table / state -----

function createTable(opts = {}) {
  return {
    id: opts.id,
    name: opts.name || `Table ${opts.id}`,
    smallBlind: opts.smallBlind || 5,
    bigBlind: opts.bigBlind || 10,
    startingStack: opts.startingStack || 1000,
    maxSeats: opts.maxSeats || 6,

    seats: Array.from({ length: opts.maxSeats || 6 }, () => null),
    // seat = {
    //   socketId, playerId, name, stack,
    //   holeCards: [], contributed, folded, allIn, removed, satOut
    // }
    buttonIndex: 0,
    sbIndex: -1,
    bbIndex: -1,
    currentPlayerIndex: -1,

    phase: PHASE.WAITING,
    communityCards: [],
    deck: [],
    pot: 0,
    currentBet: 0,
    minRaise: 0,
    lastAggressor: -1,
    winners: [],         // array of playerIds
    winnerNames: [],     // parallel array for display
    winnerHandNames: [], // parallel array for display
    showdownShown: false,
    handNumber: 0,
    handLog: [],
    lastHandResults: null, // { winners: [{ id, name, handName, share }] }
  };
}

function getSeatedPlayers(table) {
  return table.seats
    .map((s, i) => ({ seat: s, idx: i }))
    .filter(({ seat }) => seat && !seat.removed);
}

function nextOccupiedAfter(table, from) {
  const n = table.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (from + i) % n;
    if (table.seats[idx] && !table.seats[idx].removed) return idx;
  }
  return -1;
}

function firstOccupiedAfter(table, from) {
  return nextOccupiedAfter(table, from);
}

function nextActivePlayer(table, from) {
  const n = table.seats.length;
  // `i < n` (NOT `i <= n`). With `<=`, on the final iteration `idx` resolves
  // to `(from + n) % n === from`, so when every candidate between from+1 and
  // from+n-1 is filtered out (folded/all-in/sat-out/removed/empty) AND
  // `from` itself is still active, the function would return `from` — handing
  // the just-acted seat another turn.
  //
  // This is the precise route to a turn-rotation deadlock: A raises, B
  // shoves all-in (lastAggressor = B), A calls to match. End-of-round sees
  // liveCount>1, allMatched=true, lastAggressor(B) != seatIdx(A) so the
  // closer check fails, and the else branch then asks nextActivePlayer for
  // the next seat. Without this fix the answer was A again, so the engine
  // looped A indefinitely on A's "turn" even though A had nothing left to
  // bet, freezing both players.
  for (let i = 1; i < n; i++) {
    const idx = (from + i) % n;
    const s = table.seats[idx];
    if (s && !s.removed && !s.folded && !s.allIn && !s.satOut) return idx;
  }
  return -1;
}

function bettingRoundComplete(table) {
  const acting = table.seats.filter(s => s && !s.removed && !s.folded && !s.allIn && !s.satOut);
  if (acting.length === 0) return true;
  if (table.currentBet === 0) {
    // At least one player must have had a chance.
    // For first action of a round, complete when currentPlayerIndex becomes -1 (we set it).
    return table.currentPlayerIndex === -1;
  }
  for (const s of acting) {
    if (s.contributed !== table.currentBet) return false;
  }
  return true;
}

function countLivePlayers(table) {
  return table.seats.filter(s => s && !s.removed && !s.folded).length;
}

function countPlayablePlayers(table) {
  // Can a hand start? Need >=2 not-removed seated with chips > 0.
  return table.seats.filter(s => s && !s.removed && s.stack > 0).length;
}

// ----- Lifecycle -----

function startHand(table) {
  table.handNumber += 1;
  table.communityCards = [];
  table.pot = 0;
  table.currentBet = 0;
  table.minRaise = 0;
  table.lastAggressor = -1;
  table.winners = [];
  table.winnerNames = [];
  table.winnerHandNames = [];
  table.showdownShown = false;
  table.lastHandResults = null;
  table.handLog = [];

  // Reset per-hand seat state. We also snapshot each seat's stack into
  // `preHandStack` so the busted-refund rule (see `checkBustedRefund`)
  // can restore the live players' balances to their PRE-HAND value when
  // one player gets out mid-game. Snapshotted after the busted-player
  // filter so a re-entry of someone who sat down with 0 stack is not
  // counted as a pre-hand "balance".
  for (let i = 0; i < table.seats.length; i++) {
    const s = table.seats[i];
    if (!s) continue;
    s.holeCards = [];
    s.folded = false;
    s.contributed = 0;
    s.allIn = false;
    if (s.stack <= 0) {
      s.removed = true;
      s.preHandStack = 0;
    } else {
      s.preHandStack = s.stack;
    }
  }
  // Mark the hand as having just begun so the AFK idle timer starts fresh
  // for whoever the currentPlayer ends up being.
  table._actionClockAt = Date.now();

  if (countPlayablePlayers(table) < 2) {
    table.phase = PHASE.WAITING;
    return false;
  }

  // Move dealer button to next occupied seat that has chips (for heads-up, alternates).
  // Dealer button always advances to the next occupied seat that has chips.
  // (If only one playable player remains, countPlayablePlayers < 2 and we
  // bail below before this matters.)
  const n = table.seats.length;
  for (let i = 1; i <= n; i++) {
    const idx = (table.buttonIndex + i) % n;
    const seat = table.seats[idx];
    if (seat && !seat.removed && seat.stack > 0) {
      table.buttonIndex = idx;
      break;
    }
  }

  // SB / BB
  table.sbIndex = nextOccupiedAfter(table, table.buttonIndex);
  if (table.sbIndex === -1) {
    table.phase = PHASE.WAITING;
    return false;
  }
  table.bbIndex = nextOccupiedAfter(table, table.sbIndex);
  if (table.bbIndex === -1) {
    table.phase = PHASE.WAITING;
    return false;
  }

  // Heads-up rule: dealer posts SB. Otherwise SB is left of button.
  const seated = table.seats.filter(s => s && !s.removed && s.stack > 0).length;
  if (seated === 2) {
    // in heads-up, dealer is small blind; other player is BB.
    table.sbIndex = table.buttonIndex;
    table.bbIndex = nextOccupiedAfter(table, table.buttonIndex);
  }

  table.phase = PHASE.PRE_FLOP;
  table.deck = shuffle(freshDeck());

  // Deal 2 hole cards to each player with chips who is NOT sitting out.
  const order = [];
  const startIdx = table.sbIndex;
  for (let i = 0; i < table.seats.length; i++) {
    const idx = (startIdx + i) % table.seats.length;
    const seat = table.seats[idx];
    if (seat && !seat.removed && !seat.satOut && seat.stack > 0) order.push(idx);
  }
  for (let r = 0; r < 2; r++) {
    for (const idx of order) {
      table.seats[idx].holeCards.push(table.deck.pop());
    }
  }

  // Post blinds. If the SB or BB seat is sitting out, skip posting; the
  // active player's contribution from the blinds is therefore smaller and
  // currentBet / minRaise are computed accordingly.
  let activeSbAmt = table.smallBlind;
  let activeBbAmt = table.bigBlind;
  if (!table.seats[table.sbIndex] || table.seats[table.sbIndex].satOut) {
    activeSbAmt = 0;
  }
  if (!table.seats[table.bbIndex] || table.seats[table.bbIndex].satOut) {
    activeBbAmt = 0;
  }
  if (activeSbAmt > 0) postBlind(table, table.sbIndex, activeSbAmt);
  if (activeBbAmt > 0) postBlind(table, table.bbIndex, activeBbAmt);
  // currentBet/minRaise default to the BB, but if both SB and BB sat out,
  // no current bet exists yet.
  if (activeBbAmt > 0) {
    table.currentBet = table.bigBlind;
    table.minRaise = activeBbAmt > 0 ? activeBbAmt : table.smallBlind;
    table.lastAggressor = table.bbIndex;
  } else if (activeSbAmt > 0) {
    table.currentBet = table.smallBlind;
    table.minRaise = table.smallBlind;
    table.lastAggressor = table.sbIndex;
  } else {
    table.currentBet = 0;
    table.minRaise = 0;
    table.lastAggressor = -1;
  }
  // Stamp the AFK clock so the actor whose turn it now is has the full
  // 90s window. (Post-blind amounts the actor might call next turn is
  // not relevant here; we just want a fresh "your turn started" moment.)
  table._actionClockAt = Date.now();
  table.handLog.push({ type: 'hand_start', number: table.handNumber, seats: order });
  // Reset the AFK clock right after the hand starts so the first actor
  // gets the full 90s window. (The earlier `table._actionClockAt = Date.now()`
  // snapshot also fires here, but a second stamp immediately before
  // currentPlayerIndex is set means the clock starts exactly when it's
  // the actor's turn.}
  table._actionClockAt = Date.now();

  // Action order:
  // - Normal: starts left of BB
  // - Heads-up: starts with dealer (who is the SB)
  let firstToAct;
  if (seated === 2) {
    firstToAct = table.sbIndex; // dealer/SB acts first preflop
  } else {
    firstToAct = nextActivePlayer(table, table.bbIndex);
  }
  table.currentPlayerIndex = firstToAct;
  return true;
}

function postBlind(table, seatIdx, amount) {
  const s = table.seats[seatIdx];
  if (!s) return 0;
  const amt = Math.min(s.stack, amount);
  s.stack -= amt;
  s.contributed = amt;
  table.pot += amt;
  if (s.stack === 0) s.allIn = true;
  return amt;
}

// Advance community cards & phase after a round completes.
// Returns true if a betting round still should run; false if showdown/handover needed.
function advancePhase(table) {
  const live = countLivePlayers(table);
  if (live <= 1) {
    // Only one (or zero) not-folded -> hand is over by fold-out.
    const winnerSeat = table.seats.find(s => s && !s.removed && !s.folded);
    if (winnerSeat) {
      awardPot(table, [winnerSeat], [table.pot]);
    }
    table.phase = PHASE.HAND_OVER;
    table.currentPlayerIndex = -1;
    // Busted-refund rule: if any seat ended the hand with stack === 0
    // (they went all-in and lost, or were forced all-in by a raise they
    // couldn't match), reset the OTHER live players' stacks to their
    // pre-hand snapshot and void the pot. This keeps the meta-game fair:
    // no one can be crippled by a single all-in loss.
    checkBustedRefund(table);
    return false;
  }

  // Burn + deal based on current phase.
  if (table.phase === PHASE.PRE_FLOP) {
    table.deck.pop(); // burn
    table.communityCards.push(table.deck.pop(), table.deck.pop(), table.deck.pop());
    table.phase = PHASE.FLOP;
  } else if (table.phase === PHASE.FLOP) {
    table.deck.pop();
    table.communityCards.push(table.deck.pop());
    table.phase = PHASE.TURN;
  } else if (table.phase === PHASE.TURN) {
    table.deck.pop();
    table.communityCards.push(table.deck.pop());
    table.phase = PHASE.RIVER;
  } else if (table.phase === PHASE.RIVER) {
    // No more betting; go to showdown.
    resolveShowdown(table);
    return false;
  }

  // Start new betting round.
  beginBettingRound(table);

  // Auto-fast-forward: once we've dealt the next phase, if every remaining
  // player is all-in / sat-out / folded, no one can act for the new round —
  // e.g. heads-up where both players shoved pre-flop. Without this guard the
  // game deadlocks here because only `applyAction` calls `advancePhase`, but
  // no socket action will ever arrive when `currentPlayerIndex === -1`.
  // Recurse to deal the remaining streets until `resolveShowdown` sets
  // `HAND_OVER`, which terminates the recursion cleanly.
  if (
    table.currentPlayerIndex === -1 &&
    table.phase !== PHASE.HAND_OVER &&
    table.phase !== PHASE.SHOWDOWN
  ) {
    return advancePhase(table);
  }

  return true;
}

function beginBettingRound(table) {
  table.currentBet = 0;
  table.minRaise = 0;
  for (const s of table.seats) {
    if (!s) continue;
    s.contributed = 0;
  }
  // First to act: first active player left of the button (UTG-equivalent).
  const firstIdx = nextActivePlayer(table, table.buttonIndex);
  table.currentPlayerIndex = firstIdx;
  // Round closer: the last player who must have a chance to check (or
  // raise/call) before the round closes naturally in a check-around.
  // Preflop: BB is the closer (last to act preflop). Postflop: the button is
  // the closer (last to act in the postflop turn order). Storing this in
  // `lastAggressor` lets the `seatIdx === lastAggressor && allMatched`
  // close-branch fire once action has wound back to the closer — not when
  // the *first* postflop actor (left-of-button) checks. Note that raises
  // during the round overwrite this with the actual last aggressor.
  table.lastAggressor = (table.phase === PHASE.PRE_FLOP)
    ? table.bbIndex
    : table.buttonIndex;
}

function applyAction(table, seatIdx, action, amountParam) {
  const seat = table.seats[seatIdx];
  if (!seat) return { ok: false, error: 'No seat' };
  if (seat.removed) return { ok: false, error: 'Not seated' };
  if (table.phase === PHASE.WAITING || table.phase === PHASE.SHOWDOWN || table.phase === PHASE.HAND_OVER) {
    return { ok: false, error: 'No hand in progress' };
  }
  if (table.currentPlayerIndex !== seatIdx) return { ok: false, error: 'Not your turn' };
  if (seat.folded || seat.allIn || seat.satOut) return { ok: false, error: 'Cannot act' };

  const amount = (typeof amountParam === 'number' && isFinite(amountParam)) ? amountParam : 0;
  const toCall = table.currentBet - seat.contributed;

  switch (action) {
    case 'fold': {
      seat.folded = true;
      table.handLog.push({ type: 'fold', seat: seatIdx, name: seat.name });
      break;
    }
    case 'check': {
      if (toCall > 0) return { ok: false, error: 'Cannot check' };
      table.handLog.push({ type: 'check', seat: seatIdx, name: seat.name });
      break;
    }
    case 'call': {
      const pay = Math.min(seat.stack, toCall);
      if (pay <= 0) {
        // same as check
        table.handLog.push({ type: 'check', seat: seatIdx, name: seat.name });
        break;
      }
      seat.stack -= pay;
      seat.contributed += pay;
      table.pot += pay;
      if (seat.stack === 0) seat.allIn = true;
      table.handLog.push({ type: 'call', seat: seatIdx, name: seat.name, amount: pay });
      break;
    }
    case 'bet': {
      if (table.currentBet > 0) return { ok: false, error: 'Use raise' };
      if (amount < table.bigBlind) return { ok: false, error: `Min bet is ${table.bigBlind}` };
      if (amount > seat.stack) return { ok: false, error: 'Not enough chips' };
      seat.stack -= amount;
      seat.contributed += amount;
      table.pot += amount;
      table.currentBet = amount;
      table.minRaise = amount;
      table.lastAggressor = seatIdx;
      table.handLog.push({ type: 'bet', seat: seatIdx, name: seat.name, amount });
      break;
    }
    case 'raise': {
      if (table.currentBet <= 0) return { ok: false, error: 'Use bet' };
      const newBet = amount; // total target bet level
      if (newBet <= table.currentBet) return { ok: false, error: 'Must increase bet' };
      const increment = newBet - table.currentBet;
      const toPutIn = newBet - seat.contributed;
      if (toPutIn > seat.stack) return { ok: false, error: 'Not enough chips' };
      if (toPutIn < seat.stack && increment < table.minRaise) {
        return { ok: false, error: `Min raise is ${table.minRaise}` };
      }
      seat.stack -= toPutIn;
      seat.contributed += toPutIn;
      table.pot += toPutIn;
      table.currentBet = newBet;
      if (increment >= table.minRaise) {
        table.minRaise = increment;
        table.lastAggressor = seatIdx;
      }
      if (seat.stack === 0) seat.allIn = true;
      table.handLog.push({ type: 'raise', seat: seatIdx, name: seat.name, toAmount: newBet });
      break;
    }
    case 'all_in': {
      const pay = seat.stack;
      if (pay <= 0) return { ok: false, error: 'No chips' };
      seat.stack = 0;
      const newContrib = seat.contributed + pay;
      seat.contributed = newContrib;
      seat.allIn = true;
      table.pot += pay;
      if (newContrib > table.currentBet) {
        const increment = newContrib - table.currentBet;
        if (increment >= table.minRaise) {
          table.minRaise = increment;
          table.lastAggressor = seatIdx;
        }
        table.currentBet = newContrib;
      }
      table.handLog.push({ type: 'all_in', seat: seatIdx, name: seat.name, amount: pay });
      break;
    }
    case 'sit_out': {
      seat.satOut = true;
      // Sitting out mid-hand is treated as a fold so they can't enter
      // showdown for free when facing a bet.
      if (table.phase !== PHASE.WAITING && table.phase !== PHASE.HAND_OVER) {
        seat.folded = true;
        table.handLog.push({ type: 'fold_sit_out', seat: seatIdx, name: seat.name });
      } else {
        table.handLog.push({ type: 'sit_out', seat: seatIdx, name: seat.name });
      }
      break;
    }
    case 'sit_in': {
      // Sit-in is only legal when the seat is not otherwise out of the hand
      // (folded or all-in for this betting round). Otherwise the player stays
      // sat out for this hand and will re-enter next hand.
      if (seat.folded || seat.allIn) {
        return { ok: false, error: 'Can only sit in between hands' };
      }
      seat.satOut = false;
      table.handLog.push({ type: 'sit_in', seat: seatIdx, name: seat.name });
      break;
    }
    default:
      return { ok: false, error: 'Unknown action' };
  }

  // End-of-round check.
  // A round is complete when:
  //   (a) At most one live player is left (everyone else folded), OR
  //   (b) All currently-acting players have matched the current bet AND the
  //       player who just acted is the round "closer" - the BB preflop, the
  //       last aggressor after a raise, or the first active player in a
  //       check-around round.
  const liveCount = countLivePlayers(table);
  const acting = table.seats.filter(s => s && !s.removed && !s.folded && !s.allIn && !s.satOut);
  const allMatched = acting.length === 0
    ? true
    : acting.every(s => s.contributed === table.currentBet);

  if (liveCount <= 1) {
    advancePhase(table);
  } else if (allMatched && table.lastAggressor !== -1 && seatIdx === table.lastAggressor) {
    advancePhase(table);
  } else {
    const nextIdx = nextActivePlayer(table, seatIdx);
    if (nextIdx === -1) {
      // Safety: nothing else can act.
      advancePhase(table);
    } else {
      table.currentPlayerIndex = nextIdx;
      // Stamp the AFK clock so the new currentPlayer has a fresh 90s
      // window. Without this, the previous actor's clock would carry
      // over and the new actor could be AFK-kicked before they ever see
      // their turn.
      table._actionClockAt = Date.now();
    }
  }

  return { ok: true };
}

function awardPot(table, winnerSeats, amounts) {
  for (let i = 0; i < winnerSeats.length; i++) {
    const seat = winnerSeats[i];
    seat.stack += amounts[i];
  }
  // Resolve display hand name. If a storedHandName has been precomputed
  // (multi-way showdown or single-winner post-river), use it. Otherwise the
  // winner took the pot by fold-out and we have an unknown hand - just say so.
  table.lastHandResults = {
    winners: winnerSeats.map((s, i) => ({
      id: s.playerId,
      name: s.name,
      handName: s.storedHandName || 'Won by fold',
      share: amounts[i],
    })),
  };
}

function resolveShowdown(table) {
  // Determine per-player hand info, find winners, award.
  const live = table.seats.filter(s => s && !s.removed && !s.folded);
  if (live.length === 0) {
    table.phase = PHASE.HAND_OVER;
    table.currentPlayerIndex = -1;
    return;
  }
  if (live.length === 1) {
    // Single live player at showdown: we have full board. Evaluate their hand
    // for the result banner; only call evaluate7 when we have all 7 cards.
    const winner = live[0];
    if (table.communityCards.length === 5 && winner.holeCards.length === 2) {
      winner.storedHandName = handRankName(evaluate7(winner.holeCards.concat(table.communityCards)));
    }
    awardPot(table, [winner], [table.pot]);
    table.phase = PHASE.HAND_OVER;
    table.currentPlayerIndex = -1;
    return;
  }
  const players = live.map(s => ({
    seat: s,
    rank: evaluate7(s.holeCards.concat(table.communityCards)),
  }));
  let bestRank = players[0].rank;
  for (let i = 1; i < players.length; i++) {
    if (compareHands(players[i].rank, bestRank) > 0) bestRank = players[i].rank;
  }
  const winners = players.filter(p => compareHands(p.rank, bestRank) === 0);
  const share = Math.floor(table.pot / winners.length);
  const amounts = winners.map(() => share);
  // Award any remainder (uneven split) to the first winner (closest left of
  // the button wins odd chips in standard rules).
  const remainder = table.pot - share * winners.length;
  if (remainder > 0) amounts[0] += remainder;
  // Attach handName for display before awarding.
  for (const w of winners) w.seat.storedHandName = handRankName(w.rank);
  awardPot(table, winners.map(w => w.seat), amounts);
  table.winners = winners.map(w => w.seat.playerId);
  table.winnerNames = winners.map(w => w.seat.name);
  table.winnerHandNames = winners.map(w => handRankName(w.rank));
  table.phase = PHASE.HAND_OVER;
  table.currentPlayerIndex = -1;
  table.showdownShown = true;
  // Busted-refund rule (multi-way showdown variant): same as the
  // fold-out branch above. If any non-folded, non-removed, non-sat-out
  // seat ended the hand with stack===0, void the in-flight balances and
  // refund everyone else to their pre-hand stacks.
  checkBustedRefund(table);
}

// Voids the in-flight balances of the hand if any seat "got out"
// (stack === 0) mid-hand, and refunds every other live seat's stack to
// its preHandStack snapshot. The busted seat(s) stay at 0 and are
// marked removed so they can't return.
//
// IMPORTANT: this is called ONLY inside the engine, after awardPot has
// already paid out the pot to the formal winner(s). It then REFUNDS the
// winner(s) too — the user-visible result is "the hand was voided; every
// still-in player's chip count reverts to what it was when the hand
// started, and the busted player(s) are flagged out". lastHandResults is
// cleared so the client shows no winner banner (the event is signalled
// via a system chat message instead, see rooms.addSystemMessage caller).
function checkBustedRefund(table) {
  if (table.phase === PHASE.WAITING || table.phase === PHASE.HAND_OVER) return false;
  const liveWithZeroStack = [];
  for (const s of table.seats) {
    if (s && !s.removed && !s.folded && !s.satOut && s.stack === 0) {
      liveWithZeroStack.push(s);
    }
  }
  if (!liveWithZeroStack.length) return false;
  for (let i = 0; i < table.seats.length; i++) {
    const s = table.seats[i];
    if (!s || s.removed) continue;
    if (liveWithZeroStack.indexOf(s) !== -1) {
      s.removed = true; // out of the game
    } else if (typeof s.preHandStack === 'number') {
      // Refund: revert to the snapshot taken at hand start. The winner's
      // stack (which awardPot just boosted) is rolled back here.
      s.stack = s.preHandStack;
    }
  }
  table.pot = 0;
  table.phase = PHASE.HAND_OVER;
  table.currentPlayerIndex = -1;
  table.lastHandResults = null;
  table._bustedRefundThisHand = liveWithZeroStack.map((s) => s.name);
  return true;
}

function endHand(table) {
  // Clear hand state. Players with 0 stack after payout are kept seated
  // (admin can refill them via the admin panel) and marked removed so
  // they don't enter the next hand until refilled.
  for (let i = 0; i < table.seats.length; i++) {
    const s = table.seats[i];
    if (!s) continue;
    s.holeCards = [];
    s.contributed = 0;
    s.folded = false;
    s.allIn = false;
    s.storedHandName = null;
    if (s.stack <= 0) s.removed = true;
  }
  table.communityCards = [];
  table.pot = 0;
  table.currentBet = 0;
  table.handLog = [];
  table.lastHandResults = null;
  table.phase = PHASE.WAITING;
  table.currentPlayerIndex = -1;
}

// Allow an admin to add chips to a player (adds to stack + logs a hand note when in a hand).
function addChipsToSeat(table, seatIdx, amount) {
  if (amount <= 0) return false;
  const s = table.seats[seatIdx];
  if (!s) return false;
  if (s.removed) s.removed = false; // re-attach them
  s.stack += amount;
  return true;
}

module.exports = {
  RANK_NAMES,
  SUITS,
  PHASE,
  rankLabel,
  freshDeck,
  shuffle,
  evaluate5,
  evaluate7,
  compareHands,
  handRankName,
  determineWinners,
  createTable,
  getSeatedPlayers,
  nextOccupiedAfter,
  firstOccupiedAfter,
  nextActivePlayer,
  bettingRoundComplete,
  countLivePlayers,
  countPlayablePlayers,
  startHand,
  beginBettingRound,
  applyAction,
  resolveShowdown,
  endHand,
  addChipsToSeat,
  awardPot,
  advancePhase,
};
