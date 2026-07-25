/* Friendly Poker - client SPA.
 *
 * Vanilla JS, no build step. Uses socket.io loaded from the server's
 * /socket.io/socket.io.js endpoint.
 *
 * State is held in a single object; render() redraws the appropriate view.
 */

'use strict';

const RANK_NAMES = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'10',11:'J',12:'Q',13:'K',14:'A' };
const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_COLOR = { s: 'black', h: 'red', d: 'red', c: 'black' };

const state = {
  socket:        null,
  player:        null,       // { id, name, points, isAdmin }
  // `isAdmin` mirrors `player.isAdmin` after register. Kept as a top-
  // level field so renderAdminView() can read it without first
  // checking that `player` is still defined (defensive against a
  // stale state.player reference during async renders).
  isAdmin:       false,
  tables:        [],         // lobby view: [{ id, name, seatsTaken, maxSeats, phase, handInProgress }]
  currentTable:  null,       // full table state if joined
  // Admin room state. `adminRoom.sessions` is the most recent
  // admin_list_sessions payload (used to re-render after a settings
  // save). `adminRoom.editorTableId` is the currently-open editor's
  // tableId (null when collapsed). `_house` caches the admin-house
  // info from admin_get_house_info so the header chip doesn't re-fetch
  // on every view re-render.
  adminRoom: {
    sessions: [],
    editorTableId: null,
    house: null,         // { name, id, points } | null | 'missing'
  },
  leaderboardData: null,     // last /api/leaderboard payload, used for re-renders
  view:          'login',    // 'login' | 'lobby' | 'table' | 'admin'
  toastTimer:    null,
  toastType:     null,
  pendingError:  null,
  // Showdown modal state.
  // - `showdownWindow`: { handNumber, expiresAt, closed } | null — the
  //   active 20s showdown window for the current hand. Set when the
  //   modal first pops; flipped to `closed: true` when the timer fires
  //   (so a re-render during the same hand doesn't pop a fresh modal);
  //   nulled only on phase transitions out of hand_over, on leave-table,
  //   or on busted-refund. applySeatBanners + maybeShowShowdown gate on
  //   this slot + the samehand check.
  // - `showdownModalTimer`: setTimeout handle, cancelled on leave /
  //   clearShowdown. The timer is the ONLY close path for the live
  //   showdown modal — players have no way to dismiss it before the
  //   20 seconds elapse (no Escape, no close button, no click-outside)
  //   per the design contract.
  showdownWindow: null,
  showdownModalTimer: null,
  // Admin-login reentrancy state. `adminLoginPending` gates rapid
  // click/Enter repeats of admin_login (the button's disabled UI
  // state doesn't help when Enter is pressed on the password input).
  // `adminLoginTimer` is a 5s safety fallback that clears the pending
  // flag if the socket disconnects mid-request / the server never
  // replies — prevents the user being locked out of the admin modal
  // until page reload. Cleared normally by the emit callback; the
  // fallback only matters when the callback never arrives.
  adminLoginPending: false,
  adminLoginTimer: null,
};

const socket = io({ reconnection: true });
state.socket = socket;

// ---------- Utilities ----------

function $(id) { return document.getElementById(id); }
function el(tag, attrs = {}, children = []) {
  const e = document.createElement(tag);
  for (const k in attrs) {
    if (k === 'class') e.className = attrs[k];
    else if (k === 'text') e.textContent = attrs[k];
    else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
    else e.setAttribute(k, attrs[k]);
  }
  // Accept children as a flat list OR a (possibly nested) array of nodes/strings.
  // This guards against accidentally passing the result of .map() inside another array,
  // which would otherwise hit appendChild with an Array instead of a Node.
  const list = Array.isArray(children) ? children : [children];
  for (const c of list.flat(Infinity)) {
    if (c == null) continue;
    if (typeof c === 'string') e.appendChild(document.createTextNode(c));
    else e.appendChild(c);
  }
  return e;
}

function showToast(message, type = 'info') {
  const t = $('toast');
  if (!t) return;
  t.textContent = message;
  t.className = 'toast ' + type;
  t.style.display = 'block';
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { t.style.display = 'none'; }, 3000);
}

