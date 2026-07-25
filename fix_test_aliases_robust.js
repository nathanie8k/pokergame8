// fix_test_aliases_robust.js -- regex-based repair of tests/test_poker.js
// corruption. Robust to byte-level variations in the corruption (the
// prior sed command emitted a \u000f whitespace lookalike between
// "poker.js);" and "nst db" -- exact-string match silently missed).
//
// Repairs:
//   1. Any line whose first non-whitespace token contains "poker = require"
//      followed by a corrupted continuation "nst db = require('...database...')"
//      is REWRITTEN to two clean lines.
//   2. The splice-bounded P. -> poker. rename is repeated (idempotent).
//
// Idempotent: safe to re-run.
'use strict';
const fs = require('fs');
const path = require('path');

const TEST_FILE = path.join(process.cwd(), 'tests', 'test_poker.js');
let s = fs.readFileSync(TEST_FILE, 'utf8');

let changed = false;

// (1) Repair line corruption: any line that reads
//
//   const <garbage> poker = require('../src/poker.js');<anychars>nst db = require('../src/database.js');
//
// is replaced with two clean lines.
//
// Pattern: starts with 'const', has 'poker = require('../src/poker.js')'
// somewhere, then has 'nst db = require('../src/database.js')' on the
// SAME logical line (delimiter can be ;, control char, or whitespace).
const CORRUPT_LINE =
  /^(\s*)(?:const\s+)?(?:[^\n]*?)\bpoker\s*=\s*require\(\s*['"]\.\.\/src\/poker\.js['"]\s*\)\s*;[^\n]*?nst\s+db\s*=\s*require\(\s*['"]\.\.\/src\/database\.js['"]\s*\)\s*;?\s*$/m;
const m = s.match(CORRUPT_LINE);
if (m) {
  const indent = m[1] || '';
  const replacement =
    indent + "const poker = require('../src/poker.js');\n" +
    indent + "const db = require('../src/database.js');";
  s = s.replace(CORRUPT_LINE, replacement);
  changed = true;
  console.log('[fix] repaired corrupted require pair');
}

// (2) Splice-bounded rename: P. -> poker. inside the rake addendum.
const START_MARKER = '// === HouseRake addendum injected ===';
const END_MARKER = '// ===== HouseRake feature tests =====';
const startIdx = s.indexOf(START_MARKER);
const endIdx = s.indexOf(END_MARKER);
if (startIdx >= 0 && endIdx > startIdx) {
  const before = s.substring(0, startIdx);
  const middle = s.substring(startIdx, endIdx);
  const after = s.substring(endIdx);
  const renamed = middle.replace(/\bP\./g, 'poker.');
  if (renamed !== middle) {
    s = before + renamed + after;
    changed = true;
    console.log('[fix] renamed P. -> poker. in addendum');
  }
}

if (changed) {
  fs.writeFileSync(TEST_FILE, s);
  console.log('[fix] wrote ' + TEST_FILE);
} else {
  console.log('[fix] no repair needed');
}
