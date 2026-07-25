// Tests for the admin/host role: isAdmin field, house-points credit,
// per-table settings persistence, and admin_update_session gating.
//
// Run directly:  node tests/test_admin_role.js
//
// Mongo: spins up an ephemeral MongoDB via mongodb-memory-server
// (matching the existing test_poker.js boot sequence).

'use strict';

const { MongoMemoryServer } = require('mongodb-memory-server');

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

async function main() {
  const mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri();

  const P  = require('../src/poker.js');
  const db = require('../src/database.js');
  const { RoomManager, loadPersistedSettingsIntoCache, getCachedSettingsFor } = require('../src/rooms.js');
  await db.connect();
  await db.resetForTests();

  // ====================================================================
  // 1. Player schema: isAdmin defaults to false
  // ====================================================================
  {
    const alice = await db.getOrCreatePlayer('Alice');
    ok(alice && alice.isAdmin === false,
      'getOrCreatePlayer: brand-new player has isAdmin default = false');
  }

  {
    // Can opt in to isAdmin via getOrCreatePlayer(opts.isAdmin=true), the
    // helper path for tests + setup scripts. Production code paths leave
    // it default.
    const adminA = await db.getOrCreatePlayer('AdminA', { isAdmin: true });
    ok(adminA && adminA.isAdmin === true,
      'getOrCreatePlayer({isAdmin: true}): opts respected on first create');
    // Calling again with the same name returns existing doc (no flip).
    const reread = await db.getOrCreatePlayer('AdminA');
    ok(reread && reread.isAdmin === true,
      'getOrCreatePlayer: reregistering same name returns existing isAdmin value');
  }

  {
    // setUserAdmin: manual flip via the dedicated helper. The user
    // "manually set this to true for myself directly in the database/"
    // admin panel" path in the spec.
    const bob = await db.getOrCreatePlayer('Bob');
    ok(bob && bob.isAdmin === false, 'Bob starts isAdmin=false');
    const flipped = await db.setUserAdmin('Bob', true);
    ok(flipped && flipped.isAdmin === true,
      'setUserAdmin: flips Bob isAdmin to true');
    const reflip = await db.setUserAdmin('Bob', false);
    ok(reflip && reflip.isAdmin === false,
      'setUserAdmin: flips Bob isAdmin back to false');
  }

  // ====================================================================
  // 2. getAdminPlayers / getPrimaryAdminPlayer
  // ====================================================================
  {
    await db.resetForTests();
    // setUserAdmin mutates an existing Player doc — it does NOT
    // upsert. Tests must create the Player first via getOrCreatePlayer.
    await db.getOrCreatePlayer('Alice');
    await db.getOrCreatePlayer('Bob');
    await db.getOrCreatePlayer('Carol');
    await db.setUserAdmin('Alice', true);
    await db.setUserAdmin('Bob',   true);
    await db.setUserAdmin('Carol', true);
    await db.setUserAdmin('Carol', false); // flip Carol back to non-admin
    const admins = await db.getAdminPlayers();
    eq(admins.map((p) => p.name).sort(), ['Alice', 'Bob'],
      'getAdminPlayers returns exactly the isAdmin=true players');
    const primary = await db.getPrimaryAdminPlayer();
    eq((primary && primary.name) || null, 'Alice',
      'getPrimaryAdminPlayer picks the lexicographically first admin');
  }

  {
    await db.resetForTests();
    const none = await db.getAdminPlayers();
    eq(none, [], 'getAdminPlayers returns [] when no admin exists');
    const noPrimary = await db.getPrimaryAdminPlayer();
    eq(noPrimary, null, 'getPrimaryAdminPlayer returns null when no admin exists');
  }

  // ====================================================================
  // 3. creditHousePoints: success / no_admin / invalid amount
  // ====================================================================
  {
    await db.resetForTests();
    // Pass points:0 explicitly so the meta.startingStack=1000 default
    // doesn't leak into this section's "balance stays at 0 on invalid
    // credit" assertion below.
    await db.getOrCreatePlayer('Admin', { points: 0 });
    await db.setUserAdmin('Admin', true);
    const r = await db.creditHousePoints(50);
    ok(r.ok === true, 'creditHousePoints: ok=true when admin exists');
    eq(r.credited, 50, 'creditHousePoints: credited=50');
    eq(r.adminName, 'Admin', 'creditHousePoints: adminName=Admin');
    eq(r.newBalance, 50,
       'creditHousePoints: newBalance = 0 + 50 = 50 (admin started at 0)');
    const admin = await db.getPrimaryAdminPlayer();
    ok(admin && admin.points === 50,
       'creditHousePoints: admin Player.points was atomically incremented');
  }

  {
    await db.resetForTests();
    // No admin -> drops credits silently (logs in production).
    const r = await db.creditHousePoints(50);
    ok(r.ok === false && r.reason === 'no_admin',
       'creditHousePoints: returns {ok:false, reason:"no_admin"} when no admin');
    eq(r.credited, 0, 'creditHousePoints: credits = 0 on no_admin');
  }

  {
    await db.resetForTests();
    // Set isAdmin+points at creation time so we don't depend on the
    // setUserAdmin findOneAndUpdate path (which is a separate writing
    // op and historically had a race against getPrimaryAdminPlayer
    // reads after resetForTests).
    await db.getOrCreatePlayer('Admin', { isAdmin: true, points: 0 });
    const r0   = await db.creditHousePoints(0);
    ok(r0.ok === false && r0.reason === 'invalid_amount',
       'creditHousePoints: 0 is invalid');
    const rNeg = await db.creditHousePoints(-10);
    ok(rNeg.ok === false && rNeg.reason === 'invalid_amount',
       'creditHousePoints: negative is invalid');
    const rNaN = await db.creditHousePoints('fifty');
    ok(rNaN.ok === false && rNaN.reason === 'invalid_amount',
       'creditHousePoints: non-number is invalid');
    const rInf = await db.creditHousePoints(Infinity);
    ok(rInf.ok === false && rInf.reason === 'invalid_amount',
       'creditHousePoints: Infinity is invalid');
    const admin = await db.getPrimaryAdminPlayer();
    ok(admin && admin.points === 0,
       'creditHousePoints: invalid amount leaves admin balance alone (started=0)');
  }

  {
    // Atomic concurrent credits: ten parallel creditHousePoints calls
    // accumulate without lost updates (Mongo per-document serialization).
    await db.resetForTests();
    await db.getOrCreatePlayer('Admin', { isAdmin: true, points: 0 });
    const racers = [];
    for (let i = 0; i < 10; i++) racers.push(db.creditHousePoints(7));
    await Promise.all(racers);
    const admin = await db.getPrimaryAdminPlayer();
    eq((admin && admin.points) || -1, 70,
       'creditHousePoints: 10 concurrent calls accumulate 70 chips (started=0, +70 = 70)');
  }

  // ====================================================================
  // 4. Table-settings persistence (get / upsert / delete / loadAll)
  // ====================================================================
  {
    await db.resetForTests();
    const noRow = await db.getTableSettings('Beginners Table');
    eq(noRow, null, 'getTableSettings returns null when no row exists');

    const upserted = await db.upsertTableSettings('Beginners Table', {
      bigBlind: 25, smallBlind: 12, startingStack: 2000,
      houseFeePercent: 5, maxSeats: 6,
    }, 'Admin');
    eq(upserted.bigBlind, 25, 'upsertTableSettings writes bigBlind');
    eq(upserted.smallBlind, 12, 'upsertTableSettings writes smallBlind');
    eq(upserted.startingStack, 2000, 'upsertTableSettings writes startingStack');
    eq(upserted.houseFeePercent, 5, 'upsertTableSettings writes houseFeePercent');
    eq(upserted.updatedBy, 'Admin', 'upsertTableSettings records updatedBy');

    const fetched = await db.getTableSettings('Beginners Table');
    eq(fetched.bigBlind, 25, 'getTableSettings reads back what was written');

    // Re-upsert overwrites
    const overwrite = await db.upsertTableSettings('Beginners Table', {
      bigBlind: 50, smallBlind: 25, startingStack: 4000,
      houseFeePercent: 10, maxSeats: 9,
    }, 'Admin');
    eq(overwrite.bigBlind, 50, 'upsertTableSettings: re-upsert overwrites bigBlind');
    eq(overwrite.houseFeePercent, 10, 'upsertTableSettings: re-upsert overwrites fee');

    // loadAll TableSettings returns our row
    const all = await db.loadAllTableSettings();
    ok(Array.isArray(all) && all.length === 1,
       'loadAllTableSettings returns the one row');

    const deleted = await db.deleteTableSettings('Beginners Table');
    ok(deleted === true, 'deleteTableSettings returns true on success');
    const afterDelete = await db.getTableSettings('Beginners Table');
    eq(afterDelete, null, 'deleteTableSettings wipes the row');
  }

  // ====================================================================
  // 5. validateTableSettings: clamping + SB < BB invariant
  // ====================================================================
  {
    const fb = { bigBlind: 10, smallBlind: 5, startingStack: 1000,
                  houseFeePercent: 0, maxSeats: 6 };
    const v = db.validateTableSettings({
      bigBlind: 50, smallBlind: 25, startingStack: 1500,
      houseFeePercent: 7, maxSeats: 8,
    }, fb);
    eq(v.bigBlind, 50,        'validateTableSettings accepts 50 BB');
    eq(v.smallBlind, 25,      'validateTableSettings accepts 25 SB');
    eq(v.startingStack, 1500, 'validateTableSettings accepts 1500 stack');
    eq(v.houseFeePercent, 7,  'validateTableSettings accepts 7% fee');
    eq(v.maxSeats, 8,         'validateTableSettings accepts 8 seats');

    // Clamp invalid BB to fallback
    eq(db.validateTableSettings({ bigBlind: 'lol' }, fb).bigBlind, 10,
       'validateTableSettings: non-numeric BB falls back to existing value');
    // Clamp negative to 1
    eq(db.validateTableSettings({ bigBlind: -10 }, fb).bigBlind, 1,
       'validateTableSettings: negative BB clamped to 1');
    // Clamp house fee > 50% to 50
    eq(db.validateTableSettings({ houseFeePercent: 999 }, fb).houseFeePercent, 50,
       'validateTableSettings: fee > 50% clamped to 50');
    // SB >= BB invariant: SB auto-corrected to BB-1 so a degenerate
    // entry is silently fixed instead of rejected.
    const corrected = db.validateTableSettings({ bigBlind: 10, smallBlind: 10 }, fb);
    eq(corrected.smallBlind, 9,
       'validateTableSettings: SB == BB auto-corrected to BB-1');

    // Fallbacks: omitted fields fall back to fb value, not the schema default
    const partial = db.validateTableSettings({ bigBlind: 20 }, fb);
    eq(partial.bigBlind,       20,
       'validateTableSettings: explicit bigBlind kept');
    eq(partial.smallBlind,     5,
       'validateTableSettings: missing smallBlind inherits fallback');
    eq(partial.startingStack,  1000,
       'validateTableSettings: missing startingStack inherits fallback');
    eq(partial.houseFeePercent, 0,
       'validateTableSettings: missing houseFeePercent inherits fallback');
    eq(partial.maxSeats,       6,
       'validateTableSettings: missing maxSeats inherits fallback');
  }

  // ====================================================================
  // 6. poker.awardPot: house fee split + collectPendingHouseFees
  // ====================================================================
  {
    // Set up: 4-player table with stacks 1000 each, 200 chip pot on the
    // felt, no fee. Single winner takes 200.
    const t = P.createTable({ id: 'h0', bigBlind: 10, smallBlind: 5 });
    for (let i = 0; i < 4; i++) {
      t.seats[i] = {
        playerId: 'P' + i, name: 'P' + i, stack: 1000,
        holeCards: [], folded: false, allIn: false, removed: false,
        satOut: false, disconnected: false, contributed: 0, acted: false,
      };
    }
    t.pot = 200;
    t.houseFeePercent = 10;
    const winner = t.seats[0];
    P.awardPot(t, [winner], [200]);
    eq(winner.stack, 1180,
       'awardPot(10% fee): winner gets gross - feeFloor (200 - 20 = 180, +1000 = 1180)');
    eq(t._pendingHouseFees, 20,
       'awardPot(10% fee): house accumulator is gross - payout (200 - 180 = 20)');
    ok(t.lastHandResults.winners[0].share === 180,
       'awardPot: lastHandResults.share is post-fee (180)');

    // Collect + reset
    const collected = P.collectPendingHouseFees(t);
    eq(collected, 20, 'collectPendingHouseFees returns the pending total');
    eq(t._pendingHouseFees, 0,
       'collectPendingHouseFees zeroes the accumulator');
  }

  {
    // Zero fee: full payout, no house credit.
    const t = P.createTable({ id: 'h1', bigBlind: 10, smallBlind: 5 });
    for (let i = 0; i < 2; i++) {
      t.seats[i] = {
        playerId: 'P' + i, name: 'P' + i, stack: 1000,
        holeCards: [], folded: false, allIn: false, removed: false,
        satOut: false, disconnected: false, contributed: 0, acted: false,
      };
    }
    t.pot = 200;
    t.houseFeePercent = 0;
    P.awardPot(t, [t.seats[0]], [200]);
    eq(t.seats[0].stack, 1200, 'awardPot(0% fee): winner gets the full 200');
    eq(t._pendingHouseFees, 0,
       'awardPot(0% fee): nothing accumulated for the house');
    eq(t.lastHandResults.winners[0].share, 200,
       'awardPot(0% fee): share reflects full payout');

    // collectPendingHouseFees is idempotent (returns 0 once consumed)
    eq(P.collectPendingHouseFees(t), 0, 'collectPendingHouseFees is zero after first drain');
  }

  {
    // Split pot with fee: 2 winners each getting 100.
    const t = P.createTable({ id: 'h2', bigBlind: 10, smallBlind: 5 });
    for (let i = 0; i < 4; i++) {
      t.seats[i] = {
        playerId: 'P' + i, name: 'P' + i, stack: 1000,
        holeCards: [], folded: false, allIn: false, removed: false,
        satOut: false, disconnected: false, contributed: 0, acted: false,
      };
    }
    t.pot = 200;
    t.houseFeePercent = 25;
    P.awardPot(t, [t.seats[0], t.seats[1]], [100, 100]);
    // Each winner gets 75 (100 - floor(100*0.25)).
    eq(t.seats[0].stack, 1075, 'split awardPot(25% fee): winner A payout = 75');
    eq(t.seats[1].stack, 1075, 'split awardPot(25% fee): winner B payout = 75');
    eq(t._pendingHouseFees, 50,
       'split awardPot(25% fee): house accumulator = 50 total');
  }

  // ====================================================================
  // 7. poker.checkBustedRefund: clears _pendingHouseFees on void
  // ====================================================================
  {
    // Manually pre-fill _pendingHouseFees to simulate a fee that
    // accumulated this hand before the watch fires. Phase must NOT be
    // HAND_OVER (engine early-returns at the top of checkBustedRefund)
    // and must NOT be WAITING (same early-return). PRE_FLOP / FLOP /
    // TURN / RIVER all exercise the path.
    const t = P.createTable({ id: 'r0', bigBlind: 10, smallBlind: 5 });
    for (let i = 0; i < 2; i++) {
      t.seats[i] = {
        playerId: 'P' + i, name: 'P' + i, stack: 0,
        holeCards: [], folded: false, allIn: false, removed: false,
        satOut: false, disconnected: false, contributed: 0, acted: false,
      };
    }
    t._pendingHouseFees = 30;
    t.phase = P.PHASE.PRE_FLOP;
    t.pot = 0;
    P.checkBustedRefund(t);
    eq(t._pendingHouseFees, 0,
       'checkBustedRefund (PRE_FLOP phase): zeroes _pendingHouseFees');
    eq(t.phase, P.PHASE.HAND_OVER,
       'checkBustedRefund: phase flipped to HAND_OVER via the void path');
  }
  {
    // The HAND_OVER early-return: caller-of-engine semantics require
    // this — the engine calls checkBustedRefund only on non-terminal
    // phases. Pin both early-return + non-terminal paths so future
    // refactors don't silently drop one of them.
    const t = P.createTable({ id: 'r1', bigBlind: 10, smallBlind: 5 });
    for (let i = 0; i < 2; i++) {
      t.seats[i] = {
        playerId: 'P' + i, name: 'P' + i, stack: 0,
        holeCards: [], folded: false, allIn: false, removed: false,
        satOut: false, disconnected: false, contributed: 0, acted: false,
      };
    }
    t._pendingHouseFees = 30;
    t.phase = P.PHASE.HAND_OVER;
    t.pot = 0;
    P.checkBustedRefund(t);
    eq(t._pendingHouseFees, 30,
       'checkBustedRefund (HAND_OVER): early-returns without modifying fees');
  }

  // ====================================================================
  // 8. rooms.updateTableSettings: validation + cache write + mid-hand
  //    rejection + admin_update_session route
  // ====================================================================
  {
    await db.resetForTests();
    const rooms = new RoomManager();
    rooms.ensureDefaultTables();

    // Pick a default table; mid-hand edits should be rejected.
    const t = rooms.tables.get('t1');
    t.phase = P.PHASE.PRE_FLOP;
    t.smallBlind = 5; t.bigBlind = 10; t.startingStack = 1000;
    t.houseFeePercent = 0; t.maxSeats = 6;
    const midHand = rooms.updateTableSettings('t1', { bigBlind: 50 }, 'Admin');
    ok(midHand.ok === false,
       'updateTableSettings: rejects BB change mid-hand (PRE_FLOP)');

    // Move to waiting: edit accepted, in-memory AND cache updated.
    t.phase = P.PHASE.WAITING;
    const okEdit = rooms.updateTableSettings('t1', {
      bigBlind: 50, smallBlind: 25, startingStack: 2000,
      houseFeePercent: 5,
    }, 'Admin');
    ok(okEdit.ok === true, 'updateTableSettings: WAITING phase accepts edit');
    eq(t.bigBlind, 50, 'updateTableSettings: in-memory bigBlind mutated');
    eq(t.smallBlind, 25, 'updateTableSettings: in-memory smallBlind mutated');
    eq(t.startingStack, 2000, 'updateTableSettings: startingStack mutated');
    eq(t.houseFeePercent, 5, 'updateTableSettings: houseFeePercent mutated');

    // listTables now reflects the new settings for lobby cards
    const listed = rooms.listTables();
    const updated = listed.find((x) => x.id === 't1');
    eq(updated.bigBlind, 50, 'listTables surfaces the updated bigBlind');
    eq(updated.houseFeePercent, 5, 'listTables surfaces the updated fee');

    // Cache: loadPersistedSettingsIntoCache + createTable re-applies.
    // This is the cold-boot scenario — after a server restart, ensure-
    // DefaultTables runs first with an empty cache, the prime then
    // loads persisted rows, and createTable's `persisted` lookup
    // applies the cached overrides. The test mirrors the post-prime
    // path WITHOUT the lookup-from-t.something bug.
    loadPersistedSettingsIntoCache([
      { name: t.name, smallBlind: 25, bigBlind: 50,
        startingStack: 2000, houseFeePercent: 5, maxSeats: 6,
        updatedAt: Date.now(), updatedBy: 'Admin' },
    ]);
    const cachedAfterLoad = getCachedSettingsFor(t.name);
    ok(cachedAfterLoad && cachedAfterLoad.bigBlind === 50,
       'getCachedSettingsFor returns the persisted override post-prime');
    const recreated = rooms.createTable({
      name: t.name, smallBlind: 999, bigBlind: 999,
      maxSeats: 6, startingStack: 999, houseFeePercent: 99,
    });
    eq(recreated.bigBlind, 50,
       'createTable: persisted cache overrides in-memory defaults (BB = 50)');
    eq(recreated.smallBlind, 25,
       'createTable: persisted cache overrides SB');
    eq(recreated.houseFeePercent, 5,
       'createTable: persisted cache overrides fee');
  }

  // ====================================================================
  // 8b. Cold-boot reapply path: simulates server.js's
  //     primePersistedSettings().then(...) loop that the BLOCKING
  //     code-review bug first shipped. After priming the cache, calling
  //     updateTableSettings with the cache's stored snapshot must
  //     mutate the in-memory table to the cache's values — NOT
  //     re-write the (default) in-memory values back to themselves.
  // ====================================================================
  {
    await db.resetForTests();
    const rooms = new RoomManager();
    rooms.ensureDefaultTables();

    const t = rooms.tables.get('t1');
    t.phase = P.PHASE.WAITING;
    loadPersistedSettingsIntoCache([
      { name: t.name, smallBlind: 25, bigBlind: 50,
        startingStack: 2000, houseFeePercent: 5, maxSeats: 6,
        updatedAt: Date.now(), updatedBy: 'Admin' },
    ]);
    const cached = getCachedSettingsFor(t.name);
    ok(cached && cached.bigBlind === 50,
       'cold-boot: cache primed with override before reapply');
    // Same pattern server.js uses after fix: pull each field from the
    // cache, NOT from t.<field>.
    const r = rooms.updateTableSettings(t.id, {
      smallBlind:     cached.smallBlind,
      bigBlind:       cached.bigBlind,
      startingStack:  cached.startingStack,
      houseFeePercent: cached.houseFeePercent,
      maxSeats:       cached.maxSeats,
    }, '(boot)');
    ok(r.ok === true, 'cold-boot reapply: updateTableSettings succeeded');
    eq(t.bigBlind, 50,
       'cold-boot reapply: in-memory BB now reflects the persisted override');
    eq(t.houseFeePercent, 5,
       'cold-boot reapply: in-memory fee now reflects the persisted override');
  }

  // ====================================================================
  // 9. End-to-end: scheduleNextHand routes pending house fees to admin
  //    (covered indirectly via the engine + DB helpers above; this is a
  //    smoke test that doesn't import server.js to avoid the boot
  //    sequence side effects)
  // ====================================================================
  {
    await db.resetForTests();
    await db.getOrCreatePlayer('Admin', { isAdmin: true, points: 0 });
    const t = P.createTable({ id: 'e2e', bigBlind: 10, smallBlind: 5 });
    t.seats[0] = {
      playerId: 'P0', name: 'P0', stack: 1000,
      holeCards: [], folded: false, allIn: false, removed: false,
      satOut: false, disconnected: false, contributed: 0, acted: false,
    };
    t.pot = 200;
    t.houseFeePercent = 10;
    P.awardPot(t, [t.seats[0]], [200]);
    const pending = P.collectPendingHouseFees(t);
    eq(pending, 20, 'e2e: 10% of 200 = 20 collected');
    // Mirror server.js#scheduleNextHand: credit the admin with the
    // collected amount.
    const r = await db.creditHousePoints(pending);
    ok(r.ok, 'e2e: creditHousePoints succeeded');
    const admin = await db.getPrimaryAdminPlayer();
    eq((admin && admin.points) || -1, 20,
       'e2e: admin user balance = 20 after the routing');
  }

  // ====================================================================
  // 10. Leave-table behaviors (server.js#leave_table): the user's
  //     "Fix Leave Table" request asks for (a) real-time broadcast
  //     [covered by broadcastTable/broadcastLobby in server.js], and
  //     (b) last player leaves → table marked closed/inactive. The
  //     latter is now wired in server.js via rooms.shouldDeleteAfterHand
  //     + rooms.remove after unseat — pin the RoomManager-level
  //     primitives so a future refactor of the handler doesn't
  //     silently drop the empty-table cleanup.
  //
  //     Also pin the mid-hand unseat primitive: when the leaving
  //     player is mid-action, server.js mirrors the disconnect path
  //     and calls poker.applyAction(t, sidx, 'fold') BEFORE
  //     rooms.unseat so the betting round's currentPlayerIndex
  //     rotation can advance. rooms.unseat itself then marks
  //     `folded+removed` and queues the seat for HAND_OVER cleanup.
  // ====================================================================
  {
    const rooms = new RoomManager();

    // Non-default table empty + WAITING phase → shouldDeleteAfterHand
    // returns true so server.js's leave_table can auto-delete it.
    const custom = rooms.createTable({
      name: 'Lone Wolves', smallBlind: 5, bigBlind: 10,
      maxSeats: 6, startingStack: 1000, houseFeePercent: 0,
    });
    custom.default = false; // emulate user-created lifecycle
    custom.phase = P.PHASE.WAITING;
    rooms.seatPlayer(custom.id, 0, { id: 'lone', name: 'lone', points: 500 });
    rooms.unseat(custom.id, 0);
    ok(rooms.shouldDeleteAfterHand(custom) === true,
       'leave-table: empty non-default table in WAITING is deletable');
    // And the actual removal lands it in the lobby list:
    rooms.remove(custom.id);
    ok(!rooms.has(custom.id),
       'leave-table: rooms.remove actually drops the empty non-default table');

    // Default tables: the 5 permanent ones shipped with the server.
    // shouldDeleteAfterHand must return false even when empty + WAITING
    // — they're permanent lobby entry points so the user always sees
    // at least one table at every stakes tier. We look up by NAME
    // (not by idCounter-derived id like 't1') because the section's
    // earlier `rooms.createTable({...})` call incremented idCounter,
    // so the default tables land at 't2'..'t6' instead of 't1'..'t5'.
    // Name-based lookup is also closer to how the lobby UI addresses
    // tables (admin_list_sessions and admin_update_session both key on
    // name in the persisted cache).
    rooms.ensureDefaultTables();
    const beginner = rooms.listTables().find((x) => x.name === 'Beginners Table');
    ok(beginner, 'leave-table: default Beginners Table exists post-ensureDefaultTables');
    beginner.phase = P.PHASE.WAITING;
    ok(beginner.default === true,
       'leave-table: default table is flagged default=true');
    beginner.seats.forEach((s, i) => {
      if (s && !s.removed) rooms.unseat(beginner.id, i);
    });
    ok(rooms.shouldDeleteAfterHand(beginner) === false,
       'leave-table: shouldDeleteAfterHand exempts default tables even when empty');

    // Mid-hand unseat: rooms.unseat marks folded + removed + queues
    // `_pendingUnseat`. Server.js's leave_table mirrors the disconnect
    // path by calling poker.applyAction(t, sidx, 'fold') first so
    // the engine rotates the actor; the unseat primitive is the
    // follow-up cleanup that doesn't touch betting rotation.
    const live = rooms.createTable({
      name: 'Live One', smallBlind: 5, bigBlind: 10,
      maxSeats: 6, startingStack: 1000, houseFeePercent: 0,
    });
    live.default = false;
    live.phase = P.PHASE.FLOP;
    live.seats[0] = {
      playerId: 'p0', name: 'p0', stack: 1000,
      holeCards: [], folded: false, allIn: false, removed: false,
      satOut: false, disconnected: false, contributed: 0, acted: true,
    };
    live.seats[1] = {
      playerId: 'p1', name: 'p1', stack: 1000,
      holeCards: [], folded: false, allIn: false, removed: false,
      satOut: false, disconnected: false, contributed: 0, acted: true,
    };
    live.currentPlayerIndex = 0;
    rooms.unseat(live.id, 0);
    ok(live.seats[0] && live.seats[0].folded === true,
       'leave-table: mid-hand unseat leaves seat folded=true');
    ok(live.seats[0] && live.seats[0].removed === true,
       'leave-table: mid-hand unseat leaves seat removed=true');
    ok(Array.isArray(live._pendingUnseat) && live._pendingUnseat.indexOf(0) !== -1,
       'leave-table: mid-hand unseat queues seat index for HAND_OVER cleanup');
    // And the cleanup primitive nulls the queued seat at HAND_OVER.
    rooms.finishPendingUnseats(live);
    ok(live.seats[0] === null,
       'leave-table: finishPendingUnseats nulls the queued seat at HAND_OVER');
  }

  await db.disconnect();
  await mongoServer.stop();

  console.log('');
  console.log('admin role tests: ' + passed + ' passed, ' + failed + ' failed');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('test runner crashed:', err);
  process.exit(1);
});