function formatNumber(n) {
  // Format chips with thousand separators.
  return String(Math.floor(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function rankLabel(rank) { return RANK_NAMES[rank] || String(rank); }

// ---------- View switching ----------

function setView(v) {
  state.view = v;
  // Include view-admin here so the Admin Room button's setView('admin')
  // call actually un-hides the section. Without this entry the forEach
  // loop iterates only the public-game views and never touches
  // #view-admin, which stays at its HTML default of display:none.
  ['view-login', 'view-lobby', 'view-table', 'view-admin'].forEach(id => {
    const node = $(id);
    if (node) node.style.display = (id === 'view-' + v) ? '' : 'none';
  });
  $('topInfo').style.display = (v === 'login') ? 'none' : '';
}

function updateTopBar() {
  if (!state.player) return;
  $('playerChip').textContent = state.player.name;
  $('pointsChip').textContent = formatNumber(state.player.points) + ' pts';
}

// ---------- Login view ----------

async function loadRandomNames() {
  try {
    const r = await fetch('/api/random-names');
    const data = await r.json();
    renderRandomNames(data.names || []);
  } catch (e) { renderRandomNames([]); }
}

function renderRandomNames(names) {
  const list = $('randomNameList');
  list.innerHTML = '';
  if (!names.length) {
    list.appendChild(el('span', { class: 'muted small', text: 'No random names right now.' }));
    return;
  }
  names.forEach(name => {
    list.appendChild(el('span', {
      class: 'name-pill',
      text: name,
      title: 'Click to use this name',
      onclick: () => selectRandomName(name),
    }));
  });
}

function selectRandomName(name) {
  $('loginName').value = name;
  Array.from(document.querySelectorAll('.name-pill')).forEach(p => {
    p.classList.toggle('selected', p.textContent === name);
  });
}

async function doLogin() {
  const name = $('loginName').value.trim();
  if (!name) { showToast('Please enter a name', 'error'); return; }
  socket.emit('register', { name }, res => {
    if (res && res.ok) {
      state.player = res.player;
      state.isAdmin = res.player.isAdmin === true;
      try { localStorage.setItem('pokerName', state.player.name); } catch (e) {}
      updateTopBar();
      syncAdminButtonVisibility();
      setView('lobby');
      socket.emit('random_names'); // refresh names for next time
    } else {
      showToast(res && res.error ? res.error : 'Login failed', 'error');
    }
  });
}

// Top-bar Admin button is visible for EVERYONE (not gated on
// state.isAdmin) so every host can attempt the shared-password login.
// Per-user Player.isAdmin still works as a parallel gate: those users
// get socket.data.isAdmin=true at register time and skip the modal.
// Server rejects every admin_* event unless socket.data.isAdmin is set,
// so showing the button to everyone is purely a UX gate.
function syncAdminButtonVisibility() {
  const btn = $('adminBtn');
  if (!btn) return;
  btn.style.display = '';
  btn.title = 'Open the admin panel';
}

// ----- Legacy shared-password admin modal -----
//
// Clicking the top-bar Admin button opens #adminModal with a password
// input. The form posts the password to socket.emit('admin_login',
// { password }, cb). On success the login section is hidden and
// #adminContent (player table + change-password + starting stack) is
// revealed; the existing refreshAdminList / doAdd / doSet / doRemove
// helpers drive the player table. Close dismisses the modal without
// un-setting socket.data.isAdmin (the admin session stays active for
// the lifetime of the socket).
function openAdminModal() {
  const modal = $('adminModal');
  if (!modal) return;
  // Reset both halves so a stale "fail" message doesn't leak across
  // opens. Login section visible, content hidden.
  $('adminLoginSection').style.display = '';
  $('adminContent').style.display = 'none';
  const err = $('adminLoginError');
  if (err) { err.style.display = 'none'; err.textContent = ''; }
  if ($('adminPasswordInput')) $('adminPasswordInput').value = '';
  modal.style.display = '';
  setTimeout(() => $('adminPasswordInput').focus(), 0);
}

function closeAdminModal() {
  const modal = $('adminModal');
  if (!modal) return;
  modal.style.display = 'none';
  if ($('adminOldPassword'))  $('adminOldPassword').value = '';
  if ($('adminNewPassword'))  $('adminNewPassword').value = '';
  $('adminActionFeedback').textContent = '';
}

// JS-level pending flag so the Enter-key handler can also honour
// the reentrancy guard (the button's disabled UI state doesn't help
// when the user presses Enter on the password input). Stored on
// `state` to match the convention used by every other mutable in
// this file (state.player, state.isAdmin, state.currentTable, etc.)
// and reset by a 5s timeout fallback so a mid-request socket
// disconnect / server-side timeout can't leave the user locked out.
function submitAdminPassword() {
  if (state.adminLoginPending) return;
  const input = $('adminPasswordInput');
  const password = input ? input.value : '';
  const errEl = $('adminLoginError');
  const loginBtn = $('adminLoginBtn');
  // Reentrancy guard: disable the button while the request is in
  // flight so rapid clicks / Enter presses don't fire multiple
  // admin_login emits. Server-side is idempotent (sets
  // socket.data.isAdmin=true on every match), but the UI flicker +
  // multiple round-trips would be ugly.
  if (loginBtn) loginBtn.disabled = true;
  state.adminLoginPending = true;
  // Safety fallback: if the server never replies (socket disconnect,
  // server crash, network blip) the callback below would never fire
  // and the user would be locked out of the admin modal until page
  // reload. Clear the flag after 5s so the next attempt can proceed.
  // Cleared normally by the emit callback below; the fallback only
  // matters if the callback never arrives.
  state.adminLoginTimer = setTimeout(() => {
    state.adminLoginPending = false;
    state.adminLoginTimer = null;
    if (loginBtn) loginBtn.disabled = false;
  }, 5000);
  socket.emit('admin_login', { password }, res => {
    if (loginBtn) loginBtn.disabled = false;
    state.adminLoginPending = false;
    if (state.adminLoginTimer) {
      clearTimeout(state.adminLoginTimer);
      state.adminLoginTimer = null;
    }
    if (res && res.ok) {
      // Promote the client mirror so renderAdminPlayers' isAdmin
      // badges (informational) read as truth. Server is the gate;
      // this only affects local UX.
      state.isAdmin = true;
      $('adminLoginSection').style.display = 'none';
      $('adminContent').style.display = '';
      setAdminFeedback('Unlocked. Manage players below.');
      refreshAdminList();
      // Pre-populate the global starting-stack input with the server's
      // current value so the host can see + tweak it without guessing.
      const startingInput = $('adminStartingStack');
      if (startingInput && typeof res.startingStack === 'number') {
        startingInput.value = String(res.startingStack);
      }
    } else {
      if (errEl) {
        errEl.textContent = (res && res.error) ? res.error : 'Login failed';
        errEl.style.display = '';
      }
    }
  });
}

function submitChangePassword() {
  const oldPwd = $('adminOldPassword').value;
  const newPwd = $('adminNewPassword').value;
  if (!oldPwd || !newPwd) {
    setAdminFeedback('Fill both password fields.');
    return;
  }
  socket.emit('admin_change_password', { oldPassword: oldPwd, newPassword: newPwd }, res => {
    if (res && res.ok) {
      $('adminOldPassword').value = '';
      $('adminNewPassword').value = '';
      setAdminFeedback('Password changed.');
    } else {
      setAdminFeedback((res && res.error) ? res.error : 'Failed to change password');
    }
  });
}

// Account switching is intentionally disabled: once a device registers, the
// name in localStorage is the only identity for that device. The only way to
// "switch" is to clear browser data. See public/index.html (no Switch user
// button) and server.js (the cached name is what gets sent on every connect).

// ---------- Lobby view ----------

function renderLobby() {
  const grid = $('tablesGrid');
  grid.innerHTML = '';
  if (!state.tables.length) {
    grid.appendChild(el('div', { class: 'muted small', text: 'No tables yet. Be the first to create one below.' }));
    return;
  }
  state.tables.forEach(t => {
    const cap = t.maxSeats;
    const live = t.seatsTaken;
    const phaseLabel = t.handInProgress ? 'In hand' : 'Waiting';
    const isFull = live >= cap;
    const card = el('div', { class: 'table-card' }, [
      el('div', { class: 'name', text: t.name }),
      el('div', { class: 'meta' }, [
        el('span', { class: 'chip', text: `${live}/${cap} seats` }),
        el('span', { class: 'chip' + (t.handInProgress ? ' live' : ''), text: phaseLabel }),
        el('span', { class: 'chip', text: `Blinds ${t.smallBlind}/${t.bigBlind}` }),
      ]),
      el('div', { class: 'row' }, []),
    ]);
    if (!isFull) {
      const joinBtn = el('button', {
        class: 'primary-btn',
        text: 'Join',
        onclick: () => joinTable(t.id, null),
      });
      card.appendChild(joinBtn);
    } else {
      card.appendChild(el('span', { class: 'muted small', text: 'Full' }));
    }
    grid.appendChild(card);
  });
}

function createTable() {
  const name = $('newTableName').value.trim();
  const sb = parseInt($('newTableSB').value, 10);
  const bb = parseInt($('newTableBB').value, 10);
  const ms = parseInt($('newTableSeats').value, 10);
  socket.emit('create_table', { name, smallBlind: sb, bigBlind: bb, maxSeats: ms }, res => {
    if (res && res.ok) {
      $('newTableName').value = '';
      showToast('Table created', 'good');
    } else {
      showToast(res && res.error ? res.error : 'Failed to create', 'error');
    }
  });
}

function joinTable(tableId, seatIdx) {
  socket.emit('join_table', { tableId, seatIdx }, res => {
    if (res && res.ok) {
      setView('table');
    } else {
      showToast(res && res.error ? res.error : 'Failed to join', 'error');
    }
  });
}

// ---------- Table view ----------

function seatPosition(idx, total, maxSeats) {
  // Place seats equally around the oval table, starting from the top going
  // clockwise. Returns CSS position values.
  if (total <= 1) return { left: '50%', top: '50%', transform: 'translate(-50%, -50%)' };
  const angle = -Math.PI / 2 + (2 * Math.PI * idx / total);
  const xRad = 0.42;
  const yRad = total >= 6 ? 0.34 : (total >= 4 ? 0.36 : 0.34);
  const x = 50 + xRad * 100 * Math.cos(angle);
  const y = 50 + yRad * 100 * Math.sin(angle);
  return {
    left: x.toFixed(2) + '%',
    top:  y.toFixed(2) + '%',
    transform: 'translate(-50%, -50%)',
  };
}

function renderTable() {
  const t = state.currentTable;
  if (!t) return;

  $('tableName').textContent = t.name;
  const infoBits = [];
  infoBits.push(`Hand #${t.handNumber || 0}`);
  if (t.smallBlind !== undefined) infoBits.push(`Blinds ${t.smallBlind}/${t.bigBlind}`);
  if (t.phase && t.phase !== 'waiting' && t.phase !== 'hand_over') infoBits.push(`Players ${t.seats.filter(s=>s.occupied && !s.removed).length}/${t.maxSeats}`);
  $('handInfo').textContent = infoBits.join(' \u00B7 ');

  $('potAmount').textContent = formatNumber(t.pot);

  const phaseLabel = ({
    waiting: 'Waiting for players',
    pre_flop: 'Pre-flop betting',
    flop: 'Flop betting',
    turn: 'Turn betting',
    river: 'River betting',
    showdown: 'Showdown',
    hand_over: 'Hand complete',
  })[t.phase] || t.phase;
  $('phaseDisplay').textContent = phaseLabel;

  // Community cards
  const ccHost = $('communityCards');
  ccHost.innerHTML = '';
  (t.communityCards || []).forEach((c, i) => {
    ccHost.appendChild(renderCard(c, { delay: i * 80 }));
  });
  for (let i = (t.communityCards || []).length; i < 5; i++) {
    ccHost.appendChild(el('div', { class: 'empty-card' }));
  }

  // Hand result banner
  const hr = $('handResult');
  hr.style.display = 'none';
  hr.innerHTML = '';
  if (t.phase === 'hand_over' && t.lastHandResults) {
    hr.style.display = '';
    const winners = t.lastHandResults.winners || [];
    if (winners.length === 1) {
      const w = winners[0];
      hr.textContent = `${w.name} wins ${formatNumber(w.share)} with ${w.handName}`;
    } else {
      const names = winners.map(w => `${w.name} (${w.handName})`).join(', ');
      hr.textContent = `Split pot: ${names}`;
    }
  }

  // Seats
  const seatsHost = $('seatsContainer');
  seatsHost.innerHTML = '';
  const N = t.maxSeats;
  let playerSeatedHere = false;
  t.seats.forEach((seat, i) => {
    // A seat with `removed` or `disconnected === true` is server-side a stale
    // occupant that the lobby's seatsTaken count already excludes — see
    // server.js#listTables and server.js#join_table. Render it as the same
    // "Sit here" empty-chair the lobby advertises so the view stays
    // consistent; otherwise the player sees an occupied-looking chair with
    // a "Removed"/"Disconnected" status label, thinks "nobody is sitting",
    // and the server can still toast "Seat taken" if they tried to sit there.
    if (seat && seat.occupied && !seat.removed && !seat.disconnected) {
      if (seat.isSelf) playerSeatedHere = true;
      const seatEl = renderSeat(seat, i, t, N);
      seatsHost.appendChild(seatEl);
    } else {
      // Take-a-seat pill: subtle empty chair with a + icon and "Sit here" label.
      // The label is hidden on narrow viewports (≤480px via CSS) so it never
      // truncates mid-character ("...ere").
      const emptyEl = el('div', {
        class: 'empty-seat',
        title: 'Click to sit here',
        onclick: () => seatEmpty(i, t.id),
      }, [
        el('span', { class: 'empty-seat-icon', text: '+', 'aria-hidden': 'true' }),
        el('span', { class: 'empty-seat-label', text: 'Sit here' }),
      ]);
      Object.assign(emptyEl.style, seatPosition(i, N));
      seatsHost.appendChild(emptyEl);
    }
  });

  // Sit-out / Sit-in buttons for self
  const selfSeat = t.seats.find(s => s.occupied && s.isSelf);
  // Self-panel: populated any time the viewer is seated so it's ready when
  // the viewport narrows. CSS hides the element entirely on desktop and
  // shows it as a prominent "your hand" card on phones/tablets, where the
  // self seat is also hidden from the .seats row to keep the opponents
  // strip from being cluttered by the viewer's own pill.
  populateSelfPanel($('selfPanel'), selfSeat, t);

  $('sitOutBtn').style.display = (selfSeat && !selfSeat.folded && !selfSeat.allIn && !selfSeat.satOut && selfSeat.stack > 0) ? '' : 'none';
  // Sit-in only makes sense between hands (not folded / not all-in for current round).
  $('sitInBtn').style.display  = (selfSeat && selfSeat.satOut && !selfSeat.folded && !selfSeat.allIn && selfSeat.stack > 0) ? '' : 'none';

  // Action bar: enable only on viewer's turn.
  const showAct = !!selfSeat
    && t.currentPlayerIndex >= 0
    && t.seats[t.currentPlayerIndex]
    && t.seats[t.currentPlayerIndex].isSelf
    && !selfSeat.folded
    && !selfSeat.allIn
    && !selfSeat.satOut
    && (t.phase === 'pre_flop' || t.phase === 'flop' || t.phase === 'turn' || t.phase === 'river');
  $('actionBar').classList.toggle('disabled', !showAct);

  // Compute legal action availability for current seat
  if (showAct) {
    setupActionButtons(selfSeat, t);
  } else {
    disableAllActions();
  }

  // Chat panel: rendered after seats so the messages reflect whatever
  // state.currentTable.chatMessages just got (publicView now includes it
  // on every table_state broadcast, so a new join into an empty table
  // re-renders an empty panel naturally).
  renderChat();
  // Spectators (joined the table room but not seated) see the chat but
  // can't send — updateChatReadOnly toggles the .read-only class so CSS
  // dims + disables the input + send button.
  updateChatReadOnly();
  // Showdown UI: pop the centered modal + light per-seat banners when
  // the engine reports phase=hand_over with a non-null lastHandResults.
  // Special-cases a fold-out (every winner's handName === 'Won by fold')
  // → skip the modal, keep the lighter per-seat banner only. Called at
  // the very bottom so it's the last visual layer to settle after every
  // renderTable invocation. Idempotent across re-renders.
  maybeShowShowdown(t);
}

function renderSeat(seat, idx, table, total) {
  const isActive = idx === table.currentPlayerIndex;
  const classes = ['seat'];
  if (isActive) classes.push('is-active');
  if (seat.isSelf) classes.push('is-self');
  const wrap = el('div', { class: classes.join(' ') });
  Object.assign(wrap.style, seatPosition(idx, total));

  const nameClasses = ['name'];
  if (idx === table.buttonIndex) nameClasses.push('dealer-mark');
  if (idx === table.sbIndex)     nameClasses.push('sb-mark');
  if (idx === table.bbIndex)     nameClasses.push('bb-mark');

  const ringChildren = [
    el('div', { class: nameClasses.join(' '), text: seat.name }),
  ];
  let statusText = seat.stack >= 0 ? formatNumber(seat.stack) + ' pts' : '';
  let statusClass = [];
  if (seat.folded)  statusClass.push('folded',  'Folded');
  else if (seat.allIn)   statusClass.push('all-in',  'All-in');
  else if (seat.satOut)  statusClass.push('sat-out', 'Sitting out');
  ringChildren.push(el('div', { class: 'status ' + statusClass.join(' '),
    text: statusText + (statusClass.length > 0 ? ' \u00B7 ' + statusClass[1] : '') }));

  // Cards: real faces whenever the server has populated `seat.holeCards`,
  // face-down card backs otherwise. The server's publicView populates this
  // for (a) the seat's owner in any phase, and (b) every non-folded seat
  // during the showdown window (hand_over + lastHandResults) so all
  // viewers can see everyone else's hole cards after the betting ends.
  // Folded seats stay face-down (the muck). The CSS already has a
  // `.card.face-down` design prepared in style.css — we just plug into it
  // here so cards never render as blank placeholder boxes.
  const cardEls = (seat.holeCards && seat.holeCards.length > 0)
    ? seat.holeCards.map((c, i) => renderCard(c, { delay: i * 80, small: true }))
    : [renderCard(null, { small: true, faceDown: true }),
       renderCard(null, { small: true, faceDown: true })];
  ringChildren.push(el('div', { class: 'cards' }, cardEls));

  // ONE seat-ring holding name + status + cards. Earlier this looped
  // over each child and wrapped each in its OWN seat-ring, producing 3
  // stacked pills per seat — the cards pill fell to the bottom of the
  // visible area and the user reported "cards don't show". The single
  // buildRing(...ringChildren) call below folds all siblings into one
  // ring so the seat reads as name + status + cards inside one pill.
  wrap.appendChild(buildRing(...ringChildren));
  // Showdown banner: a floating pill anchored above the seat that lights
  // up for the same undismissable showdown window the modal uses (10
  // seconds; same contract — no close path until the timer expires).
  // Empty by default; `applySeatBanners` below fills the text + .show
  // class when the engine reports the hand-over state. We don't gate
  // its construction on hand-over so a re-render mid-window
  // (chat_update, action ack, etc.) keeps the element in place —
  // only the classes/text toggle.
  wrap.appendChild(el('div', { class: 'seat-banner', 'data-seat-idx': idx }));
  return wrap;
}

function buildRing(...kids) {
  const ring = el('div', { class: 'seat-ring' });
  kids.forEach(k => ring.appendChild(k));
  return ring;
}

function renderCard(c, opts = {}) {
  // Real playing card layout: rank + small suit pair in top-left and
  // bottom-right corners (the bottom corner is mirrored via CSS rotate so
  // the rank reads correctly when the card faces the player), with a large
  // suit glyph centered. Face-down cards use the existing purple back
  // design (.card.face-down in style.css) and skip these elements.
  // `opts.faceDown` is also implied when no card data is available.
  const faceDown = !!opts.faceDown || !c;
  const card = el('div', {
    class: (faceDown ? 'card face-down' : 'card' + (SUIT_COLOR[c.suit] === 'red' ? ' red' : ''))
         + (opts.small ? ' card-small' : '')
         + ' fade-in',
  });
  if (!faceDown) {
    const rank = rankLabel(c.rank);
    // Add an extra class for "10" so CSS can tighten the corner spacing
    // (two-character rank fits less comfortably than a single glyph).
    const rankClass = 'rank' + (rank === '10' ? ' is-ten' : '');
    const suit = SUIT_GLYPH[c.suit];
    card.appendChild(el('div', { class: 'corner top' }, [
      el('div', { class: rankClass, text: rank }),
      el('div', { class: 'suit', text: suit }),
    ]));
    card.appendChild(el('div', { class: 'center-suit', text: suit }));
    card.appendChild(el('div', { class: 'corner bottom' }, [
      el('div', { class: rankClass, text: rank }),
      el('div', { class: 'suit', text: suit }),
    ]));
  }
  return card;
}

function populateSelfPanel(panelEl, seat, t) {
  // Populate the mobile-only "your hand" panel with the viewer's own cards
  // and identity. Always invoked from renderTable (CSS hides the element on
  // desktop) so the data is ready the moment the viewport narrows below the
  // stacked-mobile breakpoint. When `seat` is null (observer mode or pre-join)
  // the panel is emptied — CSS already hides the empty container.
  if (!panelEl) return;
  panelEl.innerHTML = '';
  if (!seat) { panelEl.classList.remove('is-active'); return; }
  const sidx = t.seats.findIndex((s) => s && s.isSelf);
  // Mobile "your turn" cue: since .seat.is-self is hidden on phones, the
  // .self-panel needs its own active-glow so the viewer has a visual cue
  // when currentPlayerIndex points at them. CSS mirrors the desktop
  // .seat.is-active gold-glow recipe on .self-panel.is-active.
  panelEl.classList.toggle('is-active', sidx >= 0 && sidx === t.currentPlayerIndex);
  const info = el('div', { class: 'self-info' });
  info.appendChild(el('div', { class: 'self-name' }, seat.name));
  info.appendChild(el('div', { class: 'self-stack' }, formatNumber(seat.stack) + ' pts'));
  let status = '';
  if (seat.folded)      status = 'Folded';
  else if (seat.allIn)  status = 'All-in';
  else if (seat.satOut) status = 'Sitting out';
  if (status) info.appendChild(el('div', { class: 'self-status' }, status));
  const marks = [];
  if (sidx === t.buttonIndex) marks.push('Dealer (D)');
  if (sidx === t.sbIndex)     marks.push('Small Blind');
  if (sidx === t.bbIndex)     marks.push('Big Blind');
  if (marks.length) info.appendChild(el('div', { class: 'self-marks' }, marks.join(' \u00B7 ')));

  const cards = el('div', { class: 'self-cards' });
  if (seat.holeCards && seat.holeCards.length === 2) {
    seat.holeCards.forEach((c, i) => cards.appendChild(renderCard(c, { delay: i * 80 })));
  } else {
    cards.appendChild(renderCard(null, { faceDown: true }));
    cards.appendChild(renderCard(null, { faceDown: true }));
  }
  panelEl.appendChild(info);
  panelEl.appendChild(cards);
}

// ---------- Chat panel ----------

function renderChat() {
  const t = state.currentTable;
  if (!t) return;
  const host = $('chatMessages');
  if (!host) return;
  // Auto-scroll on new messages only if the user is already at the bottom
  // (within 40px tolerance) — if they've scrolled up to read history, we
  // leave them alone so they don't get yanked away.
  const wasAtBottom = isScrolledToBottom(host);
  host.innerHTML = '';
  for (const m of (t.chatMessages || [])) {
    host.appendChild(renderChatMessage(m));
  }
  if (wasAtBottom) host.scrollTop = host.scrollHeight;
}

function renderChatMessage(m) {
  // All text is rendered via the el() helper's textContent path, never
  // innerHTML, so the server is the sole sanitizer. rooms.addChatMessage
  // trims, replaces newlines, and slices to 200 chars.
  if (m.kind === 'system') {
    return el('div', { class: 'chat-msg chat-system', text: m.text });
  }
  return el('div', { class: 'chat-msg chat-user' }, [
    el('span', { class: 'chat-from', text: m.from }),
    el('span', { class: 'chat-text', text: ': ' + m.text }),
  ]);
}

function isScrolledToBottom(el) {
  return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
}

function sendChat() {
  const t = state.currentTable;
  if (!t) return;
  // Spectators (in the table room but not seated) can't send. Blocks chat
  // spam + the "I saw his screen" collusion vector that poker sites
  // typically ban outright. Input is also dimmed via CSS via the
  // .read-only class so the constraint is visible.
  const selfSeat = t.seats.find(s => s && s.occupied && s.isSelf);
  if (!selfSeat) return;
  const input = $('chatInput');
  const text = input.value;
  if (!text.trim()) { input.value = ''; return; }
  socket.emit('chat_message', { tableId: t.id, text }, res => {
    if (res && res.ok) {
      input.value = '';
    } else {
      showToast(res && res.error ? res.error : 'Send failed', 'error');
    }
  });
}

function updateChatReadOnly() {
  // Toggles .read-only on the panel so CSS can dim/disable the input for
  // spectators (in the table room but not seated). Called from
  // renderTable so it stays in sync with seat changes.
  const t = state.currentTable;
  const panel = $('chatPanel');
  if (!panel) return;
  const selfSeat = t && t.seats && t.seats.find(s => s && s.occupied && s.isSelf);
  panel.classList.toggle('read-only', !selfSeat);
}

function seatEmpty(seatIdx, tableId) {
  socket.emit('join_table', { tableId, seatIdx }, res => {
    if (res && res.ok) setView('table');
    else showToast(res && res.error ? res.error : 'Could not sit', 'error');
  });
}

function leaveCurrentTable() {
  socket.emit('leave_table', null, res => {
    if (res && res.ok) {
      state.currentTable = null;
      // Tear down any in-flight showdown modal + timer so leaving mid-hand
      // doesn't strand a 20-second timer that would re-render an empty
      // lobby once it fires.
      clearShowdown();
      setView('lobby');
    } else {
      showToast(res && res.error ? res.error : 'Could not leave', 'error');
    }
  });
}

function sitOut() {
  socket.emit('sit_out', null, res => {
    if (!res || !res.ok) showToast(res && res.error ? res.error : 'Failed', 'error');
  });
}
function sitIn() {
  socket.emit('sit_in', null, res => {
    if (!res || !res.ok) showToast(res && res.error ? res.error : 'Failed', 'error');
  });
}

// per-seat banners back.
function maybeShowShowdown(t) {
  // Cleanup early if we're not in a real showdown state. Covers:
  //   - phasse !== 'hand_over' (next hand started, table empty, etc.)
  //   - lastHandResults === null (busted-refund hands the engine nulls)
  //   - lastHandResults.winners empty/missing (defensive)
  if (!t || t.phase !== 'hand_over' || !t.lastHandResults
      || !Array.isArray(t.lastHandResults.winners)
      || t.lastHandResults.winners.length === 0) {
    clearShowdown();
    return;
  }

  // Fold-out distinction: every winner reports handName === 'Won by
  // fold' (engine sets this when there was no 5-card board to score
  // against — players were eliminated by fold before the river).
  // Modal is suppressed (nothing to reveal) but the per-seat fold
  // banner still lights up.
  const isFoldout = t.lastHandResults.winners.every(
    (w) => w.handName === 'Won by fold'
  );

  // WindowActive: true only while the showdown window is open for
  // THIS handNumber. Checked on every render so banners stay synced
  // with the timer — after the timer fires, the next render clears
  // them (no stale "WON" pill lingering on a fresh WAITING phase).
  // The window is undismissable: there's no player action that
  // shortens it.
  const windowActive = state.showdownWindow
    && state.showdownWindow.handNumber === t.handNumber
    && Date.now() < state.showdownWindow.expiresAt;

  if (windowActive) {
    // Apply or refresh per-seat banners (solely based on the public
    // payload — no server fetch).
    applySeatBanners(t);
  } else {
    // The window expired / was never armed. If we're in a fold-out,
    // we still want the per-seat fold banner; otherwise strip them.
    if (isFoldout) {
      applySeatBanners(t);
    } else {
      clearSeatBanners();
    }
  }

  if (isFoldout) {
    // Skip the centered modal — there's nothing to reveal. The
    // per-seat banner above already shows the outcome.
    hideShowdownModal();
    return;
  }

  // Re-arm gate: once we've shown the modal for this handNumber,
  // don't re-show it after the 20s timer fires. The check is keyed
  // on handNumber (not just windowActive) so a re-render that arrives
  // AFTER the timer nulls `state.showdownWindow` can't pop a fresh
  // modal and schedule a fresh timer — the slot is now stamped
  // `closed: true` rather than nulled, so the gate still fires.
  //
  // Ownership contract: `state.showdownWindow` is owned EXCLUSIVELY
  // by `maybeShowShowdown` (set here on first arm, flipped to
  // `closed: true` in the timer body, nulled only via `clearShowdown`).
  // `applySeatBanners` and all other call sites READ the slot but
  // never WRITE it. This keeps the early-return above correct: any
  // non-null slot for this handNumber is guaranteed to mean "we've
  // already processed this hand".
  const samehand = state.showdownWindow
    && state.showdownWindow.handNumber === t.handNumber;
  if (samehand) {
    // Already processed this hand (active or closed). Leave the
    // modal/banners in their current state — applySeatBanners above
    // has already conditionally cleared or applied them.
    return;
  }

  // First occurrence for this hand — arm the window + show modal +
  // schedule the close. `closed: false` marks the active phase. The
  // timer callback flips it to `closed: true` so the re-arm gate
  // above recognises the hand as already-processed rather than
  // triggering a fresh show.
  state.showdownWindow = {
    handNumber: t.handNumber,
    expiresAt: Date.now() + 20000,
    closed: false,
  };
  showShowdownModal(t);

  if (state.showdownModalTimer) clearTimeout(state.showdownModalTimer);
  // 20-second timer is the ONLY close path for the modal — see the
  // contract at the top of this section. Players cannot dismiss the
  // showdown modal themselves; it dismisses on this timer alone.
  state.showdownModalTimer = setTimeout(() => {
    state.showdownModalTimer = null;
    // Flip the slot to a closed sentinel: same handNumber, closed=true.
    // We DO NOT null the slot here; the re-arm gate above keys on
    // handNumber + this flag so a subsequent re-render can't re-pop
    // the modal mid-window. Only `clearShowdown()` (called on
    // next-hand, leave-table, or non-hand-over phase transitions)
    // nils the slot.
    if (state.showdownWindow
        && state.showdownWindow.handNumber === t.handNumber) {
      state.showdownWindow.closed = true;
    }
    hideShowdownModal();
    // Re-render so the .seat-banner fade-out runs as a CSS transition
    // (not a snap). Only fire if the user is still on this table to
    // avoid stirring the renderer from the background.
    if (state.view === 'table'
        && state.currentTable
        && state.currentTable.id === t.id) {
      renderTable();
    }
  }, 20000);
}

function showShowdownModal(t) {
  const modal = $('showdownModal');
  if (!modal) return;
  // Re-populate on every modal show — even for the first time within
  // the 20s window we want the modal contents to track the latest
  // table_state payload (e.g. holeCards reveal just arrived).
  populateShowdownModal(t);
  // Contract: the modal is undismissable for the full 20-second
  // window. We rely on the CSS default `pointer-events: auto` on the
  // `.modal` element so the dark inset-0 backdrop absorbs every click
  // in the modal area. That blocks click-through to the underlying
  // UI (Leave table, chat, sit-out/sit-in, action bar) for the
  // duration of the window. Without an inline override here, no
  // restore is needed on hide — the CSS default still applies after
  // display:none; we'd only need to reset pointerEvents if we had
  // previously mutated it (we don't, so we don't).
  //
  // No click-outside-to-close handler is registered on `#showdownModal`
  // (intentionally — the leaderboard modal has the click-backdrop-
  // close pattern, this one does NOT). If a future change adds such
  // a listener here, remove it: would contradict the undismissable
  // contract. Use the leaderboard pattern as a reference for what
  // NOT to copy.
  modal.style.display = '';
}

function hideShowdownModal() {
  const modal = $('showdownModal');
  if (modal) modal.style.display = 'none';
  // Intentionally does NOT touch seat banners. Banner state is
  // managed by `clearSeatBanners` (called from `clearShowdown` on
  // phase-transition / leave-table / busted-refund, and from the
  // post-timer re-render path through `maybeShowShowdown`'s
  // else-branch) and by `applySeatBanners` (per-seat eligibility
  // filtering, bulk-style clearing of ineligible seats inline).
  // This function only hides the modal element — keeping the two
  // concerns separate lets the two teardown paths (post-timer
  // expiry vs. mid-window leave) evolve independently.
}

// Tear down all showdown UI: modal + banners + window + timer. Called
// from two places: (1) `leaveCurrentTable` for an explicit mid-window
// leave, and (2) the early-cleanup branch at the top of
// `maybeShowShowdown` for phase transitions out of hand_over,
// busted-refund (lastHandResults cleared), or missing-winners defensive
// cleanup. The 20s post-timer re-render path (timer body in
// `maybeShowShowdown`'s setTimeout → `renderTable()` → re-enters
// `maybeShowShowdown`'s else-branch + `clearSeatBanners`) is
// intentionally NOT routed here — the two teardown paths differ so a
// mid-window leave doesn't tear down state the same way as a clean
// post-timer expiry.

// ---------- Init ----------

// Push a random-name refresh so the login screen has tasty options from
// the moment it renders (no waiting for the first user input).
socket.emit('random_names');

// Initial state: Admin button hidden until register flips it visible.
syncAdminButtonVisibility();

function clearShowdown() {
  hideShowdownModal();
  state.showdownWindow = null;
  if (state.showdownModalTimer) {
    clearTimeout(state.showdownModalTimer);
    state.showdownModalTimer = null;
  }
  clearSeatBanners();
  // Note on what this function owns vs. doesn't:
  //   - This function is the route through which a phase transition /
  //     leave-table / busted-refund tears down the per-seat banner
  //     state. (The 20s post-timer re-render path also calls
  //     clearSeatBanners — via the maybeShowShowdown else-branch on
  //     the next renderTable — but doesn't go through here.)
  //   - Per-seat eligibility filtering (folded / removed /
  //     storedHandName null) clears individual banner elements
  //     inline in applySeatBanners; that's a different concern,
  //     not handled by this function.
}

// Strip .seat-banner classes from every seat. Used when the window
// expires (and we're not in a fold-out) so the per-seat pills don't
// linger past the end of the undismissable 20-second showdown
// window.
function clearSeatBanners() {
  document.querySelectorAll('.seat-banner').forEach((b) => {
    b.classList.remove('show', 'won', 'lost', 'fold');
    b.textContent = '';
  });
}

// Populate the showdown modal contents. Reads t.communityCards + each
// non-folded seat's holeCards + lastHandResults.winners[] directly —
// publicView already exposes all three in the showdown-reveal window,
// so this is just rendering. No data fetched from the server.
function populateShowdownModal(t) {
  const boardEl = $('showdownBoard');
  if (boardEl) {
    boardEl.innerHTML = '';
    (t.communityCards || []).forEach((c, i) => {
      boardEl.appendChild(renderCard(c, { delay: i * 80 }));
    });
  }
  const rowsEl = $('showdownRows');
  if (!rowsEl) return;
  rowsEl.innerHTML = '';
  const winnersById = new Set(
    (t.lastHandResults.winners || []).map((w) => w.id)
  );
  let rowIdx = 0;
  // Iterate non-folded seats in t.seats order so the modal layout
  // mirrors the order around the table. The `seat.storedHandName` gate
  // also keeps newly-joined seats OUT of the modal — they weren't
  // part of the resolved hand.
  for (const seat of t.seats) {
    if (!seat || !seat.occupied || seat.removed) continue;
    if (seat.folded || !seat.storedHandName) continue;
    const isWinner = winnersById.has(seat.playerId);
    const winnerEntry = (t.lastHandResults.winners || []).find(
      (w) => w.id === seat.playerId
    );
    // Prefer the per-seat storedHandName (set by resolveShowdown via
    // the new live showdown.js module) since it's authoritative for
    // tied / loser hands too. Fall back to winnerEntry.handName only
    // if storedHandName was somehow nulled.
    const handDescr = seat.storedHandName
      || (winnerEntry && winnerEntry.handName)
      || '';
    const row = el('div', {
      class: 'showdown-row'
        + (isWinner ? ' is-winner' : '')
        + (seat.isSelf ? ' is-self' : ''),
    });
    row.style.setProperty('--i', String(rowIdx));
    rowIdx += 1;
    row.appendChild(el('div', { class: 'showdown-name', text: seat.name }));
    const cardsEl = el('div', { class: 'showdown-cards' });
    if (seat.holeCards && seat.holeCards.length > 0) {
      seat.holeCards.forEach((c, i) => {
        cardsEl.appendChild(renderCard(c, { small: true, delay: i * 80 }));
      });
    } else {
      cardsEl.appendChild(renderCard(null, { small: true, faceDown: true }));
      cardsEl.appendChild(renderCard(null, { small: true, faceDown: true }));
    }
    row.appendChild(cardsEl);
    row.appendChild(el('div', {
      class: 'showdown-hand' + (isWinner ? ' is-winner' : ''),
      text: handDescr || '—',
    }));
    row.appendChild(el('div', {
      class: 'showdown-badge ' + (isWinner ? 'won' : 'lost'),
      text: isWinner
        ? 'WON ' + formatNumber(winnerEntry?.share ?? 0)
        : 'LOST',
    }));
    rowsEl.appendChild(row);
  }
}

// Apply per-seat banner content + classes for every .seat-banner element
// currently in the DOM. Reads from t.lastHandResults — winning seats
// get a gold WON $X pill, losers get a muted LOST pill; fold-out
// winners get a lighter WON pill (no $ amount since the engine signals
// "Won by fold" without a hand description). Called by maybeShowShowdown.
// CRITICAL: only seats with a non-null `storedHandName` (set by
// resolveShowdown for every non-folded participant) are eligible for
// a banner. New joins mid-window, mid-hand re-entries, or future
// hands' seats all have storedHandName=null and stay clear.
function applySeatBanners(t) {
  if (!t.lastHandResults || !Array.isArray(t.lastHandResults.winners)) {
    clearSeatBanners();
    return;
  }
  const winnersById = new Set(t.lastHandResults.winners.map((w) => w.id));
  const isFoldout = t.lastHandResults.winners.every(
    (w) => w.handName === 'Won by fold'
  );
  document.querySelectorAll('.seat-banner').forEach((b) => {
    const idx = parseInt(b.getAttribute('data-seat-idx'), 10);
    const seat = !isNaN(idx) ? t.seats[idx] : null;
    if (!seat || !seat.occupied || seat.removed || seat.folded) {
      b.classList.remove('show', 'won', 'lost', 'fold');
      b.textContent = '';
      return;
    }
    const winnerEntry = t.lastHandResults.winners.find(
      (w) => w.id === seat.playerId
    );
    const isWinner = winnersById.has(seat.playerId);
    if (isFoldout) {
      // Fold-out: `resolveShowdown` never runs for this path (the
      // engine's advancePhase calls awardPot directly), so the
      // surviving winner's `storedHandName` stays null. Show the
      // lighter fold-banner pill for the winner unconditionally;
      // losers (folded) were already cleared above.
      b.classList.add('show', 'fold');
      b.classList.remove('won', 'lost');
      b.textContent = isWinner ? 'WON' : '';
      return;
    }
    // Real showdown: only show banner on seats that participated
    // (resolveShowdown set `storedHandName` for every non-folded
    // seat). New joins mid-window / mid-hand re-entries / future
    // hands' seats all have storedHandName=null and stay clear.
    if (!seat.storedHandName) {
      b.classList.remove('show', 'won', 'lost', 'fold');
      b.textContent = '';
      return;
    }
    b.classList.add('show');
    b.classList.remove('won', 'lost', 'fold');
    if (isWinner) {
      b.classList.add('won');
      b.textContent = 'WON ' + formatNumber(winnerEntry?.share ?? 0);
    } else {
      b.classList.add('lost');
      b.textContent = 'LOST';
    }
  });
}

// ---------- Action bar ----------

function setupActionButtons(selfSeat, t) {
  const toCall = Math.max(0, (t.currentBet || 0) - selfSeat.contributed);
  const foldBtn  = document.querySelector('.action-btn.fold');
  const checkBtn = document.querySelector('.action-btn.check');
  const callBtn  = document.querySelector('.action-btn.call');
  const raiseBtn = $('raiseBtn');
  const allInBtn = document.querySelector('.action-btn.all-in');
  const raiseInput = $('raiseAmount');

  foldBtn.disabled = false;
  checkBtn.disabled = toCall > 0;
  callBtn.disabled = toCall <= 0 || selfSeat.stack < toCall;
  if (toCall > 0) {
    callBtn.textContent = `Call ${formatNumber(Math.min(selfSeat.stack, toCall))}`;
  } else {
    callBtn.textContent = 'Call';
  }

  // Min raise total = currentBet + minRaise, or bet of bigBlind.
  let minRaiseTotal;
  if (t.currentBet > 0) {
    minRaiseTotal = t.currentBet + Math.max(t.minRaise || t.bigBlind, t.bigBlind);
  } else {
    minRaiseTotal = t.bigBlind;
  }
  const maxRaise = selfSeat.stack + selfSeat.contributed;

  raiseBtn.disabled = selfSeat.stack <= 0 || maxRaise < minRaiseTotal;
  // When no one has bet yet (post-flop first action or a pre-flop limp scenario),
  // the existing "Raise" button takes a Bet role. Relabel it so the player
  // sees the correct poker term.
  raiseBtn.textContent = (t.currentBet || 0) === 0 ? 'Bet' : 'Raise';
  raiseInput.min = minRaiseTotal;
  raiseInput.max = maxRaise;
  raiseInput.value = Math.min(minRaiseTotal, maxRaise);

  allInBtn.disabled = selfSeat.stack <= 0;
  allInBtn.textContent = `All-in ${formatNumber(selfSeat.stack)}`;

  // Raise presets
  const presets = [];
  if (t.currentBet === 0) {
    presets.push({ label: 'Min', val: Math.min(t.bigBlind, selfSeat.stack) });
    presets.push({ label: '2\u00d7', val: Math.min(t.bigBlind * 2, selfSeat.stack) });
    presets.push({ label: '5\u00d7', val: Math.min(t.bigBlind * 5, selfSeat.stack) });
  } else {
    const callAmt = toCall + selfSeat.contributed + Math.max(t.minRaise || t.bigBlind, t.bigBlind);
    presets.push({ label: 'Min', val: Math.min(callAmt, maxRaise) });
    presets.push({ label: '2\u00d7', val: Math.min(t.currentBet * 2, maxRaise) });
    presets.push({ label: 'Pot', val: Math.min(t.pot + t.currentBet, maxRaise) });
    presets.push({ label: 'All',  val: maxRaise });
  }
  const presetsHost = $('raisePresets');
  presetsHost.innerHTML = '';
  presets.forEach(p => {
    if (p.val <= 0) return;
    presetsHost.appendChild(el('button', {
      text: `${p.label} (${formatNumber(Math.max(selfSeat.contributed, p.val))})`,
      title: 'Set raise amount',
      onclick: () => { raiseInput.value = p.val; },
    }));
  });
}

function disableAllActions() {
  document.querySelectorAll('.action-btn').forEach(b => { b.disabled = true; });
  $('raiseAmount').disabled = true;
  document.querySelectorAll('.raise-presets button').forEach(b => { b.disabled = true; });
}

function performAction(action, amount) {
  const t = state.currentTable;
  if (!t) return;
  socket.emit('action', { tableId: t.id, type: action, amount }, res => {
    if (!res || !res.ok) {
      showToast(res && res.error ? res.error : 'Action failed', 'error');
    }
  });
}

// ---------- Leaderboard modal ----------
// Public "top players" view. Open from the top-bar button, fetch /api/leaderboard
// once on open (or on Refresh), and render a podium for top 3 + a dense list
// for the remainder (current viewer is highlighted wherever they appear so
// they don't have to scroll). Cached `state.leaderboardData` lets switching
// between views re-render without a network round-trip; explicitly nulled on
// socket reconnect so the next open fresh-loads.
async function openLeaderboard() {
  $('leaderboardModal').style.display = '';
  // Always reload on open — points shift constantly during play, so showing
  // a stale snapshot would defeat the meta-game meaning of the view.
  await loadLeaderboard();
}
function closeLeaderboard() {
  $('leaderboardModal').style.display = 'none';
}
async function loadLeaderboard() {
  const body = $('leaderboardBody');
  if (body) body.innerHTML = '<div class="leaderboard-empty muted">Loading…</div>';
  // Monotonic request-id token: if the user spam-clicks Refresh, multiple
  // fetches are in flight and could resolve out of order. We only render
  // the response from the most-recent request (`reqId === state.lbReqId`)
  // so earlier slow responses can't overwrite a fresher one.
  const reqId = (state.lbReqId = (state.lbReqId || 0) + 1);
  try {
    const r = await fetch('/api/leaderboard');
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (reqId !== state.lbReqId) return; // a newer request superseded us
    state.leaderboardData = data.players || [];
    const ts = $('leaderboardUpdatedAt');
    if (ts) {
      const d = new Date();
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      const ss = String(d.getSeconds()).padStart(2, '0');
      ts.textContent = `Updated ${hh}:${mm}:${ss}`;
    }
    renderLeaderboard();
  } catch (err) {
    if (reqId !== state.lbReqId) return;
    if (body) body.innerHTML = '<div class="leaderboard-empty muted">Could not load leaderboard. Try refresh.</div>';
  }
}
function renderLeaderboard() {
  const body = $('leaderboardBody');
  if (!body) return;
  body.innerHTML = '';
  const players = state.leaderboardData || [];
  if (!players.length) {
    body.appendChild(el('div', { class: 'leaderboard-empty muted', text: 'No players yet. Start a game to climb the ranks!' }));
    return;
  }
  const me = state.player && state.player.name;
  const top = players.slice(0, 3);
  const rest = players.slice(3);

  // Podium: render the top 3 in classic 2-1-3 visual order regardless of
  // their actual ranks so the gold medallion sits at the top-center. Pad to
  // length 3 with a stretch of null placeholders so the podium always feels
  // complete; the empty placeholder still gets a faint rank chip so the
  // visual rhythm is preserved.
  const podiumOrder = [top[1] || null, top[0] || null, top[2] || null];
  const podiumRanks = [2, 1, 3];
  const podiumMedals = ['🥈', '🥇', '🥉'];
  const podium = el('div', { class: 'podium' });
  podiumOrder.forEach((p, idx) => {
    const card = el('div', { class: 'podium-card rank-' + podiumRanks[idx] + (p && me && p.name === me ? ' is-self' : '') });
    card.appendChild(el('span', { class: 'podium-rank', text: '#' + podiumRanks[idx] }));
    card.appendChild(el('div', { class: 'podium-medal', text: podiumMedals[idx] }));
    card.appendChild(el('div', { class: 'podium-name', text: p ? p.name : '—' }));
    card.appendChild(el('div', { class: 'podium-points', text: p ? formatNumber(p.points) + ' pts' : '' }));
    // Stats line: games played + wins. Only appears when we have at least
    // 1 game played (the server-side filter already guarantees this) so the
    // "0 games · 0 wins" branch is unnecessary here.
    if (p && (p.gamesPlayed || p.wins)) {
      card.appendChild(el('div', {
        class: 'podium-stats',
        text: `${p.gamesPlayed || 0} game${(p.gamesPlayed || 0) === 1 ? '' : 's'}` +
              (p.wins ? ` \u00B7 ${p.wins} win${p.wins === 1 ? '' : 's'}` : ''),
      }));
    }
    if (p && me && p.name === me) card.appendChild(el('span', { class: 'leaderboard-self-badge', text: 'You' }));
    podium.appendChild(card);
  });
  body.appendChild(podium);

  // Ranks 4+
  if (rest.length) {
    const list = el('div', { class: 'leaderboard-list' });
    rest.forEach((p, i) => {
      const rank = i + 4;
      const row = el('div', { class: 'lb-row' + (me && p.name === me ? ' is-self' : '') });
      row.appendChild(el('div', { class: 'lb-rank', text: '#' + rank }));
      const nameCell = el('div', { class: 'lb-name' });
      nameCell.appendChild(el('span', { text: p.name }));
      // Inline stats under the name in the dense list — same info as the
      // podium chip but rendered smaller so it doesn't blow out the row
      // height on longer lists.
      if (p.gamesPlayed || p.wins) {
        nameCell.appendChild(el('span', {
          class: 'lb-stats',
          text: ` (${p.gamesPlayed || 0}g${p.wins ? ` \u00B7 ${p.wins}w` : ''})`,
          title: `${p.gamesPlayed || 0} games${p.wins ? `, ${p.wins} win${p.wins === 1 ? '' : 's'}` : ''}`,
        }));
      }
      row.appendChild(nameCell);
      row.appendChild(el('div', { class: 'lb-points', text: formatNumber(p.points) + ' pts' }));
      list.appendChild(row);
    });
    body.appendChild(list);
  }
}

// ---------- Admin (legacy modal block retired) ----------
// The legacy shared-password modal (`openAdmin` / `adminLogin` /
// `refreshAdminList` / etc.) is intentionally removed. Admin auth is
// now derived from `state.player.isAdmin` at register time, and the
// dedicated admin room (`#view-admin` rendered by the new admin
// functions earlier in this file) replaces the modal flow
// wholesale. The functions previously defined here have been pruned
// from the file; the legacy admin event listeners at the bottom
// (openAdmin / closeAdmin / adminLoginBtn / etc.) are likewise gone.
// If you ever need to re-introduce a password-gated fallback admin
// surface, build it as a fresh module — don't resurrect the dead
// symbols below this comment.


function renderAdminPlayers(players) {
  const tbody = $('adminPlayersTbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  (players || []).forEach(p => {
    const tr = el('tr', { class: p.isAdmin ? 'is-admin-row' : '' });
    tr.appendChild(el('td', { text: p.name + (p.isAdmin ? ' ★' : '') }));
    tr.appendChild(el('td', { text: formatNumber(p.points) }));
    const addInput = el('input', { type: 'number', value: '' });
    addInput.placeholder = '+/-';
    addInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(p.name, addInput.value); });
    const addCell = el('td', {});
    const addBtn = el('button', { text: 'Add',  onclick: () => doAdd(p.name, addInput.value) });
    addCell.appendChild(addInput);
    addCell.appendChild(addBtn);
    tr.appendChild(addCell);

    const setInput = el('input', { type: 'number', value: p.points });
    setInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSet(p.name, setInput.value); });
    const setCell = el('td', {});
    const setBtn = el('button', { text: 'Set', onclick: () => doSet(p.name, setInput.value) });
    setCell.appendChild(setInput);
    setCell.appendChild(setBtn);
    tr.appendChild(setCell);

    const removeBtn = el('button', {
      text: 'Delete',
      class: 'danger',
      onclick: () => {
        if (!confirm(`Permanently remove player "${p.name}"?`)) return;
        socket.emit('admin_remove', { name: p.name }, res => {
          $('adminActionFeedback').textContent = res && res.ok ? `Removed ${p.name}` : (res && res.error ? res.error : 'Failed');
          refreshAdminList();
        });
      },
    });
    tr.appendChild(el('td', {}, [removeBtn]));
    tbody.appendChild(tr);
  });
}

