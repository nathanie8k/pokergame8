'use strict';
// One-shot: ensure player "nathanielk7" exists, flip isAdmin=true, verify.
// Uses src/database.js so the path is identical to what server.js uses
// on every register / admin_* call.

(async () => {
  const db = require('./src/database.js');
  try {
    await db.connect();

    // Ensure the player exists. getOrCreatePlayer is race-safe and
    // idempotent — re-running it is a no-op aside from a no-op findOne.
    // points: 0 so we don't leak the meta.startingStack default into the
    // rake account (rake balance should start at 0).
    const ensured = await db.getOrCreatePlayer('nathanielk7', { points: 0 });
    console.log('Player doc after ensure:');
    console.log(JSON.stringify(ensured, null, 2));

    // Explicit flip — guarantees isAdmin=true regardless of which path
    // created the doc above (getOrCreatePlayer only sets isAdmin on the
    // first create path, so a pre-existing nathanielk7 doc with isAdmin
    // =false would still need this).
    const flipped = await db.setUserAdmin('nathanielk7', true);
    console.log('Player doc after setUserAdmin(true):');
    console.log(JSON.stringify(flipped, null, 2));

    // Verify: nathanielk7 must show up in the admin list, and the
    // primary admin lookup must also report them.
    const admins = await db.getAdminPlayers();
    console.log('All admins now:');
    console.log(JSON.stringify(admins.map((a) => ({ name: a.name, id: a.id, points: a.points })), null, 2));
    const primary = await db.getPrimaryAdminPlayer();
    console.log('Primary admin: ' + JSON.stringify(primary && { name: primary.name, id: primary.id }));

    await db.disconnect();
  } catch (err) {
    console.error('FAILED:', err && err.message);
    console.error(err && err.stack);
    // Force-exit on connection failure so the shell surfaces the error.
    process.exit(1);
  }
})();
