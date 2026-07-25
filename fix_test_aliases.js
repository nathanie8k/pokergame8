// fix_test_aliases.js -- repair the corruption from the prior sed command
// and rename P. -> poker. ONLY inside the rake addendum block (to keep
// existing main()-body code untouched). Idempotent.
'use strict';
const fs = require('fs');
const path = require('path');

const TEST_FILE = path.join(process.cwd(), 'tests', 'test_poker.js');
let s = fs.readFileSync(TEST_FILE, 'utf8');

let changed = false;
// (1) Repair the corruption: the prior sed command concatenated two
// require statements on one line with a missing 'co' prefix on the
// second. Replace the corrupted literal exactly.
const CORRUPTED = "const poker = require('../src/poker.js');nst db = require('../src/database.js');";
const REPAIRED_OLD_LINE_1 = "const poker = require('../src/poker.js');";
const REPAIRED_OLD_LINE_2 = "const db = require('../src/database.js');";
if (s.includes(CORRUPTED)) {
  s = s.replace(CORRUPTED, REPAIRED_OLD_LINE_1 + '\n' + REPAIRED_OLD_LINE_2);
  changed = true;
  console.log('[fix] repaired line-7 corruption');
}

// (2) Safe P. -> poker. rename. Only inside the splice addendum.
// The addendum is delimited by:
//   START: // === HouseRake addendum injected ===
//   END:   // ===== HouseRake feature tests ===== (the call list inside main)
const START_MARKER = '// === HouseRake addendum injected ===';
const END_MARKER = '// ===== HouseRake feature tests =====';
const startIdx = s.indexOf(START_MARKER);
const endIdx = s.indexOf(END_MARKER);
if (startIdx >= 0 && endIdx > startIdx) {
  const before = s.substring(0, startIdx);
  const middle = s.substring(startIdx, endIdx);
  const after = s.substring(endIdx);
  // Rename word-bound P. -> poker. only inside middle.
  const renamedMiddle = middle.replace(/\bP\./g, 'poker.');
  // Also rename function definitions/test names that contain "P." if any.
  // The splice contents only have `P.createTable`, `P.awardPot`, `P.PHASE`,
  // `P.collectPendingHouseFees`, `P.checkBustedRefund` -- all matched by
  // the regex above.
  if (renamedMiddle !== middle) {
    s = before + renamedMiddle + after;
    changed = true;
    console.log('[fix] renamed P. -> poker. inside addendum block');
  }
} else if (s.includes('// === HouseRake addendum injected (v2) ===')) {
  // Idempotency: if a re-run happens and we already injected v2, we
  // don't need to do anything.
  console.log('[fix] v2 addendum marker found; idempotent no-op');
}

if (changed) {
  fs.writeFileSync(TEST_FILE, s);
  console.log('[fix] wrote ' + TEST_FILE);
} else {
  console.log('[fix] no changes needed');
}