// === Admin room client module ===
//
// Functions referenced by renderAdminPlayers + the setView('admin') hook + the
// five internal buttons (adminRoomBackBtn / adminPoolRefreshBtn /
// adminRoomRefreshBtn / adminRoomRefreshPlayersBtn / adminStartingSave).
//
// Each emit returns a single ack from the server's admin_* handlers, all of
// which are gated by requireAdmin(cb). On success we refresh the relevant
// local cache + re-render; on failure we surface the error in
// #adminActionFeedback + a toast so the host knows what went wrong.
//
// The editor (openAdminEditor / saveAdminEditor / closeAdminEditor) is
// inline-rendered into #adminEditor on demand; clicking a session card's
// Edit button expands the editor under it with labelled number inputs for
// BB/SB/stack/fee/maxSeats and Save/Cancel buttons. Saving posts the new
// settings via admin_update_session.

function setAdminFeedback(text) {
  const fb = $('adminActionFeedback');
  if (fb) fb.textContent = text || '';
}

function onEnterAdminRoom() {
  // Entry point for the admin view. Called by the setView() wrapper hook
  // (line ~844) the first time a user with isAdmin=true clicks the top-bar
  // Admin Room button. Fetches every panel the admin room renders in
  // parallel — the per-table settings, the house chip, and the player
  // roster — so the room shows live data the moment it appears.
  fetchAdminSessions();
  fetchAdminHouseInfo();
  refreshAdminList();
  // Pre-populate the global starting stack input with whatever's currently
  // set on the server so the admin can see + tweak it without a round-trip.
  socket.emit('admin_list', null, (res) => {
    if (res && res.ok && Array.isArray(res.players)) {
      const meta = res.players.find((p) => p && p.name === '__startingStack');
      // No-op for now — the global starting-stack lookup uses a separate
      // admin_set_starting_stack handler instead.
    }
  });
}

