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
  player:        null,       // { id, name, points }
  isAdmin:       false,
  tables:        [],         // lobby view: [{ id, name, seatsTaken, maxSeats, phase, handInProgress }]
  currentTable:  null,       // full table state if joined
  leaderboardData: null,     // last /api/leaderboard payload, used for re-renders
  view:          'login',    // 'login' | 'lobby' | 'table'
  toastTimer:    null,
  toastType:     null,
  pendingError:  null,
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
  ['view-login', 'view-lobby', 'view-table'].forEach(id => {
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
      try { localStorage.setItem('pokerName', state.player.name); } catch (e) {}
      updateTopBar();
      setView('lobby');
      socket.emit('random_names'); // refresh names for next time
    } else {
      showToast(res && res.error ? res.error : 'Login failed', 'error');
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

  // Cards: real faces for the viewer who has holeCards data; face-down card
  // backs for everyone else (opponents, and the viewer between hands when
  // the server sends no cards). The CSS already has a `.card.face-down`
  // design prepared in style.css — we just plug into it here so cards
  // never render as blank placeholder boxes.
  const cardEls = (seat.isSelf && seat.holeCards && seat.holeCards.length > 0)
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
      row.appendChild(el('div', { class: 'lb-name', text: p.name }));
      row.appendChild(el('div', { class: 'lb-points', text: formatNumber(p.points) + ' pts' }));
      list.appendChild(row);
    });
    body.appendChild(list);
  }
}

// ---------- Admin modal ----------

function openAdmin() {
  $('adminModal').style.display = '';
  $('adminLoginArea').style.display = '';
  $('adminPanelArea').style.display = 'none';
  $('adminPasswordInput').value = '';
  $('adminLoginError').style.display = 'none';
  $('adminNewPw').value = '';
  $('adminActionFeedback').textContent = '';
  if (state.isAdmin) {
    $('adminLoginArea').style.display = 'none';
    $('adminPanelArea').style.display = '';
    refreshAdminList();
  }
}
function closeAdmin() { $('adminModal').style.display = 'none'; }

function adminLogin() {
  const pw = $('adminPasswordInput').value;
  if (!pw) { $('adminLoginError').textContent = 'Enter a password'; $('adminLoginError').style.display = ''; return; }
  socket.emit('admin_login', { password: pw }, res => {
    if (res && res.ok) {
      state.isAdmin = true;
      $('adminLoginArea').style.display = 'none';
      $('adminPanelArea').style.display = '';
      refreshAdminList();
    } else {
      $('adminLoginError').textContent = res && res.error ? res.error : 'Wrong password';
      $('adminLoginError').style.display = '';
    }
  });
}
function adminLogout() {
  socket.emit('admin_logout', null, res => {
    state.isAdmin = false;
    closeAdmin();
  });
}
function refreshAdminList() {
  socket.emit('admin_list', null, res => {
    if (!res || !res.ok) return;
    renderAdminPlayers(res.players);
  });
}

function renderAdminPlayers(players) {
  const tbody = $('adminPlayersTbody');
  tbody.innerHTML = '';
  players.forEach(p => {
    const tr = el('tr', {});
    tr.appendChild(el('td', { text: p.name }));
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

function doAdd(name, deltaStr) {
  const delta = parseInt(deltaStr, 10);
  if (!Number.isFinite(delta)) { $('adminActionFeedback').textContent = 'Enter a number'; return; }
  socket.emit('admin_add_points', { name, delta }, res => {
    if (res && res.ok) {
      $('adminActionFeedback').textContent = `Added ${delta} to ${name} (now ${formatNumber(res.player.points)})`;
      if (state.player && state.player.name === name) {
        state.player.points = res.player.points;
        updateTopBar();
      }
      refreshAdminList();
    } else {
      $('adminActionFeedback').textContent = res && res.error ? res.error : 'Failed';
    }
  });
}
function doSet(name, pointsStr) {
  const points = parseInt(pointsStr, 10);
  if (!Number.isFinite(points) || points < 0) { $('adminActionFeedback').textContent = 'Enter a positive number'; return; }
  socket.emit('admin_set_points', { name, points }, res => {
    if (res && res.ok) {
      $('adminActionFeedback').textContent = `Set ${name} to ${formatNumber(res.player.points)}`;
      if (state.player && state.player.name === name) {
        state.player.points = res.player.points;
        updateTopBar();
      }
      refreshAdminList();
    } else {
      $('adminActionFeedback').textContent = res && res.error ? res.error : 'Failed';
    }
  });
}
function adminSaveStarting() {
  const v = parseInt($('adminStartingStack').value, 10);
  if (!Number.isFinite(v) || v < 1) { $('adminActionFeedback').textContent = 'Invalid'; return; }
  socket.emit('admin_set_starting_stack', { amount: v }, res => {
    $('adminActionFeedback').textContent = res && res.ok ? `Default starting stack set to ${v}` : 'Failed';
  });
}
function adminChangePassword() {
  const v = $('adminNewPw').value;
  if (v.length < 4) { $('adminActionFeedback').textContent = 'Password must be at least 4 characters'; return; }
  socket.emit('admin_change_password', { newPassword: v }, res => {
    if (res && res.ok) {
      $('adminActionFeedback').textContent = 'Password updated.';
      $('adminNewPw').value = '';
    } else {
      $('adminActionFeedback').textContent = res && res.error ? res.error : 'Failed';
    }
  });
}

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

  $('adminBtn').addEventListener('click', openAdmin);
  $('adminCloseBtn').addEventListener('click', closeAdmin);
  $('adminLoginBtn').addEventListener('click', adminLogin);
  $('adminPasswordInput').addEventListener('keydown', e => { if (e.key === 'Enter') adminLogin(); });
  $('adminLogoutBtn').addEventListener('click', adminLogout);
  $('adminStartingSave').addEventListener('click', adminSaveStarting);
  $('adminChangePwBtn').addEventListener('click', adminChangePassword);

  $('createTableBtn').addEventListener('click', createTable);
  $('leaveTableBtn').addEventListener('click', leaveCurrentTable);
  $('sitOutBtn').addEventListener('click', sitOut);
  $('sitInBtn').addEventListener('click', sitIn);

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
