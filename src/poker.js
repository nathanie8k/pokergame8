// Texas Hold'em poker engine.
// Provides: deck creation/shuffling, hand evaluation (best 5 of 7 cards), and the
// full game state machine (blinds, betting rounds, showdown).
//
// A card is { rank: 2..14 (14 = Ace), suit: 's'|'h'|'d'|'c' }.

'use strict';

const showdown = require('./showdown');

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

// ----- Hand evaluation (LEGACY: kept for backwards compat with tests) -----
//
// These helpers (`evaluate5`, `evaluate7`, `compareHands`, `handRankName`,
// `determineWinners`, `rankCounts`, `combinations`) are no longer on the
// live showdown critical path — `resolveShowdown` now delegates to
// `src/showdown.js` (which uses the `pokersolver` npm package). They're
// still exported so the existing engine tests can poke at the legacy
// implementation while we transition the suite; the public surface these
// helpers rely on is stable enough that nothing in tests/ has needed to
// change. New code should use `showdown.determineShowdown` from
// `src/showdown.js` instead.
//
// Categories originally returned by `evaluate5`: 9 SF, 8 quads, 7 full
// house, 6 flush, 5 straight, 4 trips, 3 two pair, 2 pair, 1 high card.
// `compareHands(a, b)` compares two rank tuples lexicographically.

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
    // Per-table "house fee" — a percentage (0..100) of every paid-out
    // pot that the engine siphons off into `table._pendingHouseFees`.
    // The server's scheduleNextHand flushes that accumulator to the
    // admin user via `db.creditHousePoints`. Default 0 keeps the
    // friendly-game feel; the admin panel exposes it as an editable
    // slider / number input. The cap (50%) is enforced both server-side
    // in db.validateTableSettings and at the engine layer below.
    // Default 5% per user spec: every settled hand takes a 5% cut from
    // the pot. Hosts can dial it down to 0 (no rake) or up to 50% via the
    // admin panel's per-table editor. Without this default, freshly
    // created custom tables AND the default tables would silently have
    // a 0% fee on cold boot — meaning `awardPot`'s fast-path branch
    // fires, `_pendingHouseFees` stays at 0, and `db.creditHousePoints`
    // is never invoked. The result was a HouseRake doc that never
    // existed. Matches src/rooms.js#DEFAULT_TABLES (5% across the board).
    houseFeePercent: clampPercent(opts.houseFeePercent, 0, 50, 5),
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
    // Accumulator that `awardPot` adds to on every settled hand and
    // `scheduleNextHand` flushes via `db.creditHousePoints`. Stay on the
    // table object (not a global) so multi-table house-routing serialises
    // cleanly per-table — admin sees a per-table `pendingHouseFees`
    // value via the admin panel too.
    _pendingHouseFees: 0,
  };
}

// Local helper: clamp `value` into [lo, hi] as a half-open range,
// defaulting to `fallback` when value is non-finite. Mirrors
// `db.clampInt/clampFloat` semantically without taking a hard dep on
// the database module (the engine has to stay callable without mongo
// in unit tests).
function clampPercent(value, lo, hi, fallback) {
  const n = parseFloat(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, n));
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

