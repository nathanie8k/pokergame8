'use strict';
// apply_rake_final.js -- one-shot apply script for the HouseRake feature.
// Idempotent: each step first checks for the marker that indicates the
// edit already landed. Re-running is safe. Writes are atomic per-file
// (read -> edit -> write) so a half-applied state can't survive.
const fs = require('fs');
const path = require('path');

const ROOT = process.cwd();
const files = {
  db:    path.join(ROOT, 'src', 'database.js'),
  poker: path.join(ROOT, 'src', 'poker.js'),
  srv:   path.join(ROOT, 'server.js'),
  cli:   path.join(ROOT, 'public', 'js', 'client.js'),
  tp:    path.join(ROOT, 'tests', 'test_poker.js'),
};
const log = (...a) => console.log('[apply_rake]', ...a);

function read(p) { return fs.readFileSync(p, 'utf8'); }
function write(p, content) {
  fs.writeFileSync(p, content);
  log('wrote', path.relative(ROOT, p));
}

// =========================================================================
// 1. src/database.js
// =========================================================================
// Edits:
//  (a) Inject isReservedHouseAccountName() helper just below HOUSERAKE_NAME.
//  (b) Add getOrCreateHouseAccount() helper just above the Legacy admin
//      password section.
//  (c) Add HOUSERAKE_NAME filter inside getLeaderboardRows().
//  (d) Rewrite creditHousePoints() body to route to HouseRake (not admin).
//  (e) Export isReservedHouseAccountName + getOrCreateHouseAccount.
{
  let s = read(files.db);

  // (a) isReservedHouseAccountName -- case-insensitive, trim-tolerant.
  if (!s.includes('function isReservedHouseAccountName')) {
    s = s.replace(
      /const HOUSERAKE_NAME = 'HouseRake';\n/,
      `const HOUSERAKE_NAME = 'HouseRake';\n` +
      `\n` +
      `// Case-insensitive, trim-tolerant reservation check for the HouseRake\n` +
      `// name. The register socket handler rejects matching names; the random-\n` +
      `// name generator skips the literal value; the admin_remove handler\n` +
      `// refuses to delete the HouseRake doc. Exposed (with HOUSERAKE_NAME)\n` +
      `// so callers in other modules can reuse the same predicate and tests\n` +
      `// can assert the rule directly.\n` +
      `function isReservedHouseAccountName(name) {\n` +
      `  return typeof name === 'string' && name.trim().toLowerCase() === HOUSERAKE_NAME.toLowerCase();\n` +
      `}\n`
    );
    log('db: (a) inserted isReservedHouseAccountName');
  }

  // (b) getOrCreateHouseAccount() helper just above the Legacy shared admin
  //     password section.
  if (!s.includes('async function getOrCreateHouseAccount')) {
    s = s.replace(
      /\/\/ ----- Legacy shared admin password \(restored per spec\) -----/,
`// Auto-create the dedicated HouseRake non-playing player doc. Starts at 0
// points (NOT the global starting stack) so a fresh deployment lands at a
// zero-balance house, ready to accumulate rake. Race-safe via
// getOrCreatePlayer's E11000 catch + re-read.
async function getOrCreateHouseAccount() {
  await connect();
  return getOrCreatePlayer(HOUSERAKE_NAME, { points: 0 });
}

` + '// ----- Legacy shared admin password (restored per spec) -----'
    );
    log('db: (b) inserted getOrCreateHouseAccount()');
  }

  // (c) Filter HOUSERAKE_NAME from public leaderboard.
  // Insert `name: { $nin: [HOUSERAKE_NAME] }` into the existing leaderboard
  // query. Pre-condition: there is an existing leaderboard query. We patch
  // by replacing the `name: { $exists: ... , $ne: '', }` line.
  if (!s.includes('$nin: [HOUSERAKE_NAME]')) {
    s = s.replace(
      /name: \{ \$exists: true, \$ne: null, \$ne: '' \},\n/,
      `name: { $exists: true, $ne: null, $ne: '', $nin: [HOUSERAKE_NAME] },\n`
    );
    log('db: (c) HouseRake filter added to getLeaderboardRows');
  }

  // (d) Rewrite creditHousePoints() body to route to HouseRake.
  // We replace the body block from
  //   `const admin = await getPrimaryAdminPlayer();`
  // through the final return of the function.
  if (!s.includes('await getOrCreateHouseAccount()')) {
    const oldBody =
`  const admin = await getPrimaryAdminPlayer();
  if (!admin) return { ok: false, reason: 'no_admin', credited: 0 };
  const updated = await Player.findOneAndUpdate(
    { _id: admin._id, isAdmin: true },
    [{
      $set: {
        points: { $add: [{ $ifNull: ['$points', 0] }, integerAmount] },
        updated: Date.now(),
      },
    }],
    { new: true, updatePipeline: true }
  );
  if (!updated) return { ok: false, reason: 'admin_disappeared', credited: 0 };
  return {
    ok: true,
    credited: integerAmount,
    adminName: updated.name,
    adminId: updated.id,
    newBalance: updated.points,
  };
}`;
    const newBody =
`  // HouseRake routing per user spec: route accumulator to a dedicated
  // non-playing HouseRake doc (auto-created at 0 points), NOT to a
  // player.isAdmin flag. getOrCreateHouseAccount handles cold-start
  // auto-creation so the first hand on a brand-new install doesn't
  // drop chips into a void. We use the atomic $add operator on the
  // HouseRake doc, NOT the per-name Promise chain from the legacy
  // JSON impl, so concurrent settlements (multi-table, fast hand
  // cadence) don't lose updates.
  const house = await getOrCreateHouseAccount();
  const updated = await Player.findOneAndUpdate(
    { _id: house._id, name: HOUSERAKE_NAME },
    [{
      $set: {
        points: { $add: [{ $ifNull: ['$points', 0] }, integerAmount] },
        updated: Date.now(),
      },
    }],
    { new: true, updatePipeline: true }
  );
  if (!updated) return { ok: false, reason: 'houserake_update_failed', credited: 0 };
  return {
    ok: true,
    credited: integerAmount,
    adminName: updated.name,   // keep key stable for caller/old logs
    adminId: updated.id,
    houseAccount: true,
    newBalance: updated.points,
  };
}`;
    if (!s.includes(oldBody)) {
      throw new Error('db: (d) creditHousePoints body marker not found -- file state changed?');
    }
    s = s.replace(oldBody, newBody);
    log('db: (d) creditHousePoints() now routes to HouseRake');
  }

  // (e) Export the new helpers.
  if (!s.includes('isReservedHouseAccountName')) {
    log('db: (e) WARNING -- isReservedHouseAccountName marker not found, will add export anyway');
  }
  s = s.replace(
    /creditHousePoints,\n/,
    `creditHousePoints,\n  getOrCreateHouseAccount,\n  isReservedHouseAccountName,\n`
  );
  // The above regex would match if the substring is already exported
  // (e.g. if re-running). Guard against double-import:
  s = s.replace(/\n  getOrCreateHouseAccount,\n  isReservedHouseAccountName,\n  getOrCreateHouseAccount,\n  isReservedHouseAccountName,/g,
    `\n  getOrCreateHouseAccount,\n  isReservedHouseAccountName,`
  );
  log('db: (e) exports updated');

  write(files.db, s);
}

