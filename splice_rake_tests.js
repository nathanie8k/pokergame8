// Splice the rake test addendum into tests/test_poker.js.
//
// Reads the existing test file + the new addendum file, inserts the
// addendum's body verbatim BEFORE async function main() opens (so the
// new test functions are visible at module scope), and appends the
// test invocations INSIDE main() right before the existing pass/fail
// summary. Uses array.join('\n') to keep the splice clean -- no
// template-literal-with-comments syntax pitfalls.
//
// Idempotent: leaves the file untouched if the addendum marker is
// already present in test_poker.js (so re-running is safe).
'use strict';
const fs = require('fs');
const path = require('path');

const TEST_FILE = path.join(process.cwd(), 'tests', 'test_poker.js');
const ADDENDUM = path.join(process.cwd(), 'tests', 'test_poker_rake_addendum.js');

const testSrc = fs.readFileSync(TEST_FILE, 'utf8');
if (testSrc.includes('// === HouseRake addendum injected ===')) {
  console.log('[splice] addendum already present, no-op.');
  process.exit(0);
}
const addSrc = fs.readFileSync(ADDENDUM, 'utf8');

const lines = testSrc.split('\n');

// Find the line index of 'async function main() {'.
const mainIdx = lines.findIndex((l) => l.trim() === 'async function main() {');
if (mainIdx < 0) throw new Error('Could not find async function main() {');

// Find the line index of either the pass/fail log line or db.disconnect().
// We anchor on the `console.log` that prints 'Tests:' counts.
let tailIdx = -1;
for (let i = 0; i < lines.length; i++) {
  if (/console\.log\(\s*['"`]Tests:/.test(lines[i])) { tailIdx = i; break; }
}
if (tailIdx < 0) {
  // Fallback anchor: a line containing 'db.disconnect();' near the end.
  for (let i = lines.length - 1; i >= 0; i--) {
    if (/db\.disconnect\(\)/.test(lines[i])) { tailIdx = i; break; }
  }
}
if (tailIdx < 0) throw new Error('Could not find a tail anchor (pass/fail log or db.disconnect)');

// Build the addendum to splice in BEFORE main().
const addBeforeMain = [
  '// === HouseRake addendum injected ===',
  ...addSrc.split('\n'),
];

// Build the test-call list inside main(). We make every call AWAIT so
// async tests don't fire-and-forget their assertions.
const testCalls = [
  '  // ===== HouseRake feature tests =====',
  '  // Synchronous unit tests (engine + invariants):',
  '  testPokerRakeBasic();',
  '  testPokerRakeNoFee();',
  '  testPokerRakeSplit2Way();',
  '  testPokerRakeSplit3Way();',
  '  testPokerRakeFoldOut();',
  '  testPokerRakeBustedRefundZeros();',
  '  testPokerRakeFullHandConservation();',
  '  // Async integration tests (db / mongo-backed):',
  '  await testPokerRakeReservedName();',
  '  await testPokerRakeEndToEnd();',
  '  await testPokerRakeColdStart();',
  '  await testPokerRakeLeaderboardExcludes();',
];

// Splice: insert addBeforeMain at the start of mainIdx (push mainIdx
// line and subsequent down), and testCalls just before tailIdx.
// Since we insert at two places, do them in reverse document order to
// keep earlier indices stable.
const out = lines.slice();
out.splice(tailIdx, 0, ...testCalls);
out.splice(mainIdx, 0, ...addBeforeMain);

fs.writeFileSync(TEST_FILE, out.join('\n'));
console.log('[splice] injected addendum before main() (' + addBeforeMain.length + ' lines)');
console.log('[splice] injected test calls before tail anchor (line ' + tailIdx + ')');