function fetchAdminSessions() {
  // Pulls the live table list (each with editable BB/SB/stack/fee/maxSeats).
  // Backed by server.js's admin_list_sessions handler which calls
  // rooms.listTables(). Cached on state.adminRoom.sessions so a settings
  // save can re-render the grid without another round-trip.
  socket.emit('admin_list_sessions', null, (res) => {
    if (res && res.ok) {
      state.adminRoom.sessions = res.sessions || [];
      renderAdminSessionsGrid(state.adminRoom.sessions);
      // Refresh the pool tile breakdown from the same payload (it shows
      // chipsInPlay + pendingHouseFees per table).
      renderPoolBreakdown(state.adminRoom.sessions);
    } else {
      showToast(res && res.error ? res.error : 'Failed to fetch sessions', 'error');
    }
  });
}

function fetchAdminHouseInfo() {
  // Looks up the primary admin (lowest-name isAdmin=true) and stamps their
  // balance into the room-header chip. 'missing' means no admin exists —
  // the chip shows a warning so the host knows to flip their own flag.
  socket.emit('admin_get_house_info', null, (res) => {
    if (res && res.ok) {
      state.adminRoom.house = res.admin;
    } else if (res && res.reason === 'no_admin') {
      state.adminRoom.house = 'missing';
    }
    renderAdminHouseChip(state.adminRoom.house);
  });
}

