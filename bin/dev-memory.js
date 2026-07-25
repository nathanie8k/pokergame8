// Friendly Poker — in-memory dev bootstrap.
//
// What this is for
// ----------------
// `npm start` requires a real MongoDB on localhost:27017 (or whatever
// MONGO_URI points at). On a fresh machine without mongod installed,
// `npm start` hangs on db.connect() and every button in the SPA appears
// to do nothing because the server never finished booting.
//
// This wrapper fixes that by:
//
//   1. Spinning up an ephemeral `mongodb-memory-server` instance — a
//      real mongod binary downloaded into a temp directory and started
//      in-process. State lives only in memory and is wiped when the
//      process exits, which is exactly what a developer wants when
//      poking at the UI.
//
//   2. Pointing `MONGO_URI` at that ephemeral instance BEFORE
//      requiring server.js, so server.js's db.connect() finds a
//      reachable target on first try.
//
//   3. Wiring SIGINT / SIGTERM so Ctrl+C cleanly stops the in-memory
//      mongod AND the http listener.
//
// Caveats (intentional)
// ---------------------
// - Data does NOT persist across restarts. Each `npm run dev:memory`
//   starts from an empty database. The admin flag for nathanielk7 (or
//   any other player) must be set fresh every session, or use the
//   `dev:memory:seed` variant (TODO if needed) that pre-creates the
//   admin doc on boot.
// - The downloaded mongod binary is cached on disk (~150MB) under
//   `~/.cache/mongodb-binaries` so subsequent runs are fast.
// - Real production should use `npm start` against a real MongoDB.

'use strict';

const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

async function main() {
  console.log('[dev-memory] starting ephemeral MongoDB…');
  const mongod = await MongoMemoryServer.create({
    // Spawn mongod detached but bound to a free localhost port so the
    // Express + Socket.IO server can attach to the default :3000.
    instance: { port: 0, dbName: 'friendly-poker' },
    binary: { downloadDir: path.join(require('os').tmpdir(), 'mongodb-binaries') },
  });
  const uri = mongod.getUri();
  // Set BEFORE requiring server.js so src/database.js's connect()
  // picks up the ephemeral URI on its first call.
  process.env.MONGO_URI = uri;
  console.log('[dev-memory] MongoDB ready at ' + uri);

  // Now boot the real server. server.js will call db.connect() and
  // find this URI. The prime-persisted-settings path runs against
  // the in-memory DB and finds no rows, so the lobby starts with
  // the 5 DEFAULT_TABLES at their default settings.
  require('../server.js');

  // Graceful shutdown — stop mongod first so a Ctrl+C in the dev
  // terminal doesn't leave a dangling in-process mongod eating a
  // port. SIGINT is what Ctrl+C delivers on Windows + POSIX.
  //
  // Implementation: we use `process.exit(0)` instead of just letting
  // the process die naturally because on Windows the bash subshell
  // receiving Ctrl+C does NOT reliably propagate SIGINT down to child
  // node processes, and even when it does, an in-process mongod that
  // didn't get its stop() called will linger on port 27000-something
  // past process exit. Calling process.exit(0) AFTER awaiting stop()
  // guarantees the OS reaps the in-memory mongod AND frees port 3000
  // cleanly on the next boot. (IMPORTANT finding from the code-review
  // pass; without the timeout fallback, an engaged mongod could hang
  // the boot forever.)
  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n[dev-memory] ${signal} received, shutting down…`);
    try {
      // 5s hard timeout so a stuck mongod can't block the exit. The
      // OS will reap the process either way; this is just so the user
      // gets a fresh prompt quickly even if stop() hangs.
      await Promise.race([
        mongod.stop(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('mongod stop timed out (5s)')), 5000)),
      ]);
    } catch (err) {
      // Don't let a stop error block the exit — the OS still reaps
      // us regardless, and logging before exit gives the user a clue
      // if a future boot complains about a lock file.
      console.error('[dev-memory] mongod stop error (ignored, exiting anyway):', err.message || err);
    }
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGHUP',  () => shutdown('SIGHUP'));

main().catch((err) => {
  console.error('[dev-memory] fatal:', err);
  process.exit(1);
});
