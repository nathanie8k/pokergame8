// Standalone betting-round turn-rotation engine.
//
// Pins down the off-by-one bug from the original BettingRound snippet:
//   `moveToNextPlayer` was a `do { ... } while (isFolded)` loop with an
//   `attempts > players.length` safety break. The bug is that the loop
//   can land back on the same player we started from when every other
//   seat is folded/all-in/sat-out — handing the just-acted seat another
//   turn and freezing the engine.
//
// The fix has three parts:
//   1. `nextActingPlayer(from)` uses a strict `i < n` loop (not `i <= n`),
//      so it never returns `from` itself. It returns -1 when nobody else
//      can act.
//   2. Round completion is decided by an independent predicate
//      (`isRoundComplete`) instead of being inferred from the skip
//      iterator. A round is complete when every acting player has had a
//      chance to act since the last aggressor placed a bet AND all
//      acting players are matched.
//   3. The "acted since last bet" rule resets every time `BET`/`RAISE`
//      establishes a new bet level, so a fresh raise re-opens the round
//      exactly once.
//
// This matches the production engine's `nextActivePlayer` +
// `bettingRoundComplete` pattern (see src/poker.js).

'use strict';

class BettingRound {
  constructor(players, opts) {
    opts = opts || {};
    this.players = players;

    const firstIdx = players.findIndex(
      (p) => p && !p.isFolded && !p.allIn && !p.satOut
    );
    this.firstActorIndex = firstIdx === -1 ? 0 : firstIdx;
    this.currentIndex = this.firstActorIndex;
    // Closer: the seat the round naturally closes on once action winds
    // back. Defaults to the first actor. Callers can override (e.g. for
    // preflop BB or postflop button closer semantics).
    this.closerIndex = (typeof opts.closerIndex === 'number'
      && opts.closerIndex >= 0
      && opts.closerIndex < players.length)
      ? opts.closerIndex
      : this.firstActorIndex;

    this.currentHighestBet = 0;
    this.lastAggressorIndex = -1;
    // Player INDICES that have acted since the last bet. Empty at start;
    // handlePlayerAction adds the current actor and resets the set on
    // every `BET`/`RAISE`.
    this.actedSinceBet = new Set();
  }

  // Returns the next seat that can act after `from`, strictly skipping
  // `from` itself (so a player never gets two consecutive turns).
  // Returns -1 when nobody else can act.
  nextActingPlayer(from) {
    const n = this.players.length;
    for (let i = 1; i < n; i++) {
      const idx = (from + i) % n;
      const p = this.players[idx];
      if (p && !p.isFolded && !p.allIn && !p.satOut) return idx;
    }
    return -1;
  }

  // A betting round is complete when either:
  //   (a) every seat is folded/all-in/sat-out; OR
  //   (b) every acting player has matched `currentHighestBet` AND every
  //       acting player has acted at least once since the last aggressor
  //       raised the bet.
  isRoundComplete() {
    // Single pass to build (player, idx) pairs - avoids the O(n²)
    // indexOf round-trip you'd get from filtering then calling
    // `this.players.indexOf(p)` to look up each player's index.
    const acting = [];
    for (let i = 0; i < this.players.length; i++) {
      const p = this.players[i];
      if (p && !p.isFolded && !p.allIn && !p.satOut) acting.push([p, i]);
    }
    if (acting.length === 0) return true;
    const allMatched = acting.every(([p]) => p.currentBet === this.currentHighestBet);
    if (!allMatched) return false;
    return acting.every(([, i]) => this.actedSinceBet.has(i));
  }

  handlePlayerAction(action, amount = 0) {
    const player = this.players[this.currentIndex];
    if (!player) return { ok: false, error: 'No player' };
    if (player.isFolded || player.allIn || player.satOut) {
      return { ok: false, error: 'Cannot act' };
    }

    // Normalize stack once per action: undefined/null → 0 (no chips).
    const stack = typeof player.stack === 'number' ? player.stack : 0;

    switch (action) {
      case 'FOLD':
        player.isFolded = true;
        break;

      case 'CHECK':
        if (player.currentBet !== this.currentHighestBet) {
          return { ok: false, error: 'Cannot check' };
        }
        break;

      case 'CALL': {
        const toPay = this.currentHighestBet - player.currentBet;
        if (toPay <= 0) return { ok: false, error: 'Nothing to call' };
        if (stack < toPay) return { ok: false, error: 'Not enough chips' };
        player.currentBet = this.currentHighestBet;
        player.stack = stack - toPay;
        break;
      }

      case 'BET': {
        if (this.currentHighestBet !== 0) return { ok: false, error: 'Use raise' };
        if (amount <= 0) return { ok: false, error: 'Invalid amount' };
        const delta = amount - player.currentBet;
        if (stack < delta) return { ok: false, error: 'Not enough chips' };
        player.currentBet = amount;
        player.stack = stack - delta;
        this.currentHighestBet = amount;
        this.lastAggressorIndex = this.currentIndex;
        break;
      }

      case 'RAISE': {
        if (this.currentHighestBet === 0) return { ok: false, error: 'Use bet' };
        if (amount <= this.currentHighestBet) {
          return { ok: false, error: 'Must exceed current bet' };
        }
        const delta = amount - player.currentBet;
        if (stack < delta) return { ok: false, error: 'Not enough chips' };
        player.currentBet = amount;
        player.stack = stack - delta;
        this.currentHighestBet = amount;
        this.lastAggressorIndex = this.currentIndex;
        break;
      }

      default:
        return { ok: false, error: 'Unknown action' };
    }

    // After a successful action: track who acted since the last bet.
    // A `BET` / `RAISE` resets the set to just the current actor (only
    // they have acted on the new bet level).
    if (action === 'BET' || action === 'RAISE') {
      this.actedSinceBet = new Set([this.currentIndex]);
    } else {
      this.actedSinceBet.add(this.currentIndex);
    }

    if (this.isRoundComplete()) {
      return { ok: true, complete: true };
    }
    const next = this.nextActingPlayer(this.currentIndex);
    if (next === -1) {
      // Safety: nothing else can act. Round must close (e.g. only one
      // acting player remains and they just acted).
      return { ok: true, complete: true };
    }
    this.currentIndex = next;
    return { ok: true, complete: false };
  }
}

module.exports = { BettingRound };