// Returns true when the seat at `seatIdx` can legally check (current
// bet is fully matched — nothing left to call). Used by the auto-fold
// turn timer to prefer check over fold for disconnected/idle players.
function canCheck(table, seatIdx) {
  const seat = table.seats[seatIdx];
  if (!seat || seat.removed || seat.folded || seat.allIn || seat.satOut) return false;
  if (table.phase === PHASE.WAITING || table.phase === PHASE.HAND_OVER) return false;
  return (table.currentBet - seat.contributed) <= 0;
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
  // `acted` is the per-round flag (reset at every `beginBettingRound`)
  // that tells the round-close predicate whether this seat has had a
  // turn in the current betting round. Posting blinds does NOT mark
  // `acted` — BB still gets the option post-limp. Reset here for safety
  // so a hand that started from a recycled seat doesn't carry stale
  // acted=true from a prior round.
  for (let i = 0; i < table.seats.length; i++) {
    const s = table.seats[i];
    if (!s) continue;
    s.holeCards = [];
    s.folded = false;
    s.contributed = 0;
    s.allIn = false;
    s.acted = false;
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
  // Reset every active seat's per-round `acted` flag so the round-close
  // predicate starts fresh for the new street. Posters of blinds are NOT
  // exempt — BB still needs an option after a limp-around.
  for (const s of table.seats) {
    if (!s) continue;
    s.contributed = 0;
    s.acted = false;
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

  // Mark this seat as having taken a turn in the current betting round.
  // Posting blinds does NOT mark `acted` (postBlind doesn't call this
  // function), so the BB still gets the option after a limp-around. Set
  // here so the close predicate below sees `acted=true` for the actor
  // without waiting for the next iteration. Validation rejections
  // (e.g. "Not your turn", "Cannot act") return BEFORE reaching here, so
  // a failed action never spuriously marks `acted`.
  seat.acted = true;

  // End-of-round check.
  // A round is complete when:
  //   (a) At most one live player is left (everyone else folded), OR
  //   (b) Every currently-acting player has matched the current bet AND
  //       has taken a turn this round (`seat.acted`). The per-seat
  //       `acted` flag is the round close trigger we use in place of the
  //       previous “seatIdx === table.lastAggressor” check. That old
  //       check forced the original aggressor to “check” themselves
  //       after every caller matched — the user could CALL, but the
  //       round would not advance until the raiser re-acted with
  //       pay=0. Tracking `acted` instead closes the round the moment
  //       everyone has had a turn AND matched the bet, which is the
  //       natural Texas-Hold'em semantics (raises re-open, calls
  //       close-as-soon-as-matched).
  const liveCount = countLivePlayers(table);
  const acting = table.seats.filter(s => s && !s.removed && !s.folded && !s.allIn && !s.satOut);
  const allActedAndMatched = acting.every(
    s => s.acted && s.contributed === table.currentBet
  );

  if (liveCount <= 1) {
    advancePhase(table);
  } else if (allActedAndMatched) {
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
  // Split the pot between the winner(s) and the house fee accumulator.
  // Two implementations are possible and we previously had the PER-WINNER
  // flavour; we now use TOTAL-FIRST per user spec ("rake should be
  // calculated once from the total pot before the remaining amount is
  // split among tied winners -- don't take 5% of each winner's share
  // separately").
  //
  //   PER-WINNER:  rake = sum(floor(share_i * feePercent / 100)) for each
  //                winner. UNDER-COLLECTS in N-way ties because the
  //                floor-discarded remainder bits across winners add up.
  //                Unfit for the user spec. Replaced.
  //   TOTAL-FIRST: rake = floor(sum(share_i) * feePercent / 100). Matches
  //                the spec verbatim. Chip conservation:
  //                  sum(payouts) + totalRake === sum(amounts)
  //                holds exactly under integer arithmetic.
  //
  // Connectivity to scheduleNextHand: that handler reads
  // _pendingHouseFees AFTER awardPot (and AFTER checkBustedRefund
  // zeroes it), then calls db.creditHousePoints to credit the HouseRake
  // doc. HouseRake is a dedicated non-playing ledger account --
  // register/admin_remove reject the name as a player identity. The
  // engine doesn't take a hard dep on the DB layer; the accumulator
  // simply accumulates across awardPot calls within a session.
  const feePercent = table.houseFeePercent || 0;
  let totalFees = 0;
  const payouts = new Array(winnerSeats.length);
  if (feePercent <= 0) {
    // Fast path: no fee. Re-distribute any uneven caller-supplied
    // amounts[] evenly among winners (last un-rounded chip goes to the
    // first winner, matching the standard odd-chip convention) so
    // chip conservation holds for 0% too.
    const totalPot = amounts.reduce((a, b) => a + b, 0);
    const baseShare = Math.floor(totalPot / winnerSeats.length);
    const remainder = totalPot - baseShare * winnerSeats.length;
    for (let i = 0; i < winnerSeats.length; i++) {
      payouts[i] = baseShare + (i === 0 ? remainder : 0);
      winnerSeats[i].stack += payouts[i];
    }
  } else {
    // Spec-compliant total-first rake. We IGNORE the caller's amounts[]
    // partition and re-distribute the post-rake remainder evenly.
    const totalPot = amounts.reduce((a, b) => a + b, 0);
    const totalRake = Math.floor(totalPot * feePercent / 100);
    const remaining = totalPot - totalRake;
    const baseShare = Math.floor(remaining / winnerSeats.length);
    const remainder = remaining - baseShare * winnerSeats.length;
    for (let i = 0; i < winnerSeats.length; i++) {
      // First winner absorbs the leftover remainder (matches the
      // odd-chip convention elsewhere in this engine, incl.
      // resolveShowdown's pre-rake distribution).
      payouts[i] = baseShare + (i === 0 ? remainder : 0);
      winnerSeats[i].stack += payouts[i];
    }
    if (totalRake > 0) {
      table._pendingHouseFees = (table._pendingHouseFees || 0) + totalRake;
    }
    totalFees = totalRake;
  }
  // Resolve display hand name + the share each winner actually receives
  // (post-fee). If a storedHandName has been precomputed (multi-way
  // showdown or single-winner post-river), use it. Otherwise the winner
  // took the pot by fold-out and we have an unknown hand - just say so.
  table.lastHandResults = {
    winners: winnerSeats.map((s, i) => ({
      id: s.playerId,
      name: s.name,
      handName: s.storedHandName || 'Won by fold',
      share: payouts[i],
    })),
    // Exposed so the admin panel can show "this hand paid X to the
    // house" without needing to peek at table._pendingHouseFees (which
    // is a server-only field).
    houseFee: totalFees,
  };
}

// Engine-level helper: read + reset the table's pending house fees.
// Called from server.js#scheduleNextHand after the per-hand
// saveStacksToDB so the house-fee routing doesn't race with the
// stacks-to-DB write on the same hand. Returns the fees that
// accumulated this hand (could be 0 for a no-fee table or a folded
// hand); the table's accumulator is reset to 0 unconditionally so
// the next hand starts from a clean slate.
function collectPendingHouseFees(table) {
  if (!table) return 0;
  const pending = table._pendingHouseFees || 0;
  table._pendingHouseFees = 0;
  return pending;
}

function resolveShowdown(table) {
  // Determine per-player hand info, find winners, award.
  //
  // Live evaluation path: `src/showdown.js` (pokersolver-backed). The
  // engine previously ran its own `evaluate7` over every seat's 7 cards;
  // that helper is now kept only as a legacy fallback (see the LEGACY
  // comment near `evaluate5` above). The new module gives us proper
  // straight/flush recognition out of the box and returns a descriptive
  // hand name (e.g. "Straight, Nine High", "Two Pair, Aces and Kings")
  // that we attach to each seat's `storedHandName` so the client HUD
  // and showdown modal can render it verbatim.
  const live = table.seats.filter(s => s && !s.removed && !s.folded);
  if (live.length === 0) {
    table.phase = PHASE.HAND_OVER;
    table.currentPlayerIndex = -1;
    return;
  }
  if (live.length === 1) {
    // Single live player at showdown (rare turn/river run-out that left
    // everyone else all-in-then-folded, or heads-up where both went
    // all-in and only one remains active for showdown purposes). Evaluate
    // their hand for the result banner via the new module; only call when
    // we have all 7 cards in scope.
    const winner = live[0];
    if (table.communityCards.length === 5 && winner.holeCards.length === 2) {
      winner.storedHandName = showdown.solvePlayerHand(
        winner.holeCards,
        table.communityCards
      ).descr;
    }
    awardPot(table, [winner], [table.pot]);
    table.phase = PHASE.HAND_OVER;
    table.currentPlayerIndex = -1;
    return;
  }
  // Multi-way showdown: delegate winner determination + per-seat hand-descr
  // to the live module. `winningHoleIds` is the array of winning player
  // ids in evaluation order; ties yield multiple winners (split pot).
  // `evaluations` covers every non-folded seat (winners AND losers) so
  // the client can render every player's best-hand name on the showdown
  // modal even if they lost.
  const players = live.map(s => ({
    id: s.playerId,
    holeCards: s.holeCards,
  }));
  const { evaluations, winningHoleIds } = showdown.determineShowdown(
    players, table.communityCards
  );
  // Attach display name onto every seat (winners + losers) before
  // awarding, so the client modal has them ready via publicView's
  // `storedHandName` field.
  for (const e of evaluations) {
    const seat = live.find(s => s.playerId === e.id);
    if (seat) seat.storedHandName = e.handDescr;
  }
  const winnerSeats = winningHoleIds
    .map(id => live.find(s => s.playerId === id))
    .filter(Boolean);
  const share = Math.floor(table.pot / winnerSeats.length);
  const amounts = winnerSeats.map(() => share);
  // Award any remainder (uneven split) to the first winner (closest
  // left of the button wins odd chips in standard rules).
  const remainder = table.pot - share * winnerSeats.length;
  if (remainder > 0) amounts[0] += remainder;
  awardPot(table, winnerSeats, amounts);
  table.winners = winnerSeats.map(s => s.playerId);
  table.winnerNames = winnerSeats.map(s => s.name);
  table.winnerHandNames = winnerSeats.map(s => s.storedHandName || '');
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
  // Busted-refund also zeros out any pending house credit: paying the
  // house a fee for a hand the engine just voided would defeat the
  // fairness invariant. Without this line, awardPot's `_pendingHouseFees`
  // accumulator would still hold the freshly-routed fees whose source
  // hand is now refunded, and scheduleNextHand would still credit
  // them to the admin user. The fairness rule is "if the hand is
  // voided, no one's chip count moves" — including the house's.
  table._pendingHouseFees = 0;
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
    s.acted = false;
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

// Single canonical exports. checkBustedRefund is exported so the test suite
// can drive busted-refund side effects on _pendingHouseFees without running
// a full hand.
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
  checkBustedRefund,
  collectPendingHouseFees,
  canCheck,
};
