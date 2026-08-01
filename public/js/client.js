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
  isAdmin:       false,
  tables:        [],
  currentTable:  null,
  adminRoom: {
    sessions: [],
    editorTableId: null,
    house: null,
    actionLog: null,     // latest admin_action_log payload
  },
  leaderboardData: null,
  view:          'login',    // 'login' | 'lobby' | 'table' | 'admin' | 'profile' | 'stats'
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
  // Profile / stats modals
  profileModalPlayer: null,
  statsModalPlayer: null,
  // Notification permission (asked once)
  notificationsAsked: false,
  // Owner-secret modal reentrancy state. Same pattern as
  // adminLoginPending/adminLoginTimer above: gates rapid
  // click/Enter repeats during the in-flight register call, with a
  // 5s safety fallback so a missed server reply can't lock the
  // modal open until page reload.
  ownerSecretPending: false,
  ownerSecretTimer: null,
  // prevStacks: per-render snapshot of seat.stack keyed by playerId.
  // Used purely for the cosmetic count-up/down animation in
  // renderSeat / populateSelfPanel. Resetting on leave-table / new
  // table join is unnecessary — extra entries are harmless (a stale
  // playerId simply reads as 'prev = undefined' on the next render of
  // that seat, so no count-up fires until a value lands).
  prevStacks: {},
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
  // Reset + apply type class, then play the slide-in. The .show class
  // triggers the slide-in transition (see style.css `.toast.show`).
  t.className = 'toast ' + type;
  t.style.display = 'block';
  // Two RAFs guarantees the browser commits the .toast display:block
  // before the .show opacity toggle runs, so the transition fires
  // reliably (single-rAF sometimes collapses the change when the
  // element was previously hidden).
  requestAnimationFrame(() => requestAnimationFrame(() => t.classList.add('show')));
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => {
    t.classList.remove('show');
    // Hide after the 220ms fade-out completes.
    setTimeout(() => { if (!t.classList.contains('show')) t.style.display = 'none'; }, 240);
  }, 3000);
}

// ---------- Cosmetic count-up helper (UI only) ----------
//
// `tickCount(el, from, to)` animates an integer between two values over
// `duration` ms using requestAnimationFrame. Updates the DOM as a side
// effect. Respects prefers-reduced-motion and aborts automatically if
// the element is no longer connected (e.g. a re-render blew it away).
// Never used to gate any game timing — purely a polish layer over
// values set by renderTable() etc.
function tickCount(el, from, to, duration = 600) {
  if (!el) return;
  if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    el.textContent = formatNumber(to);
    return;
  }
  if (from === to) {
    el.textContent = formatNumber(to);
    return;
  }
  const start = performance.now();
  const delta = to - from;
  const ease = (x) => 1 - Math.pow(1 - x, 3); // easeOutCubic
  let raf;
  function step(now) {
    if (!el.isConnected) return;
    const t = Math.min(1, (now - start) / duration);
    const v = Math.round(from + delta * ease(t));
    el.textContent = formatNumber(v);
    if (t < 1) raf = requestAnimationFrame(step);
  }
  raf = requestAnimationFrame(step);
}

// Soft-prompt gate helpers (UI only — server untouched).
// We track the "first-login password" UX gate purely client-side via
// localStorage. Trigger: on the FIRST successful admin_login on this
// device, the change-password panel is shown and the player management
// section stays hidden until the host saves a new password. After a
// successful change, the flag is set and the gate collapses. If the
// host changes the password elsewhere (e.g. via the regular change
// form after the first time, or by editing data.json), the flag is
// stale but still hides the gate — purely UX. Clearing the device's
// localStorage resets it.
// (LS_PASSWORD_CHANGED_KEY + hasPasswordChanged/markPasswordChanged
// + DEFAULT_ADMIN_PASSWORD soft-prompt helpers were removed when the
// in-app password-rotation flow was retired: the admin password is
// now a server-config value, rotated only via env edits + restart.
// See the server.js admin_change_password handler removal comment
// for the matching backend change.)

// Owner-secret storage. Per-name localStorage slot. Server-side gate
// decides which names are "reserved"; the SPA just remembers whatever
// (name → token) pair the user successfully secured, and re-attaches
// it on every subsequent register call (incl. socket reconnects).
// The reserved name itself is NEVER spelled in client-side code —
// the SPA simply stores/loads by the typed name, so the same flow
// works for any name the server marks reserved.
const LS_OWNER_TOKEN_PREFIX = 'poker.ownerToken::';
function lsOwnerTokenKey(name) { return LS_OWNER_TOKEN_PREFIX + String(name || ''); }
function getStoredOwnerToken(name) {
  try { return localStorage.getItem(lsOwnerTokenKey(name)) || null; }
  catch (e) { return null; }
}
function setStoredOwnerToken(name, token) {
  try {
    if (token) localStorage.setItem(lsOwnerTokenKey(name), token);
    else localStorage.removeItem(lsOwnerTokenKey(name));
  } catch (e) {}
}



