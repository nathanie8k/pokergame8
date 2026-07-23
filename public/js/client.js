/* Friendly Poker - client SPA.
 *
 * Vanilla JS, no build step. Uses socket.io loaded from the server's
 * /socket.io/socket.io.js endpoint.
 *
 * State is held in a single object; render() redraws the appropriate view.
 */

'use strict';

const RANK_NAMES = { 2:'2',3:'3',4:'4',5:'5',6:'6',7:'7',8:'8',9:'9',10:'T',11:'J',12:'Q',13:'K',14:'A' };
const SUIT_GLYPH = { s: '♠', h: '♥', d: '♦', c: '♣' };
const SUIT_COLOR = { s: 'black', h: 'red', d: 'red', c: 'black' };

const state = {
  socket:        null,
  player:        null,       // { id, name, points }
  isAdmin:       false,
  tables:        [],         // lobby view: [{ id, name, seatsTaken, maxSeats, phase, handInProgress }]
  currentTable:  null,       // full table state if joined
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

function logout() {
  state.player = null;
  try { localStorage.removeItem('pokerName'); } catch (e) {}
  socket.disconnect();
  socket.connect();
  setView('login');
  $('topInfo').style.display = 'none';
}

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
    if (seat && seat.occupied) {
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
  else if (seat.removed) statusClass.push('removed','Removed');
  else if (seat.disconnected) statusClass.push('removed','Disconnected');
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

  ringChildren.forEach(c => wrap.appendChild(buildRing(c)));
  return wrap;
}

function buildRing(...kids) {
  const ring = el('div', { class: 'seat-ring' });
  kids.forEach(k => ring.appendChild(k));
  return ring;
}

function renderCard(c, opts = {}) {
  // Render either a real card face (rank + suit) or a face-down card back.
  // `opts.faceDown` forces the back design, and is also used when no card
  // data is available, so opponents' hole slots are never blank boxes.
  const faceDown = !!opts.faceDown || !c;
  const card = el('div', {
    class: (faceDown ? 'card face-down' : 'card' + (SUIT_COLOR[c.suit] === 'red' ? ' red' : ''))
         + (opts.small ? ' card-small' : '')
         + ' fade-in',
  });
  if (!faceDown) {
    card.appendChild(el('div', { class: 'rank', text: rankLabel(c.rank) }));
    card.appendChild(el('div', { class: 'suit-l', text: SUIT_GLYPH[c.suit] }));
    card.appendChild(el('div', { class: 'center-suit', text: SUIT_GLYPH[c.suit] }));
  }
  return card;
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

// ---------- Wire up UI buttons ----------

document.addEventListener('DOMContentLoaded', () => {
  $('loginBtn').addEventListener('click', doLogin);
  $('loginName').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('refreshNamesBtn').addEventListener('click', () => socket.emit('random_names'));

  $('logoutBtn').addEventListener('click', logout);
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

  // Action buttons
  document.querySelectorAll('.action-btn[data-action]').forEach(b => {
    b.addEventListener('click', () => performAction(b.dataset.action));
  });
  $('raiseBtn').addEventListener('click', () => {
    const amt = parseInt($('raiseAmount').value, 10);
    performAction('raise', amt);
  });

  loadRandomNames();
});
