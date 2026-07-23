// In-memory table management for FriendLy Poker.
//
// Holds the authoritative game state for every active table. Player persisted
// data (points, name, etc.) lives in `database.js`; only the table/session
// state is kept here.

'use strict';

const poker = require('./poker');

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
    if (t.seats[seatIdx]) return { ok: false, error: 'Seat taken' };
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

module.exports = { RoomManager };
