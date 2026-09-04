'use strict';

const assert = require('assert');
const { RoomManager, loadPersistedSettingsIntoCache } = require('../src/rooms');

loadPersistedSettingsIntoCache([]);
const rooms = new RoomManager();
const table = rooms.createTable({ name: 'VIP Test', maxSeats: 2, minPoints: 500 });
assert.strictEqual(table.minPoints, 500);
assert.strictEqual(rooms.listTables()[0].minPoints, 500);
assert.strictEqual(rooms.findEmptySeat(table.id), 0);

const player = { id: 'p1', name: 'Alice', points: 700, profilePhoto: 'data:image/png;base64,AAAA' };
assert.deepStrictEqual(rooms.seatPlayer(table.id, 0, player), { ok: true, seatIdx: 0 });
assert.strictEqual(table.seats[0].avatar, player.profilePhoto);
assert.strictEqual(rooms.findEmptySeat(table.id), 1);
assert.strictEqual(rooms.seatPlayer(table.id, 0, { id: 'p2', name: 'Bob', points: 700 }).ok, false);

loadPersistedSettingsIntoCache([{ name: 'Persisted', minPoints: 900, smallBlind: 10, bigBlind: 20, startingStack: 1000, houseFeePercent: 5, maxSeats: 6 }]);
const persisted = rooms.createTable({ name: 'Persisted' });
assert.strictEqual(persisted.minPoints, 900);
assert.strictEqual(rooms.listTables().find(t => t.id === persisted.id).minPoints, 900);

console.log('room feature tests: passed');