function formatNumber(n) {
  // Format chips with thousand separators.
  return String(Math.floor(n || 0)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function rankLabel(rank) { return RANK_NAMES[rank] || String(rank); }

// Derive 1- or 2-letter initials from a display name for the seat
// avatar circle. Purely cosmetic — never used for any identification
// logic. Single-word names get just the first letter; multi-word names
// get the first letter of the first + first letter of the second word;
// missing/empty names get a safe "?" placeholder.
function getInitials(name) {
  if (!name || typeof name !== 'string') return '?';
  // First normalise diacritics to ASCII so names like "Renée" or
  // "José" don't get shredded by the ASCII-only strip below ("Renée"
  // → "Renee" instead of "Rene"). Then strip non-[A-Za-z0-9_]
  // characters to drop leading suit prefixes the random-name
  // generator emits ("♠Lucky12", "♥Brave88") — purely cosmetic —
  // and take the first letter of up to the first two surviving
  // words. Empty / missing text falls back to a safe "?".
  const normalised = name.normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const stripped = normalised.replace(/[^A-Za-z0-9_]+/g, ' ');
  const parts = stripped.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  const first = parts[0].charAt(0) || '?';
  const second = parts.length > 1 ? (parts[1].charAt(0) || '') : '';
  return (first + second).toUpperCase();
}

// ---------- View switching ----------

function setView(v) {
  state.view = v;
  // Toggle is-table-view body class so mobile CSS can scope compact
  // top-bar rules to ONLY the table view (not login/lobby).
  if (document.body) document.body.classList.toggle('is-table-view', v === 'table');
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
  // Mobile felt pills
  var mftrPP = $('mftrPlayerPill');
  if (mftrPP) mftrPP.textContent = state.player.name;
  var mftrPtP = $('mftrPointsPill');
  if (mftrPtP) mftrPtP.textContent = formatNumber(state.player.points) + ' pts';
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
  // Pre-attach any stored per-name secret so a returning owner
  // doesn't re-prompt on every device wake / socket reconnect. The
  // stored value is just a string the SPA carries between sessions;
  // the SERVER matches it against OWNER_TOKEN in server.js, and the
  // SPA has no knowledge of which names are reserved (the server
  // tells us via errorCode).
  const storedToken = getStoredOwnerToken(name);
  socket.emit('register', { name, token: storedToken || undefined }, res => {
    if (res && res.ok) {
      state.player = res.player;
      state.isAdmin = res.player.isAdmin === true;
      try { localStorage.setItem('pokerName', state.player.name); } catch (e) {}
      updateTopBar();
      syncAdminButtonVisibility();
      setView('lobby');
      socket.emit('random_names'); // refresh names for next time
    } else {
      // Owner-secret handshake: server signals via `errorCode` that
      // this name is reserved and a secret is needed. Branch on the
      // code (NOT on a magic error string) so a generic message
      // change elsewhere doesn't accidentally trigger the modal.
      const code = res && res.errorCode;
      if (code === 'owner_login_required' || code === 'owner_login_failed') {
        openOwnerSecretModal(name, code === 'owner_login_failed' ? 'failed' : 'required');
        return;
      }
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

// ----- Owner-secret modal -----
//
// Triggered when the server's register handler reports a reserved
// name via errorCode 'owner_login_required' (cold: never sent a
// token) or 'owner_login_failed' (retry: token was wrong). The
// modal carries the originally typed name in a `data-name`
// attribute so submitOwnerSecret() can re-attempt register with
// the same target name. The SPA never holds a list of reserved
// names — the server tells us when one was hit.
//
// Reentrancy: ownerSecretPending gates rapid click/Enter spam on
// the submit button, mirror of the admin-modal
// adminLoginPending pattern just above. Cleared by the register
// callback OR by a 5s safety fallback so a mid-flight server
// disconnect can't lock the modal open until page reload.
function openOwnerSecretModal(typedName, errState /* 'required' | 'failed' */) {
  const modal = $('ownerSecretModal');
  if (!modal || !typedName) return;
  const promptEl = $('ownerSecretPrompt');
  if (promptEl) {
    promptEl.textContent = errState === 'failed'
      ? 'That secret was wrong — try again.'
      : 'Enter the owner secret for this reserved name.';
  }
  const errEl = $('ownerSecretError');
  if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  if ($('ownerSecretInput')) $('ownerSecretInput').value = '';
  modal.dataset.name = typedName;
  modal.dataset.errState = errState || 'required';
  modal.style.display = '';
  setTimeout(() => { const i = $('ownerSecretInput'); if (i) i.focus(); }, 0);
}

function closeOwnerSecretModal() {
  const modal = $('ownerSecretModal');
  if (!modal) return;
  modal.style.display = 'none';
  delete modal.dataset.name;
  delete modal.dataset.errState;
}

function submitOwnerSecret() {
  const modal = $('ownerSecretModal');
  if (!modal || state.ownerSecretPending) return;
  const typedName = modal.dataset.name;
  const inputEl = $('ownerSecretInput');
  const token = inputEl ? inputEl.value : '';
  if (!typedName) return closeOwnerSecretModal();
  if (!token) {
    const errEl = $('ownerSecretError');
    if (errEl) { errEl.textContent = 'Secret cannot be empty.'; errEl.style.display = ''; }
    if (inputEl) inputEl.focus();
    return;
  }
  const submitBtn = $('ownerSecretSubmitBtn');
  if (submitBtn) submitBtn.disabled = true;
  state.ownerSecretPending = true;
  // Safety fallback mirror: if the server never replies the user
  // would otherwise be locked out of the modal until page reload.
  state.ownerSecretTimer = setTimeout(() => {
    state.ownerSecretPending = false;
    state.ownerSecretTimer = null;
    if (submitBtn) submitBtn.disabled = false;
  }, 5000);
  // Store-on-commit: the secret is committed to localStorage ONLY
  // when the register call succeeds (see the res.ok branch of the
  // callback below). Submitting a wrong token must NOT clobber a
  // previously-stored working secret. The server reply drives the
  // write; the user just typed something we haven't validated yet.
  socket.emit('register', { name: typedName, token }, res => {
    if (submitBtn) submitBtn.disabled = false;
    state.ownerSecretPending = false;
    if (state.ownerSecretTimer) {
      clearTimeout(state.ownerSecretTimer);
      state.ownerSecretTimer = null;
    }
    if (res && res.ok) {
      // Commit-on-success: only persist the secret to localStorage
      // once the server validates it. Storing a wrong token before
      // the server reply would mean a forced re-prompt + a stale
      // localStorage value clinging to the typed name across page
      // reloads. The doLogin() path stores on commit too — neither
      // flow pre-commits before server validation.
      setStoredOwnerToken(typedName, token);
      state.player = res.player;
      state.isAdmin = res.player.isAdmin === true;
      try { localStorage.setItem('pokerName', state.player.name); } catch (e) {}
      closeOwnerSecretModal();
      updateTopBar();
      syncAdminButtonVisibility();
      setView('lobby');
      socket.emit('random_names');
    } else {
      const code = res && res.errorCode;
      if (code === 'owner_login_required' || code === 'owner_login_failed') {
        // Keep the modal open. Use the server's code to drive the
        // copy: 'required' for a cold-prompt first attempt, 'failed'
        // when the user typed something that didn't match. Crucially:
        // no setStoredOwnerToken call here — a wrong token must NOT
        // clobber a previously-stored working secret.
        if (inputEl) inputEl.value = '';
        openOwnerSecretModal(typedName, code === 'owner_login_required' ? 'required' : 'failed');
      } else if (res && res.error) {
        closeOwnerSecretModal();
        showToast(res.error, 'error');
      } else {
        closeOwnerSecretModal();
        showToast('Login failed', 'error');
      }
    }
  });
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

      // Reveal the player-management + global-defaults panel
      // immediately on a successful admin_login. The legacy first-time
      // "set a new password" interstitial was retired alongside the
      // in-app change-password flow; the password is treated as
      // already-set from the operator's standing server config.
      const ctEl = $('adminContent');
      if (ctEl) ctEl.style.display = '';
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
  // PURELY COSMETIC. Kept as a no-op for back-compat with callers
  // that still Object.assign(wrap.style, seatPosition(...)); the
  // CSS now positions seats via .seat[data-slot="N"] rules, and
  // JS sets wrap.dataset.slot directly. Returning {} here means
  // older inline style assignments are still safe (no-op).
  return {};
}

// Map of maxSeats → list of slot indices that should be visible
// around the felt. The viewer always lands at slot 0 (front,
// bottom-center). Each step clockwise from the viewer fills the
// next slot in the list. Slot 5 = top-center (directly opposite
// viewer); slots 1/2 = viewer's left/right; slots 3/4 =
// top-left/top-right. Used by renderTable loop + renderSeat to
// pin every occupied/unoccupied seat at a fixed CSS coordinate
// via data-slot.
const SLOT_LAYOUTS = {
  2: [0, 5],              // heads-up: viewer + opposite
  3: [0, 1, 2],           // 3-max: viewer + 2 sides
  4: [0, 1, 2, 5],        // 4-max: viewer + 2 sides + opposite
  5: [0, 1, 2, 3, 4],     // 5-max: viewer + 2 sides + 2 top corners
  6: [0, 1, 2, 3, 4, 5],  // 6-max: full ring
};

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
    const winners = t.lastHandResults.winners || [];        if (winners.length === 1) {
          const w = winners[0];
          hr.textContent = `${w.name} wins ${formatNumber(w.share)} with ${w.handName}`;
        } else {
          const names = winners.map(w => `${w.name} (${w.handName})`).join(', ');
          hr.textContent = `Split pot: ${names}`;
        }
        // Rake notice: append a small subdued span right after the
        // winner text. Local-only (no `window` global) so re-renders
        // retain a stable DOM ref. The data field
        // `t.lastHandResults.houseFee` is populated by src/poker.js's
        // awardPot (NON-ZERO when houseFeePercent > 0 and the hand
        // actually settled with a winner or via fold-out -- busted-
        // refund hands are voided and lastHandResults is wiped, so
        // the notice stays hidden in that case).
        const _feeNum = t.lastHandResults && typeof t.lastHandResults.houseFee === 'number'
          ? t.lastHandResults.houseFee : 0;
        if (_feeNum > 0) {
          const _rakeSpan = document.createElement('span');
          _rakeSpan.className = 'rake-notice';
          _rakeSpan.style.cssText = 'margin-left: 8px; font-size: 11px; opacity: 0.65;';
          _rakeSpan.textContent = '(house took ' + _feeNum + ' chip' + (_feeNum === 1 ? '' : 's') + ' rake)';
          hr.appendChild(_rakeSpan);
        }
  }

  // Seats
  const seatsHost = $('seatsContainer');
  seatsHost.innerHTML = '';
  const N = t.maxSeats;
  let playerSeatedHere = false;
  // Find the viewer's server-side seat index, then lay players out
  // clockwise starting at the viewer's relative position so the
  // viewer always lands at slot 0 (front, bottom-center). Server
  // seat indices are positional around the table from the dealer;
  // visual slots are fixed CSS coordinates (see SLOT_LAYOUTS).
  const selfServerIdx = t.seats.findIndex(s => s.isSelf);
  const visible = SLOT_LAYOUTS[N] || SLOT_LAYOUTS[6];
  // relIdx = 0 → viewer; relIdx = 1 → next clockwise; ...
  for (let relIdx = 0; relIdx < visible.length; relIdx++) {
    const slotIdx   = visible[relIdx];
    const serverIdx = (selfServerIdx + relIdx + N) % N;
    const seat      = t.seats[serverIdx];
    // A seat with `removed` or `disconnected === true` is server-side a stale
    // occupant that the lobby's seatsTaken count already excludes — see
    // server.js#listTables and server.js#join_table. Render it as the same
    // "Sit here" empty-chair the lobby advertises so the view stays
    // consistent; otherwise the player sees an occupied-looking chair with
    // a "Removed"/"Disconnected" status label, thinks "nobody is sitting",
    // and the server can still toast "Seat taken" if they tried to sit there.
    if (seat && seat.occupied && !seat.removed && !seat.disconnected) {
      if (seat.isSelf) playerSeatedHere = true;
      const seatEl = renderSeat(seat, serverIdx, t, N);
      seatEl.dataset.slot = String(slotIdx);
      seatsHost.appendChild(seatEl);
    } else {
      // Take-a-seat pill: subtle empty chair with a + icon and "Sit here" label.
      // The label is hidden on narrow viewports (≤480px via CSS) so it never
      // truncates mid-character ("...ere"). serverIdx is passed to the join
      // API; slotIdx drives CSS positioning via data-slot.
      const emptyEl = el('div', {
        class: 'empty-seat',
        title: 'Click to sit here',
        onclick: () => seatEmpty(serverIdx, t.id),
      }, [
        el('span', { class: 'empty-seat-icon', text: '+', 'aria-hidden': 'true' }),
        el('span', { class: 'empty-seat-label', text: 'Sit here' }),
      ]);
      emptyEl.dataset.slot = String(slotIdx);
      seatsHost.appendChild(emptyEl);
    }
  }

  // Sit-out / Sit-in buttons for self
  const selfSeat = t.seats.find(s => s.occupied && s.isSelf);
  // Self-panel: single horizontal row with three flex segments
  //  [info | cards | action buttons]. Each segment is populated
  // independently so the static action-bar (Fold/Check/Call/Raise/All-in)
  // isn't wiped on every renderTable pass. The "is-active" glow goes
  // on the wrapper #selfPanel so the WHOLE panel (info + cards + action
  // buttons) glows when it's the viewer's turn, matching the old
  // populateSelfPanel behavior.
  const sidxForActive = t.seats.findIndex(s => s && s.isSelf);
  $('selfPanel').classList.toggle('is-active',
    sidxForActive >= 0 && sidxForActive === t.currentPlayerIndex);
  populateSelfInfo($('selfPanelInfo'), selfSeat, t);
  populateSelfCards($('selfPanelCards'), selfSeat);

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

  // Populate mobile full-felt elements
  populateMobileFelt(t, selfSeat);

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
  // data-slot is set by the renderTable loop (which knows the viewer's
  // relative position). Defensive default keeps the seat at slot 0 if
  // renderSeat is called without the caller pre-setting data-slot.
  wrap.dataset.slot = wrap.dataset.slot || '0';

  const nameClasses = ['name'];
  if (idx === table.buttonIndex) nameClasses.push('dealer-mark');
  if (idx === table.sbIndex)     nameClasses.push('sb-mark');
  if (idx === table.bbIndex)     nameClasses.push('bb-mark');

  // Avatar circle derives 1-2 capital letters from seat.name via the
  // getInitials helper below. Purely cosmetic — the avatar is the
  // redesigned seat-pill's primary visual; the name row now sits
  // beneath it.
  const ringChildren = [
    el('div', { class: 'seat-avatar', 'aria-hidden': 'true', text: getInitials(seat.name) }),
    el('div', { class: nameClasses.join(' '), text: seat.name }),
  ];
  // Stack display — animate value changes via tickCount (purely cosmetic).
  // state.prevStacks is keyed by seat.playerId and snapshots the value
  // from the previous renderTable call. On this render, if the value
  // changed, we tween it over 500ms and toggle is-up / is-down for a
  // brief color hint. The DOM is updated as a side effect of tickCount;
  // we don't gate any socket event on the animation.
  const stackEl = el('div', { class: 'stack' });
  if (seat.playerId) {
    const prev = state.prevStacks[seat.playerId];
    const cur  = Number(seat.stack || 0);
    if (typeof prev === 'number' && prev !== cur) {
      // Choose color hint based on direction of change.
      stackEl.classList.add(cur > prev ? 'is-up' : 'is-down');
      // Strip the hint after the animation completes so re-renders
      // don't leave a permanent tint.
      setTimeout(() => stackEl.classList.remove('is-up', 'is-down'), 1200);
      tickCount(stackEl, prev, cur, 500);
    } else {
      stackEl.textContent = formatNumber(cur);
    }
    state.prevStacks[seat.playerId] = cur;
  } else {
    stackEl.textContent = formatNumber(seat.stack || 0);
  }
  const statusWrap = el('div', {});
  statusWrap.appendChild(stackEl);
  let statusText = '';
  if (seat.folded)  statusText = 'Folded';
  else if (seat.allIn)   statusText = 'All-in';
  else if (seat.satOut)  statusText = 'Sitting out';
  if (statusText) statusWrap.appendChild(el('span', { class: 'status ' + (seat.folded ? 'folded' : seat.allIn ? 'all-in' : 'sat-out'), text: ' \u00B7 ' + statusText }));
  ringChildren.push(statusWrap);

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
  // Dealer chip — small circular "D" badge that floats on the edge of
  // the seat at table.buttonIndex. Rendered as a sibling of the
  // .seat-ring so CSS can position it independently. Purely cosmetic —
  // the engine + every other UI surface already key off
  // table.buttonIndex directly.
  if (idx === table.buttonIndex) {
    wrap.appendChild(el('div', { class: 'seat-dealer-chip', text: 'D', 'aria-label': 'Dealer button' }));
  }
  // Bet chip — small chip-stack indicator showing the seat's
  // contributed amount, anchored toward the table center. Renders
  // only when the seat has chips actively on the felt (contributed > 0).
  // Purely cosmetic — the amount is consumed verbatim from the socket
  // payload (no client-side math, no game-state read).
  if (seat.contributed && seat.contributed > 0) {
    wrap.appendChild(el('div', { class: 'seat-bet-chip', text: formatNumber(seat.contributed) }));
  }
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

function populateSelfInfo(infoEl, seat, t) {
  // Writes the LEFT segment of .self-panel: name + stack + status
  // + position label stacked vertically. Living in #selfPanelInfo
  // (separate from #selfPanelCards) lets the .self-panel wrapper
  // use a clean three-segment flex-row layout (info | cards |
  // action buttons). Called only when seat is non-null. The
  // "your turn" glow now lives on #selfPanel itself, set from
  // renameTable so the WHOLE panel (info + cards + buttons) glows.
  if (!infoEl) return;
  infoEl.innerHTML = '';
  if (!seat) return;
  const sidx = t.seats.findIndex((s) => s && s.isSelf);
  infoEl.appendChild(el('div', { class: 'self-name' }, seat.name));
  // Stack count-up/down mirrors renderSeat — reuse state.prevStacks + tickCount.
  // Cosmetic only: never gates any socket event. On mobile, this panel IS
  // the viewer's only visible chip count (the .seat.is-self ring is hidden).
  const selfStackEl = el('div', { class: 'self-stack' });
  if (seat.playerId) {
    const prev = state.prevStacks[seat.playerId];
    const cur  = Number(seat.stack || 0);
    if (typeof prev === 'number' && prev !== cur) {
      selfStackEl.classList.add(cur > prev ? 'is-up' : 'is-down');
      setTimeout(() => selfStackEl.classList.remove('is-up', 'is-down'), 1200);
      tickCount(selfStackEl, prev, cur, 500);
    } else {
      selfStackEl.textContent = formatNumber(cur) + ' pts';
    }
    state.prevStacks[seat.playerId] = cur;
  } else {
    selfStackEl.textContent = formatNumber(seat.stack || 0) + ' pts';
  }
  infoEl.appendChild(selfStackEl);
  let status = '';
  if (seat.folded)      status = 'Folded';
  else if (seat.allIn)  status = 'All-in';
  else if (seat.satOut) status = 'Sitting out';
  if (status) infoEl.appendChild(el('div', { class: 'self-status' }, status));
  const marks = [];
  if (sidx === t.buttonIndex) marks.push('Dealer (D)');
  if (sidx === t.sbIndex)     marks.push('Small Blind');
  if (sidx === t.bbIndex)     marks.push('Big Blind');
  if (marks.length) infoEl.appendChild(el('div', { class: 'self-marks' }, marks.join(' \u00B7 ')));
}

function populateSelfCards(cardsEl, seat) {
  // Writes the MIDDLE segment of .self-panel: the viewer's two
  // hole cards. When hole cards are unknown (observer / pre-deal)
  // we render two face-down card backs so the layout doesn't
  // collapse to a thin sliver.
  if (!cardsEl) return;
  cardsEl.innerHTML = '';
  if (!seat) {
    cardsEl.appendChild(renderCard(null, { faceDown: true }));
    cardsEl.appendChild(renderCard(null, { faceDown: true }));
    return;
  }
  if (seat.holeCards && seat.holeCards.length === 2) {
    seat.holeCards.forEach((c, i) => cardsEl.appendChild(renderCard(c, { delay: i * 80 })));
  } else {
    cardsEl.appendChild(renderCard(null, { faceDown: true }));
    cardsEl.appendChild(renderCard(null, { faceDown: true }));
  }
}

function populateMobileFelt(t, selfSeat) {
  // ---- Seat markers around table edges ----
  var markersHost = $('mobileFeltSeatMarkers');
  if (markersHost) {
    var N = t.maxSeats;
    var selfServerIdx = t.seats.findIndex(function(s) { return s && s.isSelf; });

    if (selfServerIdx >= 0) {
      var visibleSlots = SLOT_LAYOUTS[N] || SLOT_LAYOUTS[6];

      // Map visual slot index → mobile marker position key
      var slotToMobile = { 1: 'rl', 2: 'rm', 3: 'ru', 4: 'lu', 5: 'lm' };

      // Clear all markers first
      var allMarkers = markersHost.querySelectorAll('.mfsm-seat');
      allMarkers.forEach(function(m) {
        m.innerHTML = '';
        m.classList.remove('mfsm-current-turn');
        m.style.display = 'none';
      });

      for (var relIdx = 0; relIdx < visibleSlots.length; relIdx++) {
        var slotIdx = visibleSlots[relIdx];
        if (slotIdx === 0) continue; // viewer, handled in center
        var serverIdx = (selfServerIdx + relIdx + N) % N;
        var seat = t.seats[serverIdx];
        var mobileKey = slotToMobile[slotIdx];
        if (!mobileKey) continue;

        var markerEl = markersHost.querySelector('[data-mfsm-pos="' + mobileKey + '"]');
        if (!markerEl) continue;
        markerEl.style.display = '';

        if (seat && seat.occupied && !seat.removed && !seat.disconnected) {
          // Occupied: name + stack
          var nameEl = el('span', { class: 'mfsm-name', text: seat.name });
          markerEl.appendChild(nameEl);
          var stackEl = el('span', { class: 'mfsm-stack', text: formatNumber(seat.stack) });
          markerEl.appendChild(stackEl);

          // Highlight if this seat is the current active player
          if (serverIdx === t.currentPlayerIndex) {
            markerEl.classList.add('mfsm-current-turn');
          }
        } else {
          // Empty: "Sit here"
          var sitEl = el('span', {
            class: 'mfsm-sit-here',
            text: 'Sit here',
            title: 'Click to sit here',
            onclick: (function(seatIdx, tableId) {
              return function() { seatEmpty(seatIdx, tableId); };
            })(serverIdx, t.id),
          });
          markerEl.appendChild(sitEl);
        }
      }
    } // end if (selfServerIdx >= 0)
  } // end if (markersHost)

  // Update table name + info row
  var tn = $('mfsrTableName');
  if (tn) tn.textContent = t.name;
  var ti = $('mfsrTableInfo');
  if (ti) {
    var bits = [];
    bits.push('Hand #' + (t.handNumber || 0));
    if (t.smallBlind !== undefined) bits.push('Blinds ' + t.smallBlind + '/' + t.bigBlind);
    var liveCount = t.seats.filter(function(s) { return s.occupied && !s.removed; }).length;
    if (t.phase && t.phase !== 'waiting' && t.phase !== 'hand_over') bits.push('Players ' + liveCount + '/' + t.maxSeats);
    ti.textContent = bits.join(' \u00B7 ');
  }

  // Pot
  var pa = $('mfcPotAmount');
  if (pa) pa.textContent = formatNumber(t.pot);

  // Community card slots
  var ccs = $('mfcCommunitySlots');
  if (ccs) {
    ccs.innerHTML = '';
    (t.communityCards || []).forEach(function(c, i) {
      var slot = el('div', { class: 'mfc-card-slot mfc-filled' });
      slot.appendChild(renderCard(c, { delay: i * 80 }));
      ccs.appendChild(slot);
    });
    for (var i = (t.communityCards || []).length; i < 5; i++) {
      ccs.appendChild(el('div', { class: 'mfc-card-slot' }));
    }
  }

  // Player hole cards
  var hc = $('mfcHoleCards');
  if (hc) {
    hc.innerHTML = '';
    if (selfSeat && selfSeat.holeCards && selfSeat.holeCards.length === 2) {
      selfSeat.holeCards.forEach(function(c, i) {
        hc.appendChild(renderCard(c, { delay: i * 80 }));
      });
    } else {
      hc.appendChild(renderCard(null, { faceDown: true }));
      hc.appendChild(renderCard(null, { faceDown: true }));
    }
  }

  // Seat info
  var av = $('mfcAvatar');
  if (av) av.textContent = selfSeat ? getInitials(selfSeat.name) : '?';
  var sn = $('mfcSeatName');
  if (sn) {
    sn.textContent = '';
    if (selfSeat) {
      var sidx = t.seats.findIndex(function(s) { return s && s.isSelf; });
      var marks = [];
      if (sidx === t.buttonIndex) marks.push('(D)');
      if (sidx === t.sbIndex) marks.push('SB');
      if (sidx === t.bbIndex) marks.push('BB');
      sn.textContent = (marks.length ? marks.join(' ') + ' ' : '') + selfSeat.name;
    }
  }
  var stk = $('mfcStack');
  if (stk) stk.textContent = formatNumber(selfSeat ? selfSeat.stack : 0);

  // Purple card backs
  var hcb = $('mfcHoleCardsBack');
  if (hcb) {
    hcb.innerHTML = '';
    hcb.appendChild(el('div', { class: 'mfc-card-back' }));
    hcb.appendChild(el('div', { class: 'mfc-card-back' }));
  }

  // Bet chip
  var bc = $('mfcBetChip');
  if (bc) {
    if (selfSeat && selfSeat.contributed && selfSeat.contributed > 0) {
      bc.textContent = formatNumber(selfSeat.contributed);
      bc.style.display = '';
    } else {
      bc.style.display = 'none';
    }
  }

  // Sit out / Sit in buttons (toggle visibility based on satOut state)
  var so = $('mfsrSitOutBtn');
  var si = $('mfsrSitInBtn');
  if (so) {
    so.style.display = (selfSeat && !selfSeat.folded && !selfSeat.allIn && !selfSeat.satOut && selfSeat.stack > 0) ? '' : 'none';
  }
  if (si) {
    si.style.display = (selfSeat && selfSeat.satOut && !selfSeat.folded && !selfSeat.allIn && selfSeat.stack > 0) ? '' : 'none';
  }

  // Phase display on mobile
  var mp = $('mobileFeltPhase');
  if (mp) {
    var phaseLabel = ({
      waiting: 'Waiting for players',
      pre_flop: 'Pre-flop',
      flop: 'Flop',
      turn: 'Turn',
      river: 'River',
      showdown: 'Showdown',
      hand_over: 'Hand complete',
    })[t.phase] || t.phase;
    mp.textContent = phaseLabel;
  }
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

// ---------- Name change (once per 30 days) ----------

function openNameChangeModal() {
  const modal = $('nameChangeModal');
  if (!modal || !state.player) return;
  const player = state.player;
  $('nameChangeCurrent').textContent = player.name;
  $('nameChangeInput').value = '';
  $('nameChangeError').style.display = 'none';
  $('nameChangeSubmitBtn').disabled = false;

  // Check cooldown from the player data (server sends lastNameChangeAt in hello + register).
  const cooldownEl = $('nameChangeCooldown');
  cooldownEl.style.display = 'none';
  if (player.lastNameChangeAt) {
    const msSinceChange = Date.now() - player.lastNameChangeAt;
    const daysRemaining = Math.ceil(30 - (msSinceChange / (24 * 60 * 60 * 1000)));
    if (daysRemaining > 0) {
      cooldownEl.textContent = 'You changed your name recently. You can change it again in ' + daysRemaining + ' day' + (daysRemaining === 1 ? '' : 's') + '.';
      cooldownEl.style.display = '';
      $('nameChangeSubmitBtn').disabled = true;
    }
  }

  modal.style.display = '';
  setTimeout(() => { const i = $('nameChangeInput'); if (i) i.focus(); }, 0);
}

function closeNameChangeModal() {
  const modal = $('nameChangeModal');
  if (!modal) return;
  modal.style.display = 'none';
  $('nameChangeInput').value = '';
  $('nameChangeError').style.display = 'none';
}

function submitNameChange() {
  const newName = $('nameChangeInput').value.trim();
  const errEl = $('nameChangeError');
  errEl.style.display = 'none';
  if (!newName) {
    errEl.textContent = 'Please enter a new name.';
    errEl.style.display = '';
    return;
  }
  if (newName.length < 2) {
    errEl.textContent = 'Name must be at least 2 characters.';
    errEl.style.display = '';
    return;
  }
  if (newName.length > 20) {
    errEl.textContent = 'Name must be at most 20 characters.';
    errEl.style.display = '';
    return;
  }
  if (!/^[\w .'\-]+$/.test(newName)) {
    errEl.textContent = 'Name contains invalid characters.';
    errEl.style.display = '';
    return;
  }
  if (newName.toLowerCase() === (state.player && state.player.name || '').toLowerCase()) {
    errEl.textContent = 'New name must differ from your current name.';
    errEl.style.display = '';
    return;
  }

  const submitBtn = $('nameChangeSubmitBtn');
  submitBtn.disabled = true;
  socket.emit('change_name', { newName }, res => {
    submitBtn.disabled = false;
    if (res && res.ok) {
      state.player = res.player;
      state.isAdmin = res.player.isAdmin === true;
      try { localStorage.setItem('pokerName', res.player.name); } catch (e) {}
      updateTopBar();
      closeNameChangeModal();
      showToast('Name changed to ' + res.player.name, 'good');
    } else {
      errEl.textContent = (res && res.error) ? res.error : 'Name change failed';
      errEl.style.display = '';
    }
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
  // Mirror the disabled state on the .raise-row parent so its
  // mobile-CSS :not(.is-active) collapse-rule hides the row when
  // raise isn't legal. setupActionButtons is the only writer —
  // the class is reset on every renderTable round. Purely cosmetic
  // layout logic; no socket events touched.
  $('betControls').classList.toggle('is-active', !raiseBtn.disabled);
  // When no one has bet yet (post-flop first action or a pre-flop limp scenario),
  // the existing "Raise" button takes a Bet role. Relabel it so the player
  // sees the correct poker term.
  raiseBtn.textContent = (t.currentBet || 0) === 0 ? 'Bet' : 'Raise';
  raiseInput.min = minRaiseTotal;
  raiseInput.max = maxRaise;
  raiseInput.value = Math.min(minRaiseTotal, maxRaise);

  allInBtn.disabled = selfSeat.stack <= 0;
  allInBtn.textContent = `All-in ${formatNumber(selfSeat.stack)}`;

  // ---- Mobile felt action labels ----
  var mfaCheck = $('mfaCheck');
  var mfaFold  = $('mfaFold');
  var mfaRaise = $('mfaRaise');
  var mfaCall  = $('mfaCall');
  var mfaAllin = $('mfaAllin');

  var setMFA = function(el, disabled, text) {
    if (!el) return;
    el.classList.toggle('mfa-disabled', disabled);
    if (text) el.textContent = text;
  };

  setMFA(mfaFold, false, 'Fold');
  setMFA(mfaCheck, toCall > 0, 'Check');
  var callDisabled = toCall <= 0 || selfSeat.stack < toCall;
  if (toCall > 0) {
    setMFA(mfaCall, callDisabled, 'Call ' + formatNumber(Math.min(selfSeat.stack, toCall)));
  } else {
    setMFA(mfaCall, callDisabled, 'Call');
  }
  var raiseDisabled = selfSeat.stack <= 0 || maxRaise < minRaiseTotal;
  setMFA(mfaRaise, raiseDisabled, (t.currentBet || 0) === 0 ? 'Bet' : 'Raise');
  setMFA(mfaAllin, selfSeat.stack <= 0, 'All-in');

  // Store raise bounds for sizing labels
  if (!state._mobileRaise) state._mobileRaise = {};
  state._mobileRaise.minRaiseTotal = minRaiseTotal;
  state._mobileRaise.maxRaise = maxRaise;

  // ---- Mobile felt sizing labels ----
  var sizingHost = $('mobileFeltSizing');
  if (sizingHost) {
    sizingHost.style.display = raiseDisabled ? 'none' : '';
    var sizingLabels = sizingHost.querySelectorAll('.mfs-label');

    // Build presets
    var presets = [];
    if (t.currentBet === 0) {
      var minVal = Math.min(t.bigBlind, selfSeat.stack);
      presets.push({ label: 'Min', val: minVal, key: 'min' });
      presets.push({ label: '2\u00d7', val: Math.min(t.bigBlind * 2, selfSeat.stack), key: 'x2' });
      presets.push({ label: '5\u00d7', val: Math.min(t.bigBlind * 5, selfSeat.stack), key: 'x5' });
      presets.push({ label: 'All', val: selfSeat.stack, key: 'all' });
    } else {
      var callAmt = toCall + selfSeat.contributed + Math.max(t.minRaise || t.bigBlind, t.bigBlind);
      presets.push({ label: 'Min', val: Math.min(callAmt, maxRaise), key: 'min' });
      presets.push({ label: '2\u00d7', val: Math.min(t.currentBet * 2, maxRaise), key: 'x2' });
      presets.push({ label: 'Pot', val: Math.min(t.pot + t.currentBet, maxRaise), key: 'pot' });
      presets.push({ label: 'All',  val: maxRaise, key: 'all' });
    }

    // Store presets for click handlers
    state._mobileRaise.presets = presets;

    sizingLabels.forEach(function(lbl) {
      var key = lbl.dataset.sizing;
      var preset = presets.find(function(p) { return p.key === key; });
      if (preset && preset.val > 0) {
        lbl.classList.remove('mfs-disabled');
        lbl.textContent = preset.label + ' (' + formatNumber(Math.max(selfSeat.contributed, preset.val)) + ')';
      } else {
        lbl.classList.add('mfs-disabled');
        lbl.textContent = key === 'min' ? 'Min' : key === 'x2' ? 'x2' : key === 'x5' ? 'x5' : 'All';
      }
    });
  }

  // Raise presets (desktop)
  const presetsHost = $('raisePresets');
  if (presetsHost) {
    presetsHost.innerHTML = '';
    var deskPresets = [];
    if (t.currentBet === 0) {
      deskPresets.push({ label: 'Min', val: Math.min(t.bigBlind, selfSeat.stack) });
      deskPresets.push({ label: '2\u00d7', val: Math.min(t.bigBlind * 2, selfSeat.stack) });
      deskPresets.push({ label: '5\u00d7', val: Math.min(t.bigBlind * 5, selfSeat.stack) });
    } else {
      var callAmtD = toCall + selfSeat.contributed + Math.max(t.minRaise || t.bigBlind, t.bigBlind);
      deskPresets.push({ label: 'Min', val: Math.min(callAmtD, maxRaise) });
      deskPresets.push({ label: '2\u00d7', val: Math.min(t.currentBet * 2, maxRaise) });
      deskPresets.push({ label: 'Pot', val: Math.min(t.pot + t.currentBet, maxRaise) });
      deskPresets.push({ label: 'All',  val: maxRaise });
    }
    deskPresets.forEach(function(p) {
      if (p.val <= 0) return;
      presetsHost.appendChild(el('button', {
        text: p.label + ' (' + formatNumber(Math.max(selfSeat.contributed, p.val)) + ')',
        title: 'Set raise amount',
        onclick: function() { raiseInput.value = p.val; },
      }));
    });
  }
}

function disableAllActions() {
  document.querySelectorAll('.action-btn').forEach(b => { b.disabled = true; });
  $('raiseAmount').disabled = true;
  document.querySelectorAll('.raise-presets button').forEach(b => { b.disabled = true; });
  // Mobile action labels
  ['mfaCheck','mfaFold','mfaRaise','mfaCall','mfaAllin'].forEach(function(id) {
    var el = $(id);
    if (el) el.classList.add('mfa-disabled');
  });
  // Mobile sizing row
  var sizing = $('mobileFeltSizing');
  if (sizing) sizing.style.display = 'none';
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
  // Re-inject the skeleton on every fetch (initial open + Refresh). The
  // previous real render is replaced with the same skeleton placeholder
  // shape so the layout doesn't reflow when data lands. First open keeps
  // the markup-defined skeleton (index.html seeds #leaderboardBody).
  const body = $('leaderboardBody');
  if (body) {
    body.innerHTML =
      '<div class="lb-skeleton" aria-hidden="true">' +
        '<div class="lb-skel-podium">' +
          '<div class="lb-skel-podium-card"></div>' +
          '<div class="lb-skel-podium-card"></div>' +
          '<div class="lb-skel-podium-card"></div>' +
        '</div>' +
        '<div class="lb-skel-list">' +
          '<div class="lb-skel-row"></div>' +
          '<div class="lb-skel-row"></div>' +
          '<div class="lb-skel-row"></div>' +
          '<div class="lb-skel-row"></div>' +
          '<div class="lb-skel-row"></div>' +
          '<div class="lb-skel-row"></div>' +
          '<div class="lb-skel-row"></div>' +
          '<div class="lb-skel-row"></div>' +
        '</div>' +
      '</div>';
  }
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
  // HouseRake -- dedicated non-playing ledger account -- needs an
  // admin-visible marker so it's never confused with a regular
  // player. We tag its row with a CSS class and a "(house account)"
  // suffix, and disable the Delete button on that row (server.js also
  // blocks admin_remove for HouseRake, but disabling here is a defense-
  // in-depth UX so admins don't even see a clickable Delete button).
  const HOUSE_RAKE_NAME = 'HouseRake';
  const HOUSE_RAKE_DISPLAY = 'HouseRake (house account)';

  const tbody = $('adminPlayersTbody');
  if (!tbody) return;
  tbody.innerHTML = '';
  (players || []).forEach(p => {
    const tr = el('tr', { class: p.isAdmin ? 'is-admin-row' : '' });
    {
  // HouseRake -- dedicated non-playing ledger account -- gets a
  // "(house account)" suffix and an `is-house-account` CSS class so
  // admins never confuse it with a regular player. Same row, with a
  // conditional text override. The Delete button below is disabled
  // server-side (server.js admin_remove rejects HouseRake), but the
  // client also shows a disabled control as defense-in-depth.
  const _isHR = (p.name === HOUSE_RAKE_NAME);
  const _nameText = (_isHR ? HOUSE_RAKE_DISPLAY : p.name) + (p.isAdmin ? ' ★' : '');
  const _nameTd = el('td', { text: _nameText });
  if (_isHR) _nameTd.classList.add('is-house-account');
  tr.appendChild(_nameTd);
}
    // Mobile-friendly label via data-label — CSS uses the attr() pattern
    // on td::before at narrow viewports so each table row becomes a
    // readable card with the column name next to the value.
    const labelName   = 'Name';
    const labelPoints = 'Points';
    const labelAdd    = 'Add';
    const labelSet    = 'Set';
    const labelRemove = 'Remove';
    // The Name cell was appended above with an inline scope. We re-tag
    // it for the mobile layout by setting data-label here. Since we
    // can't change the construction above without re-touching logic,
    // we hoist by finding the FIRST td that lacks data-label and
    // tagging it as 'Name'.
    // The Points cell — second td — gets data-label='Points'.
    tr.appendChild(el('td', { 'data-label': labelPoints, text: formatNumber(p.points) }));
    // Tag the previously-appended Name td for mobile card view. We
    // re-attach by setting data-label; client-only attribute, no
    // server-side impact.
    const _nameTdEl = tr.firstChild;
    if (_nameTdEl && _nameTdEl.tagName === 'TD') _nameTdEl.setAttribute('data-label', 'Name');

    const addInput = el('input', { type: 'number', value: '' });
    addInput.placeholder = '+/-';
    addInput.addEventListener('keydown', e => { if (e.key === 'Enter') doAdd(p.name, addInput.value); });
    const addCell = el('td', { 'data-label': 'Add' });
    const addBtn = el('button', { text: 'Add',  onclick: () => doAdd(p.name, addInput.value) });
    addCell.appendChild(addInput);
    addCell.appendChild(addBtn);
    tr.appendChild(addCell);

    const setInput = el('input', { type: 'number', value: p.points });
    setInput.addEventListener('keydown', e => { if (e.key === 'Enter') doSet(p.name, setInput.value); });
    const setCell = el('td', { 'data-label': 'Set' });
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
    tr.appendChild(el('td', { 'data-label': 'Remove' }, [removeBtn]));
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

socket.on('hello', ({ player, reconnectInfo }) => {
  state.player = player;
  state.isAdmin = player.isAdmin === true;
  updateTopBar();
  syncAdminButtonVisibility();
  // #7: Reconnect support — if the server tells us we were seated before,
  // auto-rejoin that table. Only fires once (cleared after use).
  if (reconnectInfo) {
    socket.emit('join_table', { tableId: reconnectInfo.tableId, seatIdx: reconnectInfo.seatIdx }, res => {
      if (res && res.ok) {
        setView('table');
        showToast('Reconnected to your seat', 'good');
      }
    });
  }
  // #9: Handle pending table invite link (set from hash on page load).
  if (window._pendingTableInvite) {
    const tableId = window._pendingTableInvite;
    delete window._pendingTableInvite;
    socket.emit('join_table', { tableId, seatIdx: null }, res => {
      if (res && res.ok) setView('table');
      else showToast(res && res.error ? res.error : 'Could not join table', 'error');
    });
  }
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

// #2: Kicked from table by admin — notified in real-time via socket.
socket.on('kicked_from_table', ({ reason }) => {
  state.currentTable = null;
  clearShowdown();
  showToast(reason || 'You were removed from the table', 'error');
  setView('lobby');
});

// #9: Handle table invite hash links on page load.
function handleTableInviteHash() {
  const hash = window.location.hash;
  const m = hash && hash.match(/^#table=(.+)$/);
  if (m) window._pendingTableInvite = decodeURIComponent(m[1]);
}
handleTableInviteHash();

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
    // Chat-bubble button is now the RIGHT-EDGE chat-toggle tab. Lives
    // INSIDE .poker-table (position:absolute against the table's right
    // edge, not in any flex zone). Click handler toggles .is-open on
    // #chatPanel \u2014 which is also inside .poker-table (position:
    // absolute, slides in from the right via .is-open). aria-expanded
    // tracks the open state for AT users. A separate #chatEdgeCloseBtn
    // \u00d7\u00d7 inside the panel clears .is-open so users can dismiss the
    // panel without reaching back to the right-edge tab. Both handlers
    // are no-op safe if their target element isn't present yet.
    const chatBubble = $('chatBubbleBtn');
    if (chatBubble) {
      chatBubble.addEventListener('click', () => {
        const panel = $('chatPanel');
        if (!panel) return;
        const opened = panel.classList.toggle('is-open');
        chatBubble.setAttribute('aria-expanded', opened ? 'true' : 'false');
      });
    }
    const chatClose = $('chatEdgeCloseBtn');
    if (chatClose) {
      chatClose.addEventListener('click', () => {
        const panel   = $('chatPanel');
        const toggle  = $('chatBubbleBtn');
        if (panel)  panel.classList.remove('is-open');
        if (toggle) toggle.setAttribute('aria-expanded', 'false');
      });
    }
    $('loginBtn').addEventListener('click', doLogin);
  $('loginName').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
  $('refreshNamesBtn').addEventListener('click', () => socket.emit('random_names'));

  // Name change modal
  $('changeNameBtn').addEventListener('click', openNameChangeModal);
  $('nameChangeCloseBtn').addEventListener('click', closeNameChangeModal);
  $('nameChangeSubmitBtn').addEventListener('click', submitNameChange);
  $('nameChangeInput').addEventListener('keydown', e => { if (e.key === 'Enter') submitNameChange(); });
  $('nameChangeModal').addEventListener('click', (e) => {
    if (e.target === $('nameChangeModal')) closeNameChangeModal();
  });

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

  // Owner-secret modal wiring. Registered ONCE at module load (NOT
  // inside the admin-password keydown callback above — that would
  // re-register the same listeners on every keystroke and waste
  // cycles). Defensive null checks let the SPA boot even with a
  // partial HTML rollback (e.g. an old cached page that pre-dates
  // the modal).
  const _ownerSubmitBtn = $('ownerSecretSubmitBtn');
  const _ownerCloseBtn  = $('ownerSecretCloseBtn');
  const _ownerInput     = $('ownerSecretInput');
  if (_ownerSubmitBtn) _ownerSubmitBtn.addEventListener('click', submitOwnerSecret);
  if (_ownerCloseBtn)  _ownerCloseBtn.addEventListener('click', closeOwnerSecretModal);
  if (_ownerInput) _ownerInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); submitOwnerSecret(); }
  });
  $('adminModalRefreshPlayersBtn').addEventListener('click', refreshAdminList);
  // The legacy adminChangePasswordBtn + fpAdminChangePasswordBtn +
  // fpAdminNewPassword Enter-key handlers were removed alongside the
  // 'Change admin password' + first-time interstitial sections.
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

  // ---- Mobile felt action labels (text-only, no buttons) ----
  document.querySelectorAll('.mfa-label[data-action]').forEach(function(lbl) {
    lbl.addEventListener('click', function() {
      if (lbl.classList.contains('mfa-disabled')) return;
      var action = lbl.dataset.action;
      if (action === 'raise' || action === 'bet') {
        // Raise/bet needs an amount. Use the stored minRaiseTotal.
        var mr = (state._mobileRaise && state._mobileRaise.minRaiseTotal);
        var maxR = (state._mobileRaise && state._mobileRaise.maxRaise);
        var amt = mr || 0;
        if (maxR && amt > maxR) amt = maxR;
        performAction(action, amt);
      } else {
        performAction(action);
      }
    });
  });

  // ---- Mobile felt sizing labels ----
  document.querySelectorAll('.mfs-label[data-sizing]').forEach(function(lbl) {
    lbl.addEventListener('click', function() {
      if (lbl.classList.contains('mfs-disabled')) return;
      var presets = (state._mobileRaise && state._mobileRaise.presets) || [];
      var key = lbl.dataset.sizing;
      var preset = presets.find(function(p) { return p.key === key; });
      if (preset) {
        var raiseInput = $('raiseAmount');
        if (raiseInput) raiseInput.value = preset.val;
        // Perform raise/bet with this amount
        var t = state.currentTable;
        var isBet = t && (t.currentBet || 0) === 0;
        performAction(isBet ? 'bet' : 'raise', preset.val);
      }
    });
  });

  // ---- Mobile felt buttons (Sit out, Sit in, Leave table) ----
  var mfsrSO = $('mfsrSitOutBtn');
  var mfsrSI = $('mfsrSitInBtn');
  var mfsrLV = $('mfsrLeaveBtn');
  if (mfsrSO) mfsrSO.addEventListener('click', sitOut);
  if (mfsrSI) mfsrSI.addEventListener('click', sitIn);
  if (mfsrLV) mfsrLV.addEventListener('click', leaveCurrentTable);

  loadRandomNames();
});
