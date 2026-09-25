/* ============================================================
   Poker8 — desktop table renderer (>=721px)
   -----------------------------------------------------------
   Self-contained desktop table implementation. Everything here
   reads the public table_state payload and only writes DOM.
   It deliberately does NOT import, require, or call into
   public/js/table-mobile.js, so the mobile renderer stays a
   separate, independent code path.

   Scope of work:
     * Builds the desktop table section (table-info header,
       .desktop-table card, seats ring, community cards, pot,
       own-hand zone, action bar, left Stay / Leave prompt).
     * Reuses the same card naming + DOM helpers as the mobile
       renderer so behaviour stays identical.
     * The desktop action bar is labellable and enabled/disabled
       exactly like the mobile pills: live only while the viewer
       is the acting player in a betting phase.
   ============================================================ */
(function () {
  'use strict';

  // Column order for the opponent row, left to right. The
  // viewer sits at the bottom (.desktop-hero), so the remaining
  // seats fill this row in seat order and a full 6-max table
  // renders exactly five opponents.
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

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (k === 'class') node.className = v;
        else if (k === 'text') node.textContent = v;
        else if (k === 'html') node.innerHTML = v;
        else if (k === 'onclick' && typeof v === 'function') {
          node.addEventListener('click', v);
        } else if (k === 'style') {
          Object.assign(node.style, v);
        } else if (k.indexOf('on') === 0) {
          node.addEventListener(k.slice(2), v);
        } else {
          node.setAttribute(k, v);
        }
      });
    }
    (children || []).forEach(function (c) {
      if (c) node.appendChild(c);
    });
    return node;
  }

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
          + (seat && seat.joinedMidHand ? ' is-waiting' : '')
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
        // A seat taken while a hand was already running: the server flags it
        // `joinedMidHand` because that player was never dealt into the hand
        // in progress (no cards, no turn, no showdown). Show them queued for
        // the next deal instead of looking like an idle seat in the hand.
        if (seat.joinedMidHand) {
          column.appendChild(el('span', {
            class: 'mt-seat-status mt-seat-waiting',
            text: 'Waiting for next hand',
          }));
        }
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
        // Empty seat. On desktop this is the only way to take a seat, so it
        // doubles as the "Move here" target while change-seat mode is on.
        ring.appendChild(el('button', {
          class: 'mt-seat-status',
          type: 'button',
          text: changing ? '⇄' : '+',
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
    // A viewer who sat down mid-hand has no cards for this hand, so the panel
    // reports why instead of showing an empty hand name.
    mtSetText($('mtHeroHand'), selfSeat && selfSeat.joinedMidHand
      ? 'Waiting for next hand'
      : (hole
        ? (selfSeat.storedHandName || namePokerHand(hole, t.communityCards))
        : ''));
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
    mtSetText($('mhSub'), bits.join(' · '));
  }

  // ------------------------------------------------------------
  // Sit out / Sit in (desktop table menu item)
  // ------------------------------------------------------------
  function renderSitOutItem(selfSeat) {
    var item = $('mtMenuSitOutItem');
    if (!item) return;
    // A mid-hand joiner is not in the running hand, so there is nothing to
    // sit out of yet — the engine refuses the action until the next deal.
    var canSitOut = !!selfSeat && !selfSeat.folded && !selfSeat.allIn
      && !selfSeat.satOut && !selfSeat.joinedMidHand && selfSeat.stack > 0;
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
  // The desktop hook. client.js's renderTable() calls this on every state
  // change for the desktop code path.
  // ------------------------------------------------------------
  function populateDesktopFelt(t, selfSeat) {
    if (!t || !t.seats) return;
    renderHeaderInfo(t);
    renderSeats(t, selfSeat);
    renderBoard(t);
    renderHero(t, selfSeat);
    renderActionBar(t, selfSeat);
    renderSitOutItem(selfSeat);
    populateDesktopHandResult(t);
  }

  // Desktop hand-results HUD. The server already renders the outer
  // result container; this appends the "Want to leave table?" prompt with a
  // fixed Leave / Stay row. Leave → leaveCurrentTable(); Stay → no-op.
  function populateDesktopHandResult(t) {
    if (!t || !t.lastHandResults) return;
    var resultHost = $('mtHandResult');
    if (!resultHost) resultHost = $('mtHandResultBody');
    if (!resultHost) return;
    // Clear any previous prompt so a re-render does not stack buttons.
    var previous = resultHost.querySelector('.result-hud-leave-prompt');
    if (previous) previous.remove();
    var winners = t.lastHandResults.winners || [];
    if (!winners.length) return;
    var prompt = document.createElement('div');
    prompt.className = 'result-hud-leave-prompt';
    prompt.setAttribute('role', 'dialog');
    prompt.setAttribute('aria-label', 'Want to leave table?');
    prompt.appendChild(el('div', {
      className: 'result-hud-leave-label',
      text: 'Want to leave table?',
    }));
    var row = document.createElement('div');
    row.className = 'result-hud-leave-row';
    var yes = document.createElement('button');
    yes.className = 'result-hud-leave-yes';
    yes.textContent = 'Leave';
    yes.type = 'button';
    yes.addEventListener('click', function () {
      leaveCurrentTable();
    });
    var no = document.createElement('button');
    no.className = 'result-hud-leave-no';
    no.textContent = 'Stay';
    no.type = 'button';
    no.addEventListener('click', function () {
      // No-op: player stays seated and auto-joins the next hand as usual.
    });
    row.appendChild(yes);
    row.appendChild(no);
    prompt.appendChild(row);
    resultHost.appendChild(prompt);
  }

  // Install the override before the first render. client.js references these
  // names at call time, so the desktop hooks resolve here.
  window.populateDesktopFelt = populateDesktopFelt;
  window.populateDesktopHandResult = populateDesktopHandResult;

  // ------------------------------------------------------------
  // Wiring for the new controls. Registered after client.js's own DOMContentLoaded
  // handler, so its listeners are already attached when these run.
  // ------------------------------------------------------------
  document.addEventListener('DOMContentLoaded', function () {
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