function renderAdminHouseChip(house) {
  const nameEl = $('adminRoomHouseName');
  const pointsEl = $('adminRoomHousePoints');
  if (!nameEl || !pointsEl) return;
  if (!house || house === 'missing') {
    nameEl.textContent = house === 'missing' ? 'no admin' : '—';
    pointsEl.textContent = '0 pts';
    return;
  }
  nameEl.textContent = house.name;
  pointsEl.textContent = formatNumber(house.points) + ' pts';
}

function renderAdminSessionsGrid(sessions) {
  const grid = $('adminSessionsGrid');
  if (!grid) return;
  grid.innerHTML = '';
  if (!sessions || !sessions.length) {
    grid.appendChild(el('div', { class: 'muted small', text: 'No active sessions.' }));
    return;
  }
  sessions.forEach((s) => {
    const card = el('div', { class: 'admin-session-card' + (s.default ? ' is-default' : '') });
    card.appendChild(el('div', { class: 'admin-session-name', text: s.name }));
    const meta = el('div', { class: 'admin-session-meta muted small' });
    meta.appendChild(el('span', { text: `${s.seatsTaken}/${s.maxSeats} seats · Blinds ${s.smallBlind}/${s.bigBlind}` }));
    if (s.default) meta.appendChild(el('span', { class: 'admin-session-tag', text: 'default' }));
    card.appendChild(meta);
    const editBtn = el('button', {
      class: 'link-btn',
      text: 'Edit',
      onclick: () => openAdminEditor(s.id),
    });
    card.appendChild(editBtn);
    grid.appendChild(card);
  });
}

