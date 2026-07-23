// In-memory table management for FriendLy Poker.
//
// Holds the authoritative game state for every active table. Player persisted
// data (points, name, etc.) lives in `database.js`; only the table/session
// state is kept here.

'use strict';

const poker = require('./poker');

// ----- Default tables -----
//
// Five permanent tables with increasing stakes. Created on server startup
// (see `ensureDefaultTables`) and excluded from auto-deletion so the lobby
// always has at least one entry at every stakes tier — even when empty.
const DEFAULT_TABLES = [
  { name: 'Beginners Table', smallBlind: 5,   bigBlind: 10  },
  { name: 'Low Stakes',      smallBlind: 25,  bigBlind: 50  },
  { name: 'Medium Stakes',   smallBlind: 50,  bigBlind: 100 },
  { name: 'High Stakes',     smallBlind: 100, bigBlind: 200 },
  { name: 'VIP',             smallBlind: 250, bigBlind: 500 },
];

class RoomManager {
  constructor() {
    this.tables = new Map();          // tableId -> table
    this.idCounter = 1;
    this.nextHandTimers = new Map();  // tableId -> Timeout
  }

  listTables() {
    return Array.from(this.tables.values()).map((t) => ({
      id: t.id,
      name: t.name,
      smallBlind: t.smallBlind,
      bigBlind: t.bigBlind,
      maxSeats: t.maxSeats,
      seatsTaken: t.seats.filter((s) => s && !s.removed).length,
      phase: t.phase,
      handNumber: t.handNumber,
      handInProgress: ![poker.PHASE.WAITING, poker.PHASE.HAND_OVER].includes(t.phase),
    }));
  }

  createTable({ name, smallBlind, bigBlind, maxSeats, startingStack }) {
    const id = 't' + (this.idCounter++);
    const table = poker.createTable({
      id,
      name: name || 'Table ' + id,
      smallBlind,
      bigBlind,
      startingStack,
      maxSeats,
    });
    table.chatMessages = [];
    this.tables.set(id, table);
    return table;
  }

  get(tableId) { return this.tables.get(tableId) || null; }
  has(tableId) { return this.tables.has(tableId); }
  remove(tableId) {
    const t = this.nextHandTimers.get(tableId);
    if (t) { clearTimeout(t); this.nextHandTimers.delete(tableId); }
    this.tables.delete(tableId);
  }

  // Returns true when `table` should be auto-deleted at the end of a hand:
  // every seat is empty AND the table is not one of the permanent default
  // starter tables. Default tables stay in the lobby even with zero players.
  // Intentional mirror of the scheduleNextHand branch in server.js — kept
  // here so the rule lives next to the lifecycle primitives it depends on
  // and the test suite can call it directly.
  shouldDeleteAfterHand(table) {
    if (!table) return false;
    if (table.default) return false;
    for (const s of table.seats) if (s) return false;
    return true;
  }

  // Idempotent: creates any of `DEFAULT_TABLES` that are missing. Each
  // created table is marked with `default = true` so the auto-delete path
  // in server.js can tell it apart from user-created tables. Never re-tags
  // pre-existing same-named tables — that would silently promote a
  // user-created table to permanent status.
  ensureDefaultTables() {
    const have = new Set(Array.from(this.tables.values()).map((t) => t.name));
    for (const cfg of DEFAULT_TABLES) {
      if (have.has(cfg.name)) continue;
      const t = this.createTable({
        name: cfg.name,
        smallBlind: cfg.smallBlind,
        bigBlind: cfg.bigBlind,
        maxSeats: 6,
      });
      t.default = true;
    }
  }

