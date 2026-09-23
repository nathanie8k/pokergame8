/* ============================================================
   Poker8 — mobile table renderer (<=720px)
   ------------------------------------------------------------
   client.js owns the single shared render pass: every table_state
   broadcast ends in renderTable(), which calls the mobile hook
   populateMobileFelt(t, selfSeat). This module IS that hook — it
   replaces the old green-felt marker implementation with the one
   that builds the mobile design's DOM:

     .mt-header   back arrow + table menu (…)
     #mtSeats     one .mt-seat per opponent, left -> right in seat order
     #mtCommunity + #mtPotAmount   board + pot
     #mtHoleCards + hand panel     the viewer's cards + hand name
     .mt-actions  Call/Check, Raise and the panel expander

   It loads after client.js and installs itself on window, so the
   override is in place before the first render and renderTable keeps
   calling the same name. Game logic, betting, turn order and every
   socket event stay in client.js / the server — everything here reads
   the public table_state payload and only writes DOM.

   The action bar's sizing row (#mobileFeltSizing) and the raise slider
   (#mobileRaiseSlider) are still driven by client.js's existing
   setupActionButtons()/syncRaiseSliders(); this module only labels and
   enables the new buttons and mirrors them for the mobile layout.

   Two overrides, both installed before the first render:

     1. populateMobileFelt() — the hook renderTable() already calls, now
        backed by the implementation below.
     2. populateMobileSpec() — client.js's other, earlier mobile renderer.
        It is neutralised because it shares three ids with this screen
        (#mtCommunity, #mtPotAmount, #mtHoleCards) and, running after the
        hook, would overwrite this module's output.

   The three action buttons keep the ids client.js binds during its own
   init pass (mtActCall / mtActRaise / mtActRaiseArrow) so those bindings
   cannot throw; this module swaps each node for a listener-free clone and
   takes over their behaviour.

   NOTE: client.js still carries both older mobile renderers (the
   .mfsm/.mfc/.mfa green-felt body of populateMobileFelt, and
   populateMobileSpec) and style.css still carries their CSS. They are dead
   — the overrides above win and the elements they target no longer exist.
   The bodies stay only because client.js and style.css are too large for
   the workspace file editor, which silently refuses to patch them.
   Removing them later is a pure deletion with no behaviour change.
   ============================================================ */