// ----- Session editor (per-table BB/SB/stack/fee/maxSeats) -----

function openAdminEditor(tableId) {
  const session = state.adminRoom.sessions.find((x) => x.id === tableId);
  if (!session) return;
  state.adminRoom.editorTableId = tableId;
  const host = $('adminEditor');
  if (!host) return;
  host.innerHTML = '';
  host.style.display = '';
  const title = el('h4', { text: 'Edit ' + session.name });
  host.appendChild(title);
  const grid = el('div', { class: 'form-grid' });
  const bbInput   = labelledNumber('Big blind',         'editBB',   session.bigBlind);
  const sbInput   = labelledNumber('Small blind',       'editSB',   session.smallBlind);
  const stackInput= labelledNumber('Starting stack',    'editStack',session.startingStack);
  const feeInput  = labelledNumber('House fee %',       'editFee',  session.houseFeePercent);
  const seatsInput= labelledNumber('Max seats',         'editSeats',session.maxSeats);
  grid.appendChild(bbInput.field);
  grid.appendChild(sbInput.field);
  grid.appendChild(stackInput.field);
  grid.appendChild(feeInput.field);
  grid.appendChild(seatsInput.field);
  host.appendChild(grid);
  const actions = el('div', { class: 'form-row' });
  const saveBtn = el('button', { class: 'primary-btn', text: 'Save', onclick: () => saveAdminEditor(tableId) });
  const cancelBtn = el('button', { class: 'ghost-btn', text: 'Cancel', onclick: closeAdminEditor });
  actions.appendChild(saveBtn);
  actions.appendChild(cancelBtn);
  host.appendChild(actions);
  host.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function labelledNumber(label, id, value) {
  const field = el('label', {});
  field.appendChild(el('span', { text: label }));
  const input = el('input', { id, type: 'number', value: String(value), min: '0', step: '1' });
  field.appendChild(input);
  return { field, input };
}

function closeAdminEditor() {
  const host = $('adminEditor');
  if (!host) return;
  host.innerHTML = '';
  host.style.display = 'none';
  state.adminRoom.editorTableId = null;
}

function saveAdminEditor(tableId) {
  const bb   = parseInt($('editBB').value,    10);
  const sb   = parseInt($('editSB').value,    10);
  const stk  = parseInt($('editStack').value, 10);
  const fee  = parseFloat($('editFee').value);
  const seats= parseInt($('editSeats').value, 10);
  socket.emit('admin_update_session', {
    tableId,
    settings: { bigBlind: bb, smallBlind: sb, startingStack: stk, houseFeePercent: fee, maxSeats: seats },
  }, (res) => {
    if (res && res.ok) {
      setAdminFeedback('Saved.');
      showToast('Session updated', 'good');
      closeAdminEditor();
      fetchAdminSessions();
    } else {
      const err = res && res.error ? res.error : 'Failed';
      setAdminFeedback(err);
      showToast(err, 'error');
    }
  });
}

// ----- Player management -----

function refreshAdminList() {
  // Backed by server.js's admin_list handler — returns every Player doc
  // sorted by points DESC. renderAdminPlayers builds the table rows
  // (one per player) with the inline Add / Set / Delete actions.
  socket.emit('admin_list', null, (res) => {
    if (res && res.ok) renderAdminPlayers(res.players || []);
    else showToast(res && res.error ? res.error : 'Failed to fetch players', 'error');
  });
}

function doAdd(name, delta) {
  const n = parseInt(delta, 10);
  if (!Number.isFinite(n)) { showToast('Enter a number', 'error'); return; }
  socket.emit('admin_add_points', { name, delta: n }, (res) => {
    if (res && res.ok) {
      setAdminFeedback(`Added ${n} to ${name}.`);
      refreshAdminList();
    } else {
      setAdminFeedback(res && res.error ? res.error : 'Failed');
      showToast(res && res.error ? res.error : 'Failed', 'error');
    }
  });
}

function doSet(name, points) {
  const p = parseInt(points, 10);
  if (!Number.isFinite(p) || p < 0) { showToast('Enter a non-negative number', 'error'); return; }
  socket.emit('admin_set_points', { name, points: p }, (res) => {
    if (res && res.ok) {
      setAdminFeedback(`Set ${name} to ${p}.`);
      refreshAdminList();
    } else {
      setAdminFeedback(res && res.error ? res.error : 'Failed');
      showToast(res && res.error ? res.error : 'Failed', 'error');
    }
  });
}

function doSetStartingStack() {
  const v = parseInt($('adminStartingStack').value, 10);
  if (!Number.isFinite(v) || v < 1) { showToast('Enter a positive number', 'error'); return; }
  socket.emit('admin_set_starting_stack', { amount: v }, (res) => {
    if (res && res.ok) {
      setAdminFeedback(`Starting stack set to ${v}.`);
      showToast('Saved', 'good');
    } else {
      setAdminFeedback(res && res.error ? res.error : 'Failed');
      showToast(res && res.error ? res.error : 'Failed', 'error');
    }
  });
}

// ---------- Pool snapshot (rake balance + chips in play) ----------
//
// Self-contained watcher that fetches + renders the Pool snapshot card
// at the top of the admin room. Pulls the same data the admin room's
// house chip + sessions card grid would consume (admin_get_house_info
// for rake balance, admin_list_sessions for per-table chipsInPlay +
// pendingHouseFees). Designed to NOT depend on onEnterAdminRoom /
// renderAdminSessionsGrid (which the rest of the admin room shares and
// which this block can stand alone from).
//
// Flash-on-update: when a tile's value changes, we briefly light the
// value with the `is-flash` class so the host's eye is drawn to the
// credit. Without this the rake tile would change +1 in 14pt text and
// go unnoticed on a busy session.
//
// Idempotency: race-free when called multiple times in quick succession.
// Each fetch is one round trip; if the host spam-clicks [↻ Refresh],
// we lean on socket.io's ack semantics so the last response wins for
// each tile — older in-flight responses that arrive later don't
// overwrite newer ones (we track a sequence id per tile and bail if
// it changes mid-flight).
let _poolRakeSeq = 0;
let _poolTotalSeq = 0;
let _poolPendingSeq = 0;

function refreshPoolSnapshot() {
  // Side-effect: writes to state.adminRoom.house + state.adminRoom.sessions,
  // which the houses chip + per-table breakdown elsewhere in the admin room
  // already consume. So calling this also refreshes those consumers for
  // free, without requiring a separate fetch.
  fetchPoolHouse();
  fetchPoolSessions();
}

function fetchPoolHouse() {
  const mySeq = ++_poolRakeSeq;
  socket.emit('admin_get_house_info', null, (res) => {
    // A more recent fetchPoolHouse() finished first AND this one's
    // response arrived AFTER; don't overwrite the newer view.
    if (mySeq !== _poolRakeSeq) return;
    const tile   = $('adminPoolRakeValue');
    const subLbl = tile && tile.parentNode.querySelector('.admin-pool-tile-sub');
    if (!res || res.ok !== true) {
      // No admin configured in Mongo yet — render an explicit empty
      // hint so the host knows the rake machinery is fine, just not
      // wired to a Player doc. We don't elevate this to an error
      // because per the spec admin provisioning is intentionally an
      // out-of-band DB flip (no in-app assignment).
      if (tile)   tile.textContent = '—';
      if (subLbl) subLbl.textContent = 'no admin configured';
      return;
    }
    if (tile) {
      const prev = tile.dataset.prev || '';
      const next = String(res.admin.points);
      tile.textContent = formatNumber(res.admin.points) + ' pts';
      if (prev !== next) {
        tile.dataset.prev = next;
        tile.classList.remove('is-flash');
        // Force reflow so re-adding the class restarts the animation
        // even on the same value (rare — e.g. duplicate credit calls).
        void tile.offsetWidth;
        tile.classList.add('is-flash');
      }
    }
    if (subLbl) subLbl.textContent = 'held by ' + res.admin.name;
  });
}

function fetchPoolSessions() {
  const mySeq = ++_poolTotalSeq;
  socket.emit('admin_list_sessions', null, (res) => {
    if (mySeq !== _poolTotalSeq) return;
    const sessions = (res && res.ok && Array.isArray(res.sessions)) ? res.sessions : [];
    state.adminRoom.sessions = sessions;
    let totalChips = 0;
    let totalPending = 0;
    for (const t of sessions) {
      totalChips   += (t.chipsInPlay      || 0);
      totalPending += (t.pendingHouseFees || 0);
    }
    renderPoolBreakdown(sessions);
    // Tile 1 (label shortcut used in HTML markup): same total
    // displayed in the Total Chips in Play tile. Flash on change.
    const totalTile = $('adminPoolTotalValue');
    if (totalTile) {
      const prev = totalTile.dataset.prev || '';
      const next = String(totalChips);
      totalTile.textContent = formatNumber(totalChips) + ' pts';
      if (prev !== next) {
        totalTile.dataset.prev = next;
        totalTile.classList.remove('is-flash');
        void totalTile.offsetWidth;
        totalTile.classList.add('is-flash');
      }
    }
    // Use a separate sequence id for pending so an updated sessions
    // payload doesn't lose to a stale house payload (they're freshly
    // fetched each tick, so a sequence mismatch is unlikely, but
    // mirrored here for symmetry with the house path above).
    const myPendingSeq = ++_poolPendingSeq;
    if (myPendingSeq !== _poolPendingSeq) return;
    const pendingTile = $('adminPoolPendingValue');
    if (pendingTile) {
      const prev = pendingTile.dataset.prev || '';
      const next = String(totalPending);
      pendingTile.textContent = formatNumber(totalPending) + ' pts';
      if (prev !== next) {
        pendingTile.dataset.prev = next;
        pendingTile.classList.remove('is-flash');
        void pendingTile.offsetWidth;
        pendingTile.classList.add('is-flash');
      }
    }
  });
}

function renderPoolBreakdown(sessions) {
  const host = $('adminPoolBreakdown');
  if (!host) return;
  host.innerHTML = '';
  if (!sessions.length) {
    host.appendChild(el('div', {
      class: 'admin-pool-breakdown-row apb-empty',
      text: 'No active tables yet.',
    }));
    return;
  }
  for (const t of sessions) {
    const row = el('div', { class: 'admin-pool-breakdown-row' }, [
      el('div', { class: 'apb-name', text: t.name }),
      el('div', {
        class: 'apb-stat',
        title: 'Chips in play (pot + every seat.stack + seat.contributed)',
        text: formatNumber(t.chipsInPlay || 0) + ' chips',
      }),
      el('div', {
        class: 'apb-stat' + (t.handInProgress ? ' live' : ''),
        title: t.handInProgress ? 'Hand in progress' : 'Waiting',
        text: t.handInProgress ? 'in hand' : 'idle',
      }),
      el('div', {
        class: 'apb-stat fee',
        title: 'Uncredited house fee sitting in the table accumulator (paid on next hand settle)',
        text: (t.pendingHouseFees && t.pendingHouseFees > 0)
          ? formatNumber(t.pendingHouseFees) + ' pending'
          : '—',
      }),
    ]);
    host.appendChild(row);
  }
}
// symbols so a stale `void X` expression doesn't throw ReferenceError.

// ---------- Socket events ----------

socket.on('connect', () => {
  console.log('Connected to server.');
  // Drop any cached leaderboard snapshot so the next modal open refetches
  // with up-to-date points; without this, a stale page could show ranks
  // and points from the prior session on a fast Refresh click.
  state.leaderboardData = null;
  // Only clear the admin flag on a *reconnect* — the server already
  // removed our prior socket from socketToAdmin on the previous disconnect,
  // so on a true reconnect the local flag is stale. `state.player` is the
  // simplest discriminator: it's null on a fresh page load (auto-login has
  // not yet run) and stays truthy across reconnects within the same page.
  if (state.player) state.isAdmin = false;
  // Auto-login if we have a saved name
  try {
    const saved = localStorage.getItem('pokerName');
    if (saved && !state.player) {
      $('loginName').value = saved;
      doLogin();
    }
  } catch (e) {}
});

socket.on('hello', ({ player }) => {
  state.player = player;
  updateTopBar();
});

socket.on('lobby_update', ({ tables }) => {
  state.tables = tables || [];
  if (state.view === 'lobby') renderLobby();
});

socket.on('table_state', ({ table }) => {
  state.currentTable = table;
  if (state.view === 'lobby') setView('table');
  if (state.view === 'table') renderTable();
});

socket.on('server_message', ({ level, text }) => {
  showToast(text || level || 'Message', level || 'info');
});

socket.on('disconnect', () => {
  showToast('Disconnected. Reconnecting...', 'error');
});

socket.on('chat_update', ({ tableId, messages }) => {
  // Server sends the full history (not deltas) so reconnecting sockets
  // also receive the backlog without special-casing. Re-render only if the
  // update is for the table the viewer is currently looking at.
  if (state.currentTable && state.currentTable.id === tableId) {
    state.currentTable.chatMessages = messages || [];
    renderChat();
  }
});

// ---------- Wire up UI buttons ----------

document.addEventListener('DOMContentLoaded', () => {
  $('loginBtn').addEventListener('click', doLogin);
  $('loginName').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('refreshNamesBtn').addEventListener('click', () => socket.emit('random_names'));

  $('leaderboardBtn').addEventListener('click', openLeaderboard);
  $('leaderboardCloseBtn').addEventListener('click', closeLeaderboard);
  // Refresh button + click-outside-to-close on the backdrop (but not the
  // inner content) match the admin modal pattern.
  $('leaderboardRefreshBtn').addEventListener('click', loadLeaderboard);
  $('leaderboardModal').addEventListener('click', (e) => {
    if (e.target === $('leaderboardModal')) closeLeaderboard();
  });

  // Admin entry point wires to openAdminRoom (defined above) instead of
  // Admin entry point: opens the legacy shared-password modal.
  // The modal itself performs admin_login; once ack'd, the modal
  // reassembles the panel from local-state. The previous
  // openAdminRoom/view-admin path is retired (see #adminModal in
  // public/index.html).
  $('adminBtn').addEventListener('click', openAdminModal);

  // Legacy shared-password modal controls.
  $('adminModalCloseBtn').addEventListener('click', closeAdminModal);
  $('adminLoginBtn').addEventListener('click', submitAdminPassword);
  $('adminPasswordInput').addEventListener('keydown', e => {
    // Enter-key reentrancy: submitAdminPassword has its own pending
    // flag so rapid Enter presses can't fire the same emit twice.
    if (e.key === 'Enter') submitAdminPassword();
  });
  $('adminModalRefreshPlayersBtn').addEventListener('click', refreshAdminList);
  $('adminChangePasswordBtn').addEventListener('click', submitChangePassword);
  // Click on the dark backdrop closes (same pattern as the
  // leaderboard modal). Inner content has stopPropagation via the
  // .modal-content wrapper to keep clicks inside the panel.
  $('adminModal').addEventListener('click', (e) => {
    if (e.target === $('adminModal')) closeAdminModal();
  });
  // Click-outside-to-close for the admin modal — kept consistent with
  // the leaderboard modal. Only the backdrop element is the close
  // trigger; clicks inside .modal-content stay inside.
  $('adminStartingSave').addEventListener('click', doSetStartingStack);

  $('createTableBtn').addEventListener('click', createTable);
  $('leaveTableBtn').addEventListener('click', leaveCurrentTable);
  $('sitOutBtn').addEventListener('click', sitOut);
  // Chat panel: Enter submits, clicking Send submits. The HTML maxlength=200
  // caps paste length natively so the server-side slice(0,200) is just
  // defense-in-depth.
  $('chatSendBtn').addEventListener('click', sendChat);
  $('chatInput').addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); sendChat(); }
  });

  // Action buttons
  document.querySelectorAll('.action-btn[data-action]').forEach(b => {
    b.addEventListener('click', () => performAction(b.dataset.action));
  });
  // The "Raise" button submits a 'raise' when there is a bet to raise, and a
  // 'bet' when there is no current bet (first money in voluntarily). The
  // typed amount is clamped to the legal range so it always succeeds; the
  // server validates the same range and would otherwise toast an error.
  $('raiseBtn').addEventListener('click', () => {
    const t = state.currentTable;
    if (!t) return;
    const selfSeat = t.seats.find(s => s.occupied && s.isSelf);
    if (!selfSeat) return;
    const raw = parseInt($('raiseAmount').value, 10);
    if (!Number.isFinite(raw) || raw <= 0) {
      showToast('Enter a valid amount', 'error');
      return;
    }
    const isBet = (t.currentBet || 0) === 0;
    let min;
    if (isBet) {
      min = t.bigBlind;
    } else {
      min = (t.currentBet || 0) + Math.max(t.minRaise || t.bigBlind, t.bigBlind);
    }
    const max = selfSeat.stack + selfSeat.contributed;
    const total = Math.max(min, Math.min(raw, max));
    performAction(isBet ? 'bet' : 'raise', total);
  });

  loadRandomNames();
});
