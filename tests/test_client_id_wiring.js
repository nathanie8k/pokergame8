'use strict';

// client.js binds most of its controls with an unguarded
//
//     $('someId').addEventListener(...)
//
// at load time, and reads a few others (sitOutBtn / sitInBtn) straight from
// renderTable. If the matching element is ever removed from index.html, that
// dereference throws — inside the DOMContentLoaded handler it aborts every
// remaining init step (access gate, profile, presence, admin wiring), and
// inside renderTable it aborts the whole table render. Nothing else in the
// suite reads the markup, so nothing else notices. This test cross-checks the
// two files directly.

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const client = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'client.js'), 'utf8');
const index = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');

const markupIds = new Set(
  Array.from(index.matchAll(/\bid="([A-Za-z0-9_-]+)"/g), (m) => m[1])
);

// Ids client.js only ever touches through markup it builds itself from a live
// payload (the admin table-settings editor), so they are legitimately absent
// from the static page.
const DYNAMIC_IDS = new Set(['editSB', 'editBB', 'editStack', 'editSeats', 'editFee', 'editMinPoints']);

const unguarded = [];
client.split('\n').forEach((line, i) => {
  const re = /\$\('([A-Za-z0-9_-]+)'\)\./g;
  let match;
  while ((match = re.exec(line)) !== null) {
    const id = match[1];
    if (markupIds.has(id) || DYNAMIC_IDS.has(id)) continue;
    // `if ($('x')) $('x').value = ...` guards itself on the same line.
    if (line.includes(`if ($('${id}'))`)) continue;
    unguarded.push({ id, line: i + 1, text: line.trim() });
  }
});

assert.deepStrictEqual(
  unguarded,
  [],
  'client.js dereferences ids that index.html does not define (each of these throws at runtime):\n' +
    unguarded.map((u) => `  public/js/client.js:${u.line}  #${u.id}  ${u.text}`).join('\n')
);

// The mobile action bar is bound by client.js during its own init pass, so
// these ids must stay in the markup even though the mobile renderer swaps the
// nodes for listener-free clones.
['mtActCall', 'mtActRaise', 'mtActRaiseArrow'].forEach((id) => {
  assert.ok(markupIds.has(id), `mobile action button #${id} is missing from index.html`);
});

console.log('client id wiring tests: passed');
