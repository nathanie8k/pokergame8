/* ============================================================
   Poker8 — mid-hand join seats (desktop table)
   ------------------------------------------------------------
   A player who sits down while a hand is already running was never
   dealt into that hand. src/rooms.js#seatPlayer marks such a seat
   `joinedMidHand` and src/poker.js keeps it out of the turn order,
   the round-close accounting and the showdown until the next deal
   clears the flag.

   client.js already handles the loud half of that: the action bar
   and the "your turn" glow key off table.currentPlayerIndex, so a
   flagged seat never lights up. What is left is the seat itself —
   renderSeat() paints every occupied seat the same way (name,
   stack, then two card placeholders), which reads as "in the hand".

   client.js is too large for the workspace file editor, so this
   module wraps the global renderSeat/renderSelfInfo (the same
   override pattern table-mobile.js uses for populateMobileFelt)
   and adjusts ONLY seats the server flagged:

     - drops the hole-card placeholders (no cards were dealt), and
     - adds the "Waiting for next hand" status line.

   Nothing else is touched: no betting, turn, socket or layout
   logic, and un-flagged seats come back exactly as rendered.
   ============================================================ */
(function () {
  'use strict';

  var WAITING_TEXT = 'Waiting for next hand';

  // ------------------------------------------------------------
  // Table seats (the ring at the felt)
  // ------------------------------------------------------------
  var baseRenderSeat = window.renderSeat;
  if (typeof baseRenderSeat === 'function') {
    window.renderSeat = function (seat, idx, table, total) {
      var node = baseRenderSeat.call(this, seat, idx, table, total);
      if (!node || !seat || !seat.joinedMidHand) return node;

      // Two face-down placeholders would imply this seat holds cards for the
      // running hand. It does not — remove them.
      var cards = node.querySelector('.hole-cards');
      if (cards && cards.parentNode) cards.parentNode.removeChild(cards);

      // The status line lives next to the stack inside the ring's status
      // wrapper (the same wrapper renderSeat uses for Folded / All-in).
      var stack = node.querySelector('.stack');
      var host = stack && stack.parentNode;
      if (host && !host.querySelector('.status')) {
        host.appendChild(el('span', { class: 'status waiting', text: ' · ' + WAITING_TEXT }));
      }
      return node;
    };
  }

  // ------------------------------------------------------------
  // The viewer's own info panel (name / stack / status)
  // ------------------------------------------------------------
  var baseRenderSelfInfo = window.populateSelfInfo;
  if (typeof baseRenderSelfInfo === 'function') {
    window.populateSelfInfo = function (infoEl, seat, t) {
      baseRenderSelfInfo.call(this, infoEl, seat, t);
      if (!infoEl || !seat || !seat.joinedMidHand) return;
      if (infoEl.querySelector('.self-status')) return;
      var line = el('div', { class: 'self-status' }, WAITING_TEXT);
      // Keep the same order the base renderer uses: status above the
      // Dealer / blind marks when they are present.
      var marks = infoEl.querySelector('.self-marks');
      if (marks && marks.parentNode === infoEl) infoEl.insertBefore(line, marks);
      else infoEl.appendChild(line);
    };
  }
})();