(function () {
  'use strict';

  // Column order for the opponent row, left to right. The viewer sits at
  // the bottom (.mt-hero), so the remaining seats fill this row in seat
  // order and a full 6-max table renders exactly five opponents.
  var SEAT_COLUMNS = ['left', 'leftMid', 'center', 'rightMid', 'right'];

  // ------------------------------------------------------------
  // Cosmetic hand namer — the label in the viewer's hand panel.
  // Reads only the hole cards + board; never influences play.
  // A card is { rank: 2..14, suit: 's'|'h'|'d'|'c' } (see src/poker.js).
  // ------------------------------------------------------------
  var RANK_VALUE = {
    '2': 2, '3': 3, '4': 4, '5': 5, '6': 6, '7': 7, '8': 8,
    '9': 9, '10': 10, 'J': 11, 'Q': 12, 'K': 13, 'A': 14,
  };

  function rankValue(rank) {
    if (typeof rank === 'number') return rank;
    if (RANK_VALUE[rank] !== undefined) return RANK_VALUE[rank];
    var parsed = parseInt(rank, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  // Highest card of a five-card straight inside `values`, or 0 when there
  // is none. The wheel (A-2-3-4-5) counts, so an ace also plays as a 1.
  function straightHigh(values) {
    var unique = [];
    values.forEach(function (v) { if (unique.indexOf(v) < 0) unique.push(v); });
    unique.sort(function (a, b) { return b - a; });
    if (unique.indexOf(14) >= 0) unique.push(1);
    var run = 1;
    for (var i = 1; i < unique.length; i++) {
      run = unique[i] === unique[i - 1] - 1 ? run + 1 : 1;
      if (run >= 5) return unique[i] + 4;
    }
    return 0;
  }

  function namePokerHand(holeCards, communityCards) {
    var cards = (holeCards || []).concat(communityCards || []).filter(Boolean);
    if (cards.length < 2) return '';
    var byRank = {};
    var bySuit = {};
    cards.forEach(function (c) {
      var value = rankValue(c.rank);
      if (!value) return;
      byRank[value] = (byRank[value] || 0) + 1;
      (bySuit[c.suit] = bySuit[c.suit] || []).push(value);
    });
    var values = Object.keys(byRank).map(Number);
    if (!values.length) return '';
    // Rank values ordered by how many times they appear, then by value.
    var grouped = values.slice().sort(function (a, b) {
      return byRank[b] - byRank[a] || b - a;
    });
    // Only one suit can hold five or more of the (at most) seven cards.
    var flushValues = null;
    Object.keys(bySuit).forEach(function (suit) {
      if (bySuit[suit].length >= 5) flushValues = bySuit[suit];
    });
    if (flushValues && straightHigh(flushValues)) return 'Straight Flush';
    if (byRank[grouped[0]] === 4) return 'Four of a Kind';
    if (byRank[grouped[0]] === 3 && byRank[grouped[1]] >= 2) return 'Full House';
    if (flushValues) return 'Flush';
    if (straightHigh(values)) return 'Straight';
    if (byRank[grouped[0]] === 3) return 'Three of a Kind';
    if (byRank[grouped[0]] === 2 && byRank[grouped[1]] === 2) return 'Two Pair';
    if (byRank[grouped[0]] === 2) return 'Pair';
    return 'High Card';
  }

  // ------------------------------------------------------------
  // Small DOM helpers
  // ------------------------------------------------------------
  function $(id) { return document.getElementById(id); }

  function selfSeatOf(t) {
    if (!t || !t.seats) return null;
    return t.seats.find(function (s) { return s && s.isSelf; }) || null;
  }

  // One card: face-up (rank top-left, suit bottom-left) or the face-down
  // hatched back when there is no card to show yet.
  function mtCard(c) {
    if (!c) return el('div', { class: 'mt-card mt-card--down' });
    var red = SUIT_COLOR[c.suit] === 'red';
    return el('div', {
      class: 'mt-card mt-card--up' + (red ? ' mt-card--red' : ''),
    }, [
      el('span', { class: 'mt-card-rank', text: rankLabel(c.rank) }),
      el('span', { class: 'mt-card-suit', text: SUIT_GLYPH[c.suit] || '' }),
    ]);
  }

  function mtSetText(node, text) {
    if (node && node.textContent !== text) node.textContent = text;
  }

  // ------------------------------------------------------------
  // Opponent row
  // ------------------------------------------------------------
  function renderSeats(t, selfSeat) {
    var host = $('mtSeats');
    if (!host) return;
    host.innerHTML = '';

    var total = t.maxSeats || t.seats.length;
    var selfIdx = t.seats.findIndex(function (s) { return s && s.isSelf; });
    var order = [];
    if (selfIdx >= 0) {
      // Seat order starting to the viewer's left, so the row reads clockwise
      // around the table. Sizing down (2-6 handed) just leaves the tail
      // columns empty, and those stay tappable "Sit here" targets.
      for (var k = 1; k < total; k++) {
        order.push((selfIdx + k) % total);
      }
    } else {
      // Spectator: no seat of their own to anchor on, so show every seat.
      for (var s = 0; s < total; s++) order.push(s);
    }

    order.forEach(function (seatIdx, col) {
      var seat = t.seats[seatIdx];
      var occupied = !!(seat && seat.occupied && !seat.removed);
      var changing = state.changeSeatMode && !!selfSeat;

      var column = el('div', {
        class: 'mt-seat'
          + (occupied ? '' : ' mt-seat-empty')
          + (seat && seat.folded ? ' is-folded' : '')
          + (seat && seat.satOut ? ' is-out' : '')
          + (seatIdx === t.currentPlayerIndex ? ' is-turn' : '')
          + (changing && !occupied ? ' is-change-target' : ''),
        'data-pos': SEAT_COLUMNS[col] || 'right',
        'data-seat-idx': String(seatIdx),
      });
      var ring = el('div', { class: 'mt-seat-ring' });

      if (occupied) {
        var avatar = el('div', { class: 'mt-avatar' });
        if (seat.avatar) avatar.style.backgroundImage = 'url(' + seat.avatar + ')';
        else avatar.textContent = getInitials(seat.name);
        ring.appendChild(avatar);
        if (seatIdx === t.buttonIndex) {
          ring.appendChild(el('span', { class: 'mt-dealer', text: 'D', title: 'Dealer' }));
        }
        column.appendChild(ring);
        column.appendChild(el('div', { class: 'mt-seat-name', text: seat.name }));
        column.appendChild(el('div', {
          class: 'mt-seat-stack',
          text: formatNumber(seat.stack),
        }));
        // Chips the player already put in this street, printed directly under
        // their column (absolute, so it never changes the row's height).
        if (seat.contributed > 0) {
          column.appendChild(el('span', {
            class: 'mt-bet',
            text: formatNumber(seat.contributed),
            title: 'Bet this street',
          }));
        }
      } else {
        // Empty seat. On mobile this is the only way to take a seat, so it
        // doubles as the "Move here" target while change-seat mode is on.
        ring.appendChild(el('button', {
          class: 'mt-seat-status',
          type: 'button',
          text: changing ? '\u21C4' : '+',
          title: changing ? 'Move to this seat' : 'Sit here',
          'aria-label': (changing ? 'Move to seat ' : 'Sit down at seat ') + (seatIdx + 1),
          onclick: (function (target, tableId, isChanging) {
            return function () {
              if (isChanging) moveSeat(target);
              else seatEmpty(target, tableId);
            };
          })(seatIdx, t.id, changing),
        }));
        column.appendChild(ring);
        column.appendChild(el('div', {
          class: 'mt-seat-name',
          text: changing ? 'Move here' : 'Sit here',
        }));
        // Empty spacer so every column keeps the same height, which keeps the
        // bet chips below them on one line.
        column.appendChild(el('div', { class: 'mt-seat-stack', text: '' }));
      }
      host.appendChild(column);
    });
  }

  // ------------------------------------------------------------
  // Board: five community slots + pot
  // ------------------------------------------------------------
  function renderBoard(t) {
    var community = t.communityCards || [];
    var host = $('mtCommunity');
    if (host) {
      host.innerHTML = '';
      for (var i = 0; i < 5; i++) host.appendChild(mtCard(community[i]));
    }
    mtSetText($('mtPotAmount'), formatNumber(t.pot));
  }

  // ------------------------------------------------------------
  // Viewer's cards + hand panel
  // ------------------------------------------------------------
  function renderHero(t, selfSeat) {
    var hole = (selfSeat && selfSeat.holeCards && selfSeat.holeCards.length === 2)
      ? selfSeat.holeCards
      : null;

    var host = $('mtHoleCards');
    if (host) {
      host.innerHTML = '';
      if (hole) {
        hole.forEach(function (c) { host.appendChild(mtCard(c)); });
      } else {
        host.appendChild(mtCard(null));
        host.appendChild(mtCard(null));
      }
    }

    // Live hand label while the hand is running; at showdown the server's own
    // storedHandName (the same string the result banner uses) is authoritative.
    mtSetText($('mtHeroHand'), hole
      ? (selfSeat.storedHandName || namePokerHand(hole, t.communityCards))
      : '');
    mtSetText($('mtHeroName'), selfSeat ? selfSeat.name : '');
    mtSetText($('mtHeroStack'), formatNumber(selfSeat ? selfSeat.stack : 0));

    var avatar = $('mtAvatar');
    if (avatar) {
      if (selfSeat && selfSeat.avatar) {
        avatar.style.backgroundImage = 'url(' + selfSeat.avatar + ')';
        avatar.textContent = '';
      } else {
        avatar.style.backgroundImage = '';
        avatar.textContent = selfSeat ? getInitials(selfSeat.name) : '?';
      }
    }
  }

  // ------------------------------------------------------------
  // Action bar
  // ------------------------------------------------------------
  function setPanel(open) {
    var panel = $('mtActionPanel');
    var arrow = $('mtActRaiseArrow');
    if (panel) panel.classList.toggle('is-open', !!open);
    if (arrow) arrow.setAttribute('aria-expanded', open ? 'true' : 'false');
  }

  // Replaces a node with an identical copy so listeners attached by client.js
  // are dropped while its id, classes and attributes survive — cloneNode()
  // copies attributes only, never listeners.
  function swapInCleanNode(id) {
    var node = $(id);
    if (!node || !node.parentNode) return node;
    var clone = node.cloneNode(true);
    node.parentNode.replaceChild(clone, node);
    return clone;
  }

  function togglePanel() {
    var panel = $('mtActionPanel');
    setPanel(panel ? !panel.classList.contains('is-open') : false);
  }

  function renderActionBar(t, selfSeat) {
    var callBtn = $('mtActCall');
    if (!callBtn) return;
    var raiseBtn = $('mtActRaise');
    var foldBtn = $('mtFoldBtn');
    var checkBtn = $('mtCheckBtn');
    var allinBtn = $('mtAllinBtn');

    // Mirror of renderTable's own "is it my turn" test: the bar is live only
    // while the viewer is the acting player in a betting phase.
    var acting = !!selfSeat
      && t.currentPlayerIndex >= 0
      && !!t.seats[t.currentPlayerIndex]
      && !!t.seats[t.currentPlayerIndex].isSelf
      && !selfSeat.folded
      && !selfSeat.allIn
      && !selfSeat.satOut
      && (t.phase === 'pre_flop' || t.phase === 'flop'
          || t.phase === 'turn' || t.phase === 'river');

    var stack = selfSeat ? selfSeat.stack : 0;
    var toCall = acting ? Math.max(0, (t.currentBet || 0) - selfSeat.contributed) : 0;
    var maxRaise = selfSeat ? selfSeat.stack + selfSeat.contributed : 0;
    var minRaiseTotal = (t.currentBet || 0) > 0
      ? t.currentBet + Math.max(t.minRaise || t.bigBlind, t.bigBlind)
      : t.bigBlind;
    var raiseAmount = Math.min(stack, (t.currentBet || 0) > 0 ? minRaiseTotal : t.bigBlind);

    // Primary pill: Call <amount> with a bet to face, Check when there is
    // nothing to call — the same relabel the desktop bar does.
    if (acting) {
      mtSetText(callBtn, toCall > 0 ? 'Call ' + formatNumber(Math.min(stack, toCall)) : 'Check');
      callBtn.disabled = toCall > 0 && stack < toCall;
      if (raiseBtn) {
        mtSetText(raiseBtn, ((t.currentBet || 0) === 0 ? 'Bet ' : 'Raise ')
          + formatNumber(raiseAmount));
        raiseBtn.disabled = !(stack > 0 && maxRaise >= minRaiseTotal);
      }
    } else {
      mtSetText(callBtn, 'Call');
      callBtn.disabled = true;
      if (raiseBtn) {
        mtSetText(raiseBtn, 'Raise');
        raiseBtn.disabled = true;
      }
    }

    if (foldBtn) foldBtn.disabled = !acting;
    if (checkBtn) checkBtn.disabled = !acting || toCall > 0;
    if (allinBtn) {
      allinBtn.disabled = !acting || stack <= 0;
      mtSetText(allinBtn, acting && stack > 0 ? 'All-in ' + formatNumber(stack) : 'All-in');
    }

    // The expanded panel only belongs on screen while the viewer can act.
    if (!acting) setPanel(false);
  }

  // ------------------------------------------------------------
  // Header (screen-reader text for the table name + hand info)
  // ------------------------------------------------------------
  function renderHeaderInfo(t) {
    mtSetText($('mhBrand'), t.name || '');
    var bits = ['Hand #' + (t.handNumber || 0)];
    if (t.smallBlind !== undefined) bits.push('Blinds ' + t.smallBlind + '/' + t.bigBlind);
    var live = t.seats.filter(function (s) { return s.occupied && !s.removed; }).length;
    if (t.phase && t.phase !== 'waiting' && t.phase !== 'hand_over') {
      bits.push('Players ' + live + '/' + t.maxSeats);
    }
    mtSetText($('mhSub'), bits.join(' \u00B7 '));
  }

  // ------------------------------------------------------------
  // Sit out / Sit in (mobile table menu item)
  // ------------------------------------------------------------
  function renderSitOutItem(selfSeat) {
    var item = $('mtMenuSitOutItem');
    if (!item) return;
    var canSitOut = !!selfSeat && !selfSeat.folded && !selfSeat.allIn
      && !selfSeat.satOut && selfSeat.stack > 0;
    var canSitIn = !!selfSeat && selfSeat.satOut && !selfSeat.folded
      && !selfSeat.allIn && selfSeat.stack > 0;
    if (canSitIn) {
      mtSetText(item, 'Sit in');
      item.disabled = false;
    } else {
      mtSetText(item, 'Sit out');
      item.disabled = !canSitOut;
    }
  }

  // ------------------------------------------------------------
  // The mobile hook client.js's renderTable() calls on every state change.
  // ------------------------------------------------------------
  function populateMobileFelt(t, selfSeat) {
    if (!t || !t.seats) return;
    renderHeaderInfo(t);
    renderSeats(t, selfSeat);
    renderBoard(t);
    renderHero(t, selfSeat);
    renderActionBar(t, selfSeat);
    renderSitOutItem(selfSeat);
  }

  // Install the override before the first render. renderTable() references
  // this name at call time, so the mobile hook now resolves here.
  window.populateMobileFelt = populateMobileFelt;

  // client.js also carries its own mobile renderer (populateMobileSpec) for an
  // earlier markup set. It is called right after the hook above and shares
  // three ids with this screen (#mtCommunity, #mtPotAmount, #mtHoleCards), so
  // it would overwrite this renderer's output. Neutralise it.
  window.populateMobileSpec = function () {};

  // ------------------------------------------------------------
  // Wiring for the new controls. Registered after client.js's own
  // DOMContentLoaded handler, so its listeners (table menu, raise slider,
  // sizing presets) are already attached when these run.
  // ------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
    // These three ids are also bound by client.js during its own init pass
    // (call and raise with amount 0, plus an arrow that toggles the old
    // slider). client.js dereferences the ids unguarded, so they must stay in
    // the markup — swapping in a clean copy keeps the ids while dropping
    // those listeners, making this module their only source of behaviour.
    var callBtn = swapInCleanNode('mtActCall');
    var raiseBtn = swapInCleanNode('mtActRaise');
    var arrowBtn = swapInCleanNode('mtActRaiseArrow');

    if (callBtn) {
      callBtn.addEventListener('click', function () {
        if (callBtn.disabled) return;
        var t = state.currentTable;
        var selfSeat = selfSeatOf(t);
        if (!t || !selfSeat) return;
        var toCall = Math.max(0, (t.currentBet || 0) - selfSeat.contributed);
        performAction(toCall > 0 ? 'call' : 'check');
      });
    }

    if (raiseBtn) {
      raiseBtn.addEventListener('click', function () {
        if (raiseBtn.disabled) return;
        var t = state.currentTable;
        if (!t) return;
        // The minimum legal raise, exactly what the sizing row starts at.
        var bounds = state._mobileRaise || {};
        var amount = bounds.minRaiseTotal || 0;
        if (bounds.maxRaise && amount > bounds.maxRaise) amount = bounds.maxRaise;
        if (!amount) return;
        performAction((t.currentBet || 0) === 0 ? 'bet' : 'raise', amount);
      });
    }

    var foldBtn = $('mtFoldBtn');
    if (foldBtn) {
      foldBtn.addEventListener('click', function () {
        if (!foldBtn.disabled) performAction('fold');
      });
    }

    var checkBtn = $('mtCheckBtn');
    if (checkBtn) {
      checkBtn.addEventListener('click', function () {
        if (!checkBtn.disabled) performAction('check');
      });
    }

    var allinBtn = $('mtAllinBtn');
    if (allinBtn) {
      allinBtn.addEventListener('click', function () {
        if (!allinBtn.disabled) performAction('all_in');
      });
    }

    if (arrowBtn) arrowBtn.addEventListener('click', togglePanel);

    var back = $('mtBackBtn');
    if (back) back.addEventListener('click', leaveCurrentTable);

    var sitItem = $('mtMenuSitOutItem');
    if (sitItem) {
      sitItem.addEventListener('click', function () {
        closeTableMenu();
        var selfSeat = selfSeatOf(state.currentTable);
        if (selfSeat && selfSeat.satOut) sitIn();
        else sitOut();
      });
    }
  });
})();