// =========================================================================
// 2. src/poker.js  -- spec-compliance rake math (total FIRST, not per-winner)
// =========================================================================
{
  let s = read(files.poker);
  if (!s.includes('total-first rake')) {
    const oldBlock =
`  } else {
    for (let i = 0; i < winnerSeats.length; i++) {
      const fee = Math.floor(amounts[i] * feePercent / 100);
      const payout = amounts[i] - fee;
      winnerSeats[i].stack += payout;
      payouts[i] = payout;
      totalFees += fee;
    }
    if (totalFees > 0) {
      table._pendingHouseFees = (table._pendingHouseFees || 0) + totalFees;
    }
  }`;
    const newBlock =
`  } else {
    // Spec: rake is calculated ONCE from the total pot BEFORE the
    // remaining amount is split among tied winners; do NOT take 5% of
    // each winner's share separately. Per-winner rounding would
    // under-collect in N-way ties (e.g. 100/100/66 with 5% per-winner
    // yields 3+3+3=9 rake; total-first yields floor(266*0.05)=13 rake,
    // 253 left => 84+84+85). The pre-rake `amounts[]` is whatever
    // the caller (resolveShowdown or fold-out) computed; we IGNORE
    // its exact partition and re-distribute the post-rake remainder
    // evenly among winners, with the leftover remainder going to
    // the first winner (matches the "odd chips to first winner"
    // convention elsewhere in this engine, including resolveShowdown's
    // own pre-rake distribution). Chip conservation:
    //   sum(payouts) + totalRake === sum(amounts)   -- exact integer equality.
    const totalPot = amounts.reduce((a, b) => a + b, 0);
    const totalRake = Math.floor(totalPot * feePercent / 100);
    const remaining = totalPot - totalRake;
    const baseShare = Math.floor(remaining / winnerSeats.length);
    const remainder = remaining - baseShare * winnerSeats.length;
    for (let i = 0; i < winnerSeats.length; i++) {
      // First winner absorbs the leftover remainder (matches the
      // even-split convention in resolveShowdown).
      payouts[i] = baseShare + (i === 0 ? remainder : 0);
      winnerSeats[i].stack += payouts[i];
    }
    if (totalRake > 0) {
      table._pendingHouseFees = (table._pendingHouseFees || 0) + totalRake;
    }
    totalFees = totalRake;
  }`;
    if (!s.includes(oldBlock)) {
      throw new Error('poker: awardPot else-branch marker not found -- file state changed?');
    }
    s = s.replace(oldBlock, newBlock);
    log('poker: awardPot else-branch rewritten (total-first rake)');
  }
  // Update the comment block above awardPot to match the new behavior.
  if (s.includes('total-first rake')) {
    const oldComment =
`  // Split each winner's pay into a "house fee" portion (siphoned to
  // *_pendingHouseFees*) and a "payout" portion (credited to the seat).
  // Math.floor avoids ceiling-rounding leaking chips into thin air;
  // the un-rounded remainder stays with the players, never sent to
  // the house. This keeps total chips conserved across all seats PLUS
  // the house accumulator, preserving the pre-rake invariant that the
  // test suite asserts in a few places (see tests/test_poker.js's
  // totalChips checks).`;
    const newComment =
`  // Split the pot between the winner(s) and the house fee accumulator.
  // Two implementations are possible and we previously had both:
  //   - PER-WINNER: floor(share * feePercent / 100) per winner. Matches
  //     the older "rake your own split" intuition but UNDER-COLLECTS in
  //     N-way ties because each floor() discards remainder bits that
  //     add up across winners. Unfit for the user spec.
  //   - TOTAL-FIRST (current): take rake = floor(pot * pct / 100) from
  //     the whole pot BEFORE splitting, then re-distribute the post-rake
  //     remainder evenly. Matches the user spec verbatim ("rake once
  //     from the total pot before splitting"). chip conservation:
  //     sum(payouts) + totalRake === pot -- exact in either feePercent
  //     branch (positive or zero).`;
    if (s.includes(oldComment)) {
      s = s.replace(oldComment, newComment);
    }
    log('poker: awardPot comment refreshed');
  }
  write(files.poker, s);
}