  // Append a user chat message. Newlines are stripped to single spaces so a
  // paste with embedded line breaks can't push other messages out of the
  // visible scroll. History is capped at the most recent 100 entries to
  // bound memory; older messages fall off via FIFO splice.
  addChatMessage(tableId, from, text) {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, error: 'No such table' };
    if (typeof text !== 'string') return { ok: false, error: 'Invalid message' };
    const clean = text.replace(/[\r\n]+/g, ' ').trim();
    if (!clean) return { ok: false, error: 'Empty message' };
    if (!t.chatMessages) t.chatMessages = [];
    t.chatMessages.push({ from, text: clean.slice(0, 200), ts: Date.now(), kind: 'user' });
    if (t.chatMessages.length > 100) {
      t.chatMessages.splice(0, t.chatMessages.length - 100);
    }
    return { ok: true };
  }

  // Append a system message (e.g. "X joined"). Same newline stripping +
  // 100-cap as user messages. Kept here as a primitive even if server.js
  // doesn't currently call it; tests cover it and future "join/leave" system
  // lines can plug in without a server round-trip.
  addSystemMessage(tableId, text) {
    const t = this.tables.get(tableId);
    if (!t) return false;
    const clean = String(text == null ? '' : text).replace(/[\r\n]+/g, ' ').trim();
    if (!clean) return false;
    if (!t.chatMessages) t.chatMessages = [];
    t.chatMessages.push({ text: clean, ts: Date.now(), kind: 'system' });
    if (t.chatMessages.length > 100) {
      t.chatMessages.splice(0, t.chatMessages.length - 100);
    }
    return true;
  }

  chatHistory(tableId) {
    const t = this.tables.get(tableId);
    if (!t) return [];
    if (!t.chatMessages) t.chatMessages = [];
    return t.chatMessages;
  }

  // Reset chat history when the table becomes empty — no live (non-removed)
  // seated player remains. The chat belongs to the current session of
  // players; when the session ends (everyone left / disconnected /
  // busted), the history is wiped so the next session starts blank. Called
  // from server.js#unseat, the disconnect handler, and scheduleNextHand
  // before the auto-delete branch.
  clearChatIfEmpty(tableId) {
    const t = this.tables.get(tableId);
    if (!t) return false;
    const hasLivePlayer = t.seats.some((s) => s && !s.removed);
    if (hasLivePlayer) return false;
    if (!t.chatMessages || t.chatMessages.length === 0) return false;
    t.chatMessages = [];
    return true;
  }

  // Find an empty seat on the table, return its index or -1.
  findEmptySeat(tableId) {
    const t = this.tables.get(tableId);
    if (!t) return -1;
    for (let i = 0; i < t.seats.length; i++) {
      if (!t.seats[i] || t.seats[i].removed) return i;
    }
    return -1;
  }

  seatPlayer(tableId, seatIdx, player) {
    const t = this.tables.get(tableId);
    if (!t) return { ok: false, error: 'No such table' };
    if (seatIdx < 0 || seatIdx >= t.seats.length) return { ok: false, error: 'Bad seat' };
    // Removed seats are reclaimable: they linger as non-null after a mid-hand
    // disconnect leaves the table mid-hand, or after endHand flags a busted
    // player's seat removed=true. findEmptySeat already considers them empty,
    // and the lobby's seatsTaken count filters them out, so the take-check
    // must agree — otherwise a player sees "0 seats" in the lobby but gets
    // "Seat taken" when clicking Join. The new seat object below overwrites
    // the stale entry wholesale (removed: false in particular), so nothing
    // leaks from the previous occupant.
    if (t.seats[seatIdx] && !t.seats[seatIdx].removed) return { ok: false, error: 'Seat taken' };
    // If the seat was mid-hand-leaved before this reclaim, drop the stale
    // _pendingUnseat entry: finishPendingUnseat runs at HAND_OVER and
    // nulls a seat only when its `removed` is still true. The new occupant
    // has removed=false, so the old index would silently leak in the array
    // forever. Filter the entry we just claimed out so the array stays
    // accurate.
    if (t._pendingUnseat && t._pendingUnseat.includes(seatIdx)) {
      t._pendingUnseat = t._pendingUnseat.filter((i) => i !== seatIdx);
    }
    t.seats[seatIdx] = {
      playerId: player.id,
      name: player.name,
      stack: player.points,         // points become table chips
      holeCards: [],
      folded: false,
      allIn: false,
      removed: false,
      satOut: false,
      disconnected: false,
      contributed: 0,
      storedHandName: null,
    };
    return { ok: true, seatIdx };
  }

  unseat(tableId, seatIdx) {
    const t = this.tables.get(tableId);
    if (!t) return false;
    if (seatIdx < 0 || seatIdx >= t.seats.length) return false;
    if (!t.seats[seatIdx]) return false;
    // If mid-hand, mark folded so the seat is treated as out for the hand.
    if (t.phase !== poker.PHASE.WAITING && t.phase !== poker.PHASE.HAND_OVER) {
      t.seats[seatIdx].folded = true;
      t.seats[seatIdx].removed = true;
      // Schedule actual seat clear after the hand ends.
      const idx = seatIdx;
      t._pendingUnseat = t._pendingUnseat || [];
      t._pendingUnseat.push(idx);
    } else {
      t.seats[seatIdx] = null;
    }
    return true;
  }

  finishPendingUnseats(table) {
    if (!table._pendingUnseat) return;
    for (const idx of table._pendingUnseat) {
      if (table.seats[idx] && table.seats[idx].removed) table.seats[idx] = null;
    }
    table._pendingUnseat = [];
  }

  // Build a serializable public view of the table for the viewer.
  // Their own hole cards are included; others are nulled out.
  // NOTE: viewerPlayerId is the viewer's database player id (NOT their display
  // name). Each seat has `playerId: player.id` (set in `seatPlayer`), so
  // server.js broadcasts must pass `socket.data.player.id` here — passing the
  // name made `isSelf` always evaluate false for every viewer, which silently
  // hid the viewer's own hole cards AND disabled their action bar.
  publicView(tableId, viewerPlayerId) {
    const t = this.tables.get(tableId);
    if (!t) return null;
    return {
      id: t.id,
      name: t.name,
      smallBlind: t.smallBlind,
      bigBlind: t.bigBlind,
      maxSeats: t.maxSeats,
      phase: t.phase,
      handNumber: t.handNumber,
      communityCards: t.communityCards.map(serializeCard),
      pot: t.pot,
      currentBet: t.currentBet,
      minRaise: t.minRaise,
      currentPlayerIndex: t.currentPlayerIndex,
      buttonIndex: t.buttonIndex,
      sbIndex: t.sbIndex,
      bbIndex: t.bbIndex,
      lastAggressor: t.lastAggressor,
      lastHandResults: t.lastHandResults,
      chatMessages: t.chatMessages || [],
      seats: t.seats.map((s, i) => {
        if (!s) return { idx: i, occupied: false };
        const isSelf = s.playerId === viewerPlayerId;
        return {
          idx: i,
          occupied: true,
          isSelf,
          name: s.name,
          stack: s.stack,
          contributed: s.contributed,
          folded: s.folded,
          allIn: s.allIn,
          satOut: s.satOut,
          removed: s.removed,
          disconnected: s.disconnected,
          holeCards: isSelf ? s.holeCards.map(serializeCard) : null,
          storedHandName: isSelf ? s.storedHandName : null,
        };
      }),
    };
  }
}

function serializeCard(c) {
  // Server sends rank+suit to client; client does not need to know encryption.
  return { rank: c.rank, suit: c.suit };
}

module.exports = { RoomManager, DEFAULT_TABLES };