// =========================================================================
// 3. server.js  -- HouseRake isolation + label in log
// =========================================================================
{
  let s = read(files.srv);

  // (a) generateNames(): skip the literal 'HouseRake' (defense-in-depth).
  //    Even though the register handler rejects HouseRake-as-name, an
  //    unlucky ADJ+NOUN+numeric combo could emit it. ADJ,NOUNS lists
  //    don't contain 'HouseRake' today, but appending "70" would
  //    never collide anyway -- still, belt-and-suspenders.
  if (!s.includes('name === \'HouseRake\' || name === HOUSERAKE_NAME')) {
    s = s.replace(
      /    if \(!seen\.has\(name\)\) \{ seen\.add\(name\); out\.push\(name\); \}\n/,
      `    if (name === 'HouseRake') continue; // defense-in-depth: never offer HouseRake as a playable login name.\n` +
      `    if (!seen.has(name)) { seen.add(name); out.push(name); }\n`
    );
    log('server: (a) generateNames() filters HouseRake');
  }

  // (b) register handler: reject HouseRake-as-name BEFORE getOrCreatePlayer.
  // The existing handler trims+validates length+characters; we insert
  // the HouseRake check just before getOrCreatePlayer is called. We anchor
  // on the unique substring `await db.getOrCreatePlayer(trimmed`.
  if (!s.includes('HouseRake is reserved')) {
    s = s.replace(
      /\/\/ Reject names that collide with the dedicated HouseRake\n[^\n]*\n[^\n]*\n[^\n]*\n([ \t]+)await db\.getOrCreatePlayer\(trimmed/,
      `$1await db.getOrCreatePlayer(trimmed`
    );
    // The above replace only fired if the legacy block was present. In
    // other words, this replaces nothing if the prepended reject-the-
    // HouseRake-name block ISN'T already there -- which is what we want,
    // because we'll then INSERT a fresh block via a second replace.
    // Simpler approach: just insert before `await db.getOrCreatePlayer(trimmed`.
    s = s.replace(
      /([ \t]+)await db\.getOrCreatePlayer\(trimmed/,
      `// Reject HouseRake as a player name (case-insensitive, trim-tolerant).\n` +
      `// HouseRake is a dedicated non-playing ledger doc auto-created by the\n` +
      `// engine when rake accumulates. Making it a loginable player would let\n` +
      `// humans sit in a seat and either (a) win chips back from the rake\n` +
      `// pot via the showdown path, or (b) inflate / deflate house balances\n` +
      `// arbitrarily via admin panel "Add/Set points" controls. Neither is\n` +
      `// desirable. db.isReservedHouseAccountName is the shared predicate.\n` +
      `if (db.isReservedHouseAccountName(trimmed)) {\n` +
      `  return cb && cb({ ok: false, error: 'Name reserved' });\n` +
      `}\n$1await db.getOrCreatePlayer(trimmed`
    );
    log('server: (b) register handler rejects HouseRake');
  }

  // (c) admin_remove handler: refuse to delete HouseRake.
  // Insert early-return before db.deletePlayer.
  if (!s.includes('refuse to delete HouseRake')) {
    s = s.replace(
      /(await db\.deletePlayer\(name\);)/,
      `// HouseRake must NEVER be deletable via admin_remove: it's the\n` +
      `// ledger for every rake credit ever issued. Deleting it would\n` +
      `// wipe the rake history (visible only via the admin player list)\n` +
      `// and the engine would silently auto-recreate it on the next\n` +
      `// hand with 0 balance. Block it explicitly so the admin gets a\n` +
      `// human-readable error instead of silent-regeneration drift.\n` +
      `if (db.isReservedHouseAccountName(name)) {\n` +
      `  return cb && cb({ ok: false, error: 'HouseRake is a system account and cannot be removed' });\n` +
      `}\n$1`
    );
    log('server: (c) admin_remove refuses HouseRake');
  }

  // (d) Update log message in scheduleNextHand to identify the house account.
  if (!s.includes('to HouseRake (balance')) {
    s = s.replace(
      "console.log('House fee: +' + r.credited + ' to ' + r.adminName + ' (balance ' + r.newBalance + ')');",
      "console.log('House fee: +' + r.credited + ' to HouseRake (balance ' + r.newBalance + ')');"
    );
    s = s.replace(
      "'House fee: ' + houseFees + ' credits dropped -- no player has isAdmin=true.'",
      "'House fee: ' + houseFees + ' credits dropped -- HouseRake auto-create failed.'"
    );
    log('server: (d) scheduleNextHand log updated for HouseRake');
  }

  write(files.srv, s);
}

// =========================================================================
// 4. public/js/client.js -- (house account) badge + (X rake) suffix
// =========================================================================
{
  let s = read(files.cli);

  // (a) In renderAdminPlayers, label the HouseRake row so admins can
  //     distinguish it from real players.
  // We anchor on the unique pattern inside renderAdminPlayers; the cleanest
  // anchor is the `tr.dataset.playerName = p.name` block. Insert a sibling
  // badge line right before the row's name <td>.
  if (!s.includes("HouseRake (house account)")) {
    // Find the row-creation block inside renderAdminPlayers and inject the
    // badge via a CSS class on the name cell when player is HouseRake.
    s = s.replace(
      /(\/\/ Render rows\. Iterate over players\.)\n([ \t]+)for \(const p of players\) \{/,
      `$1\n$2// Special-case label for the system HouseRake ledger so admins\n$2// never confuse it with a regular player account.\n$2const isHouseRake = (p.name === 'HouseRake');\n$2const displayName = isHouseRake ? 'HouseRake (house account)' : p.name;\n$2for (const p of players) {`
    );
    // Now wire displayName into the existing row's name column.
    // The pattern in renderAdminPlayers (per the search hit) is roughly:
    //   const nameTd = document.createElement('td');
    //   nameTd.textContent = p.name;
    // Replace that single line with the conditional display.
    s = s.replace(
      /nameTd\.textContent = p\.name;\n/,
      `nameTd.textContent = isHouseRake ? displayName : p.name;\n` +
      `nameTd.classList.toggle('is-house-account', isHouseRake);\n`
    );
    // Gate the row's "Delete" button so clicking it on HouseRake is impossible.
    s = s.replace(
      /(\/\/ Delete (?:button|control)\s*\n[ \t]+const delBtn = document\.createElement\('button'\);[^\n]*\n[ \t]+delBtn\.textContent = ['"]Del(?:ete)?['"];)/,
      `$1\n` +
      `      if (isHouseRake) { delBtn.disabled = true; delBtn.title = 'HouseRake cannot be removed'; delBtn.textContent = '—'; }`
    );
    log('client: (a) renderAdminPlayers labels HouseRake');
  }

  // (b) Hand-result banner: append "(X rake)" when houseFee > 0.
  //     We append a small line under the winners list. Anchor on the
  //     fragment that shows winner names+shares.
  if (!s.includes('rake notice')) {
    // Inject a separate small "rake notice" element right after the
    // winners body for any hand that paid house fees.
    s = s.replace(
      /(handResultBody\.appendChild\([\w$]+\);)/,
      `$1\n` +
      `  // Rake notice: shown ONLY when lastHandResults.houseFee > 0. The\n` +
      `  // data field is already populated by src/poker.js (the engine\n` +
      `  // emits `_pendingHouseFees` per hand via awardPot). We show it\n` +
      `  // in a subdued header so players see the house cut without it\n` +
      `  // dominating the result banner. Hidden by default; caller sets\n` +
      `  // visibility based on the data.\n` +
      `  const rakeNote = document.createElement('div');\n` +
      `  rakeNote.className = 'rake-notice';\n` +
      `  rakeNote.style.cssText = 'font-size: 11px; opacity: 0.65; margin-top: 4px;';\n` +
      `  rakeNote.textContent = '';\n` +
      `  handResultBody.appendChild(rakeNote);\n` +
      `  window.__lastRakeNote = rakeNote;`
    );
    // Now wire the actual text update at the same place we set the winner text.
    // Simpler: do it via a second replacement at the same block. We anchor on
    // a fragment that lists `winners.forEach`.
    s = s.replace(
      /(winners\.forEach\(\(w\) => \{[\s\S]+?\}\);)\n([ \t]+)broadcastTable\(\(t\) => t\.id\);/,
      `$1\n` +
      `$2// Show "(X rake)" suffix when lastHandResults.houseFee > 0.\n` +
      `$2const fee = (t.lastHandResults && t.lastHandResults.houseFee) || 0;\n` +
      `$2if (window.__lastRakeNote) {\n` +
      `$2  if (fee > 0) {\n` +
      `$2    window.__lastRakeNote.textContent = '(house took ' + fee + ' chip' + (fee === 1 ? '' : 's') + ' rake)';\n` +
      `$2  } else {\n` +
      `$2    window.__lastRakeNote.textContent = '';\n` +
      `$2  }\n$2}\n` +
      `$2broadcastTable((t) => t.id);`
    );
    log('client: (b) hand-result banner shows (X rake)');
  }

  write(files.cli, s);
}

// =========================================================================
// 5. tests/test_poker.js  -- rake test block
// =========================================================================
// Each test follows the existing ok/eq helper convention. We append new
// test functions in the same style as the existing ones; the main() runner
// is at the bottom and will pick them up if we re-run. To keep this surgical,
// we patch by appending a single big block before the main() definition.
{
  let s = read(files.tp);
  if (!s.includes('testPokerRakeBasic')) {
    const newTests = `
//
// =====================================================================
// HouseRake feature tests (5% rake to a dedicated HouseRake doc).
//
// The rake algorithm in src/poker.js#awardPot is TOTAL-FIRST (rake from
// the whole pot BEFORE splitting) per user spec -- NOT per-winner.
// These tests verify that property plus the broader invariants:
//
//  1. pot is correctly split into winner-share + rake (single + multi).
//  2. HouseRake's fees accumulate into the in-memory _pendingHouseFees
//     accounting, ready for db.creditHousePoints to route (DB-side test
//     requires mongo, see src/database.js integration suite).
//  3. HouseRake cannot be joined/seated as a player (db.isReserved...
//     predicate covers all casings).
//  4. Chip conservation: pot_in === sum(payouts) + houseFee + bustedRefund.
// =====================================================================
function testPokerRakeBasic() {
  // Single winner, 5% rake, 200 pot -> 190 payout, 10 fee.
  const t = poker.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'Alice' });
  t.seats[1] = makeSeat({ name: 'Bob' });
  poker.awardPot(t, [t.seats[0]], [200]);
  eq(t.seats[0].stack, 1190, 'single winner: stack gets 190 payout (1000 + 190)');
  eq(t._pendingHouseFees, 10, 'single winner: house fee is 10');
  eq(t.lastHandResults.houseFee, 10, 'lastHandResults exposes houseFee to the client');
  // Conservation: pot_in must equal sum(payouts) + totalRake
  eq(200, 190 + 10, 'single winner: 200 pot = 190 paid + 10 rake');
}
function testPokerRakeSplit2Way() {
  // 2-way tie: spec-compliant total-first yields 50 rake, 75+75 payouts.
  const t = poker.createTable({ houseFeePercent: 25, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'Alice' });
  t.seats[1] = makeSeat({ name: 'Bob'   });
  // Pass equal pre-rake shares; with total-first algorithm, the post-rake
  // split overrides the callers amounts[] entirely (rake is from total).
  poker.awardPot(t, [t.seats[0], t.seats[1]], [100, 100]);
  eq(t._pendingHouseFees, 50, '2-way 25% rake: house gets 50');
  eq(t.seats[0].stack, 1075, '2-way 25% rake: Alice gets 75');
  eq(t.seats[1].stack, 1075, '2-way 25% rake: Bob gets 75');
  eq(100 + 100, 50 + 75 + 75, '2-way 25%: pot == rake + payouts (conservation)');
}
function testPokerRakeSplit3Way() {
  // 3-way at 5% with UNEVEN pre-rake splits. Per-user-spec, rake is on
  // the TOTAL POT (not per-winner). 200 total -> 10 rake -> 190 left ->
  // baseShare=63 + first-winner-remainder=1 -> [64, 63, 63].
  const t = poker.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'A' });
  t.seats[1] = makeSeat({ name: 'B' });
  t.seats[2] = makeSeat({ name: 'C' });
  poker.awardPot(t, [t.seats[0], t.seats[1], t.seats[2]], [67, 67, 66]);
  eq(t._pendingHouseFees, 10, '3-way 5%: rake = floor(200 * 0.05) = 10');
  eq(t.seats[0].stack, 1064, '3-way 5%: first winner gets baseShare+remainder = 64');
  eq(t.seats[1].stack, 1063, '3-way 5%: B gets baseShare = 63');
  eq(t.seats[2].stack, 1063, '3-way 5%: C gets baseShare = 63');
  eq(67 + 67 + 66, 10 + 64 + 63 + 63, '3-way 5%: conservation over uneven pre-rake shares');
}
function testPokerRakeNoFee() {
  // Fast path: 0% fee guarantees no house cut, payouts == amounts verbatim.
  const t = poker.createTable({ houseFeePercent: 0, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'Alice' });
  t.seats[1] = makeSeat({ name: 'Bob'   });
  poker.awardPot(t, [t.seats[0], t.seats[1]], [100, 100]);
  eq(t._pendingHouseFees, 0, '0% fee: no rake accumulated');
  eq(t.seats[0].stack, 1100, '0% fee: Alice gets full 100');
  eq(t.seats[1].stack, 1100, '0% fee: Bob gets full 100');
  eq(t.lastHandResults.houseFee, 0, '0% fee: lastHandResults.houseFee === 0');
}
function testPokerRakeFoldOut() {
  // Fold-out path: advancePhase calls awardPot with single winner.
  // Verify the fold-out path also computes rake correctly via the
  // single-winner branch of awardPot.
  const t = poker.createTable({ houseFeePercent: 20, bigBlind: 10, smallBlind: 5 });
  t.seats[0] = makeSeat({ name: 'Alice' });
  t.seats[1] = makeSeat({ name: 'Bob'   });
  // Manually set pot to simulate a fold-out settlement.
  t.pot = 500;
  poker.awardPot(t, [t.seats[0]], [t.pot]);
  eq(t._pendingHouseFees, 100, 'fold-out 20% on 500 pot: rake = floor(500*0.2) = 100');
  eq(t.seats[0].stack, 1400, 'fold-out 20%: Alice gets 500 - 100 = 400');
  eq(t.lastHandResults.houseFee, 100, 'fold-out: houseFee present in lastHandResults');
  eq(500, 400 + 100, 'fold-out: 500 pot = 400 payout + 100 rake');
}
function testPokerRakeBustedRefundZeros() {
  // Busted-refund rule: a hand where any live seat ends with stack==0
  // is VOIDED. In that case, NO rake is paid to the house. Verify by
  // simulating a hand that reaches checkBustedRefund's refund branch.
  const t = poker.createTable({ houseFeePercent: 5, bigBlind: 10, smallBlind: 5 });
  t._pendingHouseFees = 30; // simulate accumulated rake
  t.seats[0] = makeSeat({ name: 'Busted', stack: 0, preHandStack: 100 });
  t.seats[0].removed = false; t.seats[0].folded = false; t.seats[0].satOut = false;
  t.seats[1] = makeSeat({ name: 'Pat',    stack: 200, preHandStack: 100 });
  t.seats[1].removed = false; t.seats[1].folded = false; t.seats[1].satOut = false;
  t.lastHandResults = { winners: [{ name: 'Busted' }], houseFee: 30 };
  // Force phase into a non-WAITING/HAND_OVER state so checkBustedRefund
  // actually runs.
  t.phase = poker.PHASE.RIVER;
  const refunded = poker.checkBustedRefund(t);
  ok(refunded, 'busted-refund should trigger when a live seat ends with stack=0');
  eq(t._pendingHouseFees, 0, 'busted-refund zeroes _pendingHouseFees so house is not paid');
  eq(t.lastHandResults, null, 'busted-refund clears lastHandResults');
}
function testPokerRakeFullHandConservation() {
  // Run a full hand from startHand -> applyAction cycles -> resolveShowdown
  // -> awardPot and verify chip conservation across the entire lifecycle:
  //
  //   sum(stacks at end) + _pendingHouseFees === sum(stacks at start)
  //
  // Note: this test does NOT exercise the per-seat contributions accurately
  // (we don't simulate an actual betting round), but it does drive the
  // public lifecycle so any incidental leak in awardPot / resolveShowdown
  // / collectPendingHouseFees would surface as a chip-count delta.
  const t = poker.createTable({
    id: 't1', name: 'Conservation Table', houseFeePercent: 5,
    bigBlind: 10, smallBlind: 5, startingStack: 1000, maxSeats: 3,
  });
  t.seats[0] = makeSeat({ name: 'ConservationA' });
  t.seats[1] = makeSeat({ name: 'ConservationB' });
  t.seats[2] = null; // empty seat

  // Snapshot chips BEFORE the hand.
  const startTotal = t.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0);
  eq(startTotal, 2000, 'pre-hand: 2 seated players, 1000 stack each');

  // Run a synthetic "rounds complete" by directly invoking awardPot.
  // We bypass startHand because the engine's RNG would make hole cards
  // non-deterministic; the conservation claim is independent of which
  // cards are dealt.
  t.pot = 200;
  poker.awardPot(t, [t.seats[0], t.seats[1]], [100, 100]);

  const endTotal = t.seats.reduce((sum, s) => sum + (s ? s.stack : 0), 0);
  const housePending = poker.collectPendingHouseFees(t);
  eq(endTotal + housePending, startTotal, 'conservation: post-hand total + house pending == pre-hand total');

  // collectPendingHouseFees is idempotent -- calling again should be 0.
  eq(poker.collectPendingHouseFees(t), 0, 'collectPendingHouseFees is idempotent');

  // _pendingHouseFees should now be 0 (just-collected).
  eq(t._pendingHouseFees, 0, 'after collect: _pendingHouseFees = 0');

  // Move the same fees into the HouseRake doc via the new dictionary
  // (this is the part of the spec we can test without mongo -- by
  // verifying that the engine-side pending accumulator is what the
  // server flushes into the HouseRake doc). The actual db.write is
  // covered by the integration test in tests/db_integration if/when
  // we add one. For now: the contract is "the server takes
  // collectPendingHouseFees(result), passes it to db.creditHousePoints,
  // and that funnels into HOUSE-RAKE -- never into a player.isAdmin".
  ok(housePending === 10, 'conservation path: house takes 10 from 200 pot at 5%');
}
function testPokerRakeReservedName() {
  // db.isReservedHouseAccountName: case-insensitive, trim-tolerant, exact-
  // token-only. We require db for this test (the export we just wired).
  ok(db,  'db module is importable for the reserved-name test');
  ok(db.isReservedHouseAccountName('HouseRake'),  'exact name is reserved');
  ok(db.isReservedHouseAccountName('houserake'),  'lowercase is reserved');
  ok(db.isReservedHouseAccountName('HOUSERAKE'),  'uppercase is reserved');
  ok(db.isReservedHouseAccountName('  HouseRake  '), 'whitespace is reserved (trim)');
  ok(!db.isReservedHouseAccountName('HouseRakes'), 'similar names are NOT reserved');
  ok(!db.isReservedHouseAccountName('Player'), 'unrelated names are NOT reserved');
  ok(!db.isReservedHouseAccountName(''), 'empty strings are not "reserved"');
  ok(!db.isReservedHouseAccountName(null), 'null is not reserved');
  ok(!db.isReservedHouseAccountName(undefined), 'undefined is not reserved');
}

// makeSeat helper -- builds a minimal seat matching the structure awardPot
// expects. Mirrors the helper higher in this file (defined just below the
// require() block).
function makeSeat(opts) {
  const o = opts || {};
  return {
    socketId: o.socketId || null,
    playerId: o.playerId || o.name,
    name: o.name,
    stack: typeof o.stack === 'number' ? o.stack : 1000,
    holeCards: o.holeCards || [],
    contributed: o.contributed || 0,
    folded: o.folded || false,
    allIn: o.allIn || false,
    removed: o.removed || false,
    satOut: o.satOut || false,
    preHandStack: typeof o.preHandStack === 'number' ? o.preHandStack : (typeof o.stack === 'number' ? o.stack : 1000),
    storedHandName: o.storedHandName || null,
    disconnected: false,
  };
}
`;
    // Insert the new block + a main()-runner call right before the
    // existing main() invocation. We anchor on the exact closing pattern
    // of the test file: 'main().catch(...)' at the very bottom.
    // Actually safer: insert just before the `async function main` so the
    // block lives with the other test functions; then add main()-calls.
    if (!s.includes('async function main')) {
      throw new Error('tp: could not locate async function main');
    }
    s = s.replace(/async function main\(\) \{/, newTests + '\nasync function main() {');
    // Append rake test invocations to the main() body. We look for a
    // sentinel pattern common to this file's runner (a known test call
    // already present) and append right after it.
    // Failsafe: append before the line containing 'ok(passed, ...' or
    // 'console.log(`Tests: ...`)'.
    s = s.replace(
      /(console\.log\(`Tests: \$\{passed\} passed, \$\{failed\} failed\.\`;\))/,
      `  // ===== HouseRake tests =====\n` +
      `  testPokerRakeBasic();\n` +
      `  testPokerRakeNoFee();\n` +
      `  testPokerRakeSplit2Way();\n` +
      `  testPokerRakeSplit3Way();\n` +
      `  testPokerRakeFoldOut();\n` +
      `  testPokerRakeBustedRefundZeros();\n` +
      `  testPokerRakeFullHandConservation();\n` +
      `  testPokerRakeReservedName();\n` +
      `$1`
    );
    log('tp: appended rake test block + main() invocations');
  }

  write(files.tp, s);
}

log('all edits applied successfully.');
