// Tests for the desktop super-admin Admin Room button.
//
// Covers the whole path the feature spans:
//   1. public/index.html  — the button exists in the desktop top bar and
//      ships hidden (no flash of an admin control for ordinary players).
//   2. public/css/style.css — desktop-only placement; a [hidden] button
//      is never revealed by CSS alone.
//   3. public/js/client.js — the visibility predicate, the fact that
//      updateTopBar() drives it, the state.isAdmin guard, and the click
//      wiring.
//   4. src/database.js — the case-insensitive super-admin identity, run
//      against a real (in-memory) Mongo so the role-derivation paths are
//      exercised rather than pattern-matched.
//   5. server.js — the authoritative re-validation: every admin_* entry
//      point is still gated, and the super-admin gate is name-checked
//      through db.isSuperAdminName rather than trusting the client.
//
// Run directly:  node tests/test_admin_desktop_button.js

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { MongoMemoryServer } = require('mongodb-memory-server');

const ROOT = path.join(__dirname, '..');
const index = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const client = fs.readFileSync(path.join(ROOT, 'public', 'js', 'client.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'public', 'css', 'style.css'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');

// ---------------------------------------------------------------------------
// 1. Markup: the desktop top-bar button
// ---------------------------------------------------------------------------
{
  const topInfo = index.slice(index.indexOf('<div class="top-info"'), index.indexOf('</div>', index.indexOf('<div class="top-info"')) + 6);
  assert.ok(topInfo.length > 0, 'index.html has a #topInfo desktop top-bar container');

  const btn = topInfo.match(/<button[^>]*id="desktopAdminBtn"[^>]*>/);
  assert.ok(btn, 'desktopAdminBtn lives inside the desktop #topInfo bar');

  const tag = btn[0];
  assert.ok(/class="[^"]*ghost-btn/.test(tag), 'desktopAdminBtn is styled as a ghost-btn like its neighbours');
  assert.ok(/class="[^"]*desktop-admin-btn/.test(tag), 'desktopAdminBtn carries the .desktop-admin-btn hook used by the CSS');
  assert.ok(/\shidden(\s|>)/.test(tag), 'desktopAdminBtn ships with the `hidden` attribute (no admin control before login)');
  assert.ok(/type="button"/.test(tag), 'desktopAdminBtn is type="button" so it cannot submit anything');
  assert.ok(/aria-label="[^"]+"/.test(tag), 'desktopAdminBtn has an aria-label for screen readers');
  const label = topInfo.slice(btn.index + tag.length).match(/^([^<]*)</);
  assert.ok(label && /Admin/.test(label[1]),
    'desktopAdminBtn has a visible Admin label, not just an icon or an aria-label');

  // The mobile entry point must survive — the feature adds a desktop
  // equivalent, it does not replace the mobile one.
  assert.ok(index.includes('id="mobileAdminLink"'), 'the mobile #mobileAdminLink entry point still exists');
}

// ---------------------------------------------------------------------------
// 2. CSS: desktop-only, and never overrides [hidden]
// ---------------------------------------------------------------------------
{
  assert.ok(
    /\.top-info \.desktop-admin-btn\[hidden\]\s*\{\s*display:\s*none/.test(css),
    'CSS pins [hidden] to display:none so a higher-specificity .ghost-btn rule cannot reveal the button'
  );
  const desktopBlock = css.slice(css.indexOf('.desktop-admin-btn'));
  assert.ok(
    /@media\s*\(min-width:\s*721px\)[\s\S]*?\.top-info \.desktop-admin-btn\s*\{[\s\S]*?display:\s*inline-flex/.test(desktopBlock),
    'the button is laid out as a top-bar control at desktop widths (min-width:721px)'
  );
  assert.ok(
    /@media\s*\(max-width:\s*720px\)[\s\S]*?\.top-info \.desktop-admin-btn\s*\{\s*display:\s*none\s*!important/.test(desktopBlock),
    'the button is removed below 721px — mobile keeps the lobby link instead'
  );
  assert.ok(
    /@media\s*\(prefers-reduced-motion/.test(css),
    'stylesheet still contains the reduced-motion block (not truncated by the append)'
  );
}

// ---------------------------------------------------------------------------
// 3. Client: predicate, rendering, guard, wiring
// ---------------------------------------------------------------------------
{
  assert.match(client, /const SUPER_ADMIN_USERNAME = 'nathanielk8';/,
    'client pins the super-admin username it gates the button on');
  assert.match(client, /function isSuperAdminUser\(name\)/,
    'client exposes a single isSuperAdminUser predicate');
  assert.match(client, /normalize\('NFKC'\)\.toLowerCase\(\)/,
    'the predicate is trim + NFKC + case insensitive, mirroring the server');
  assert.match(client, /function updateDesktopAdminButton\(\)/,
    'client has a dedicated updateDesktopAdminButton renderer');
  assert.match(client, /const show = !!state\.player && isSuperAdminUser\(state\.player\.name\);/,
    'the button is shown only for the logged-in super-admin account');
  assert.match(client, /btn\.hidden = !show;/,
    'visibility is applied by toggling the `hidden` property, not by injecting markup');
  assert.match(client, /function updateTopBar\(\)\s*\{[\s\S]{0,400}?updateDesktopAdminButton\(\);/,
    'updateTopBar() re-evaluates the button, so login and role changes are picked up');
  assert.match(client, /function openAdminRoom\(\)\s*\{\s*if \(!state\.isAdmin\)\s*\{[^}]*showToast\('Admin access required'[^}]*return;\s*\}\s*setView\('admin'\);/,
    'openAdminRoom() refuses to open for a non-admin and otherwise opens the existing Admin Room view');
  assert.match(client, /closest\('#desktopAdminBtn'\)/,
    'the click is wired to #desktopAdminBtn');
  assert.match(client, /if \(btn\) openAdminRoom\(\);/,
    'clicking the desktop button routes through openAdminRoom');

  // The button must not have been smuggled into a code path that runs
  // before login: it is only ever revealed from updateDesktopAdminButton,
  // which no-ops until state.player exists.
  const btnAssignments = client.match(/desktopAdminBtn[\s\S]{0,400}?\.hidden\s*=/g) || [];
  assert.strictEqual(btnAssignments.length, 1,
    'exactly one place unhides the button, so no other code path can reveal it');
}

// ---------------------------------------------------------------------------
// 4. Behaviour: run the real render + click functions against a fake DOM
// ---------------------------------------------------------------------------
//
// The blocks above assert the wiring exists; this asserts it behaves. The
// three functions are lifted verbatim out of the shipped client source and
// executed with stubbed DOM/state collaborators, so a change to the real
// implementation is what gets tested — not a paraphrase of it.
{
  const src = client;
  const lift = (startMarker, endMarker) => {
    const from = src.indexOf(startMarker);
    assert.ok(from > -1, 'client defines ' + startMarker);
    const to = src.indexOf(endMarker, from);
    assert.ok(to > from, 'client defines the end of ' + startMarker);
    return src.slice(from, to + endMarker.length);
  };
  const code = [
    // The constant travels with the predicate: the gate is "this exact
    // username", so testing one without the other would be meaningless.
    src.slice(src.indexOf('const SUPER_ADMIN_USERNAME'),
              src.indexOf('\n', src.indexOf('const SUPER_ADMIN_USERNAME')) + 1),
    lift('function isSuperAdminUser', '\n}'),
    lift('function updateDesktopAdminButton', '\n}'),
    lift('function openAdminRoom', '\n}'),
  ].join('\n');

  function makeButton() {
    return { id: 'desktopAdminBtn', hidden: true, attrs: {}, tabIndex: 0,
      setAttribute(k, v) { this.attrs[k] = v; } };
  }

  function harness(opts) {
    const btn = makeButton();
    const calls = { setView: [], toast: [] };
    const state = { player: opts.player || null, isAdmin: !!opts.isAdmin };
    const $ = (id) => (id === 'desktopAdminBtn' ? btn : null);
    const setView = (v) => calls.setView.push(v);
    const showToast = (msg) => calls.toast.push(msg);
    const api = eval('(function(){ const $ = arguments[0]; const state = arguments[1];' +
      ' const setView = arguments[2]; const showToast = arguments[3];' + code +
      '\nreturn { isSuperAdminUser, updateDesktopAdminButton, openAdminRoom }; })');
    return { api: api($, state, setView, showToast), btn, calls, state };
  }

  // Logged out: the button must stay hidden.
  {
    const h = harness({});
    h.api.updateDesktopAdminButton();
    assert.strictEqual(h.btn.hidden, true, 'logged out: the button stays hidden');
    assert.strictEqual(h.btn.attrs['aria-hidden'], 'true', 'logged out: aria-hidden=true');
    assert.strictEqual(h.btn.tabIndex, -1, 'logged out: removed from the tab order');
  }

  // Ordinary players: hidden, and the click is refused.
  {
    const h = harness({ player: { name: 'Alice' }, isAdmin: false });
    h.api.updateDesktopAdminButton();
    assert.strictEqual(h.btn.hidden, true, 'ordinary player: the button stays hidden');
    h.api.openAdminRoom();
    assert.deepStrictEqual(h.calls.setView, [], 'ordinary player: clicking does not open the Admin Room');
    assert.deepStrictEqual(h.calls.toast, ['Admin access required'],
      'ordinary player: clicking explains why instead of opening an empty room');
  }

  // A granted admin (isAdmin true, different username): still hidden.
  {
    const h = harness({ player: { name: 'Bob' }, isAdmin: true });
    h.api.updateDesktopAdminButton();
    assert.strictEqual(h.btn.hidden, true,
      'an admin granted by the super-admin does NOT get the super-admin button');
  }

  // The super-admin: shown, in the tab order, and opens the existing room.
  for (const name of ['nathanielk8', 'Nathanielk8', 'NATHANIELK8', ' nathanielk8 ']) {
    const h = harness({ player: { name }, isAdmin: true });
    h.api.updateDesktopAdminButton();
    assert.strictEqual(h.btn.hidden, false, 'super-admin "' + name + '": the button is shown');
    assert.strictEqual(h.btn.attrs['aria-hidden'], 'false', 'super-admin "' + name + '": aria-hidden=false');
    assert.strictEqual(h.btn.tabIndex, 0, 'super-admin "' + name + '": in the tab order');
    h.api.openAdminRoom();
    assert.deepStrictEqual(h.calls.setView, ['admin'],
      'super-admin "' + name + '": clicking opens the existing Admin Room view');
    assert.deepStrictEqual(h.calls.toast, [], 'super-admin "' + name + '": no refusal toast');
  }

  // The owner-token account is a DIFFERENT identity and must not match,
  // even though it is also an admin.
  {
    const h = harness({ player: { name: 'nathanielk7' }, isAdmin: true });
    h.api.updateDesktopAdminButton();
    assert.strictEqual(h.btn.hidden, true,
      'the nathanielk7 owner-token admin is not the super-admin account and gets no button');
  }

  // Logout-ish transition: a session that ends must hide it again.
  {
    const h = harness({ player: { name: 'nathanielk8' }, isAdmin: true });
    h.api.updateDesktopAdminButton();
    assert.strictEqual(h.btn.hidden, false, 'shown while logged in as the super-admin');
    h.state.player = { name: 'SomeoneElse' };
    h.api.updateDesktopAdminButton();
    assert.strictEqual(h.btn.hidden, true, 'hidden again when the session changes identity');
  }
}

// ---------------------------------------------------------------------------
// 5. Server: the authoritative gates are still in place
// ---------------------------------------------------------------------------
{
  // The client check is an affordance. Every privileged socket event must
  // still be re-validated server-side.
  const gatedEvents = [
    'admin_list', 'admin_set_points', 'admin_add_points', 'admin_kick',
    'admin_remove', 'admin_set_starting_stack', 'admin_list_sessions',
    'admin_update_session',
  ];
  for (const evt of gatedEvents) {
    const idx = server.indexOf("socket.on('" + evt + "'");
    assert.ok(idx > -1, 'server exposes ' + evt);
    const body = server.slice(idx, idx + 400);
    assert.match(body, /if \(!requireAdmin\(cb\)\) return;/,
      evt + ' re-validates the admin role server-side before doing anything');
  }

  const setRoleIdx = server.indexOf("socket.on('admin_set_role'");
  assert.ok(setRoleIdx > -1, 'server exposes admin_set_role');
  assert.match(server.slice(setRoleIdx, setRoleIdx + 300), /if \(!requireSuperAdmin\(name, cb\)\) return;/,
    'granting or revoking admin requires the super-admin role server-side');

  assert.match(server, /if \(socket\.data\.player && db\.isSuperAdminName\(socket\.data\.player\.name\)\s*\n?\s*&& socket\.data\.role === db\.ROLE_SUPER_ADMIN\) return true;/,
    'requireSuperAdmin compares the identity case-insensitively via db.isSuperAdminName');
  assert.match(server, /function requireAdmin\(cb\)[\s\S]{0,200}?const allowed = isAdminRole\(role\);/,
    'requireAdmin still derives the role from the session, not from client input');

  // No admin gate may be satisfied by a name the client supplied.
  assert.ok(!/socket\.data\.isAdmin\s*=\s*payload|socket\.data\.role\s*=\s*payload/.test(server),
    'no socket handler lets a client payload overwrite its own admin role');
}

// ---------------------------------------------------------------------------
// 6. Case-insensitive super-admin identity, against a real Mongo
// ---------------------------------------------------------------------------
async function checkIdentity() {
  const mongoServer = await MongoMemoryServer.create();
  process.env.MONGO_URI = mongoServer.getUri();

  const db = require('../src/database.js');
  await db.connect();
  await db.resetForTests();

  assert.strictEqual(db.SUPER_ADMIN_NAME.toLowerCase(), 'nathanielk8',
    'the canonical super-admin account is the nathanielk8 user');

  // The predicate itself.
  assert.strictEqual(db.isSuperAdminUser, undefined,
    'the client-side predicate is not duplicated on the db module');
  assert.strictEqual(db.isSuperAdminName('nathanielk8'), true, 'predicate: exact lower-case name');
  assert.strictEqual(db.isSuperAdminName('Nathanielk8'), true, 'predicate: canonical casing');
  assert.strictEqual(db.isSuperAdminName('NATHANIELK8'), true, 'predicate: upper case');
  assert.strictEqual(db.isSuperAdminName('  nathanielk8  '), true, 'predicate: surrounding whitespace');
  assert.strictEqual(db.isSuperAdminName('nathanielk7'), false, 'predicate: the owner-token account is a different identity');
  assert.strictEqual(db.isSuperAdminName('nathanielk'), false, 'predicate: missing digit is not the super-admin');
  assert.strictEqual(db.isSuperAdminName('nathanielk88'), false, 'predicate: extra digit is not the super-admin');
  assert.strictEqual(db.isSuperAdminName('xnathanielk8'), false, 'predicate: prefix character is not the super-admin');
  assert.strictEqual(db.isSuperAdminName(''), false, 'predicate: empty string');
  assert.strictEqual(db.isSuperAdminName(null), false, 'predicate: null');
  assert.strictEqual(db.isSuperAdminName(undefined), false, 'predicate: undefined');
  assert.strictEqual(db.isSuperAdminName(42), false, 'predicate: non-string');

  // A fresh lower-case account is created WITH the super-admin role —
  // this is the path that would otherwise have produced an owner who could
  // see the button but not use it.
  const created = await db.getOrCreatePlayer('nathanielk8');
  assert.strictEqual(created.role, db.ROLE_SUPER_ADMIN,
    'a lower-case "nathanielk8" registration is created as super-admin');
  assert.strictEqual(created.isAdmin, true, 'a lower-case "nathanielk8" registration is created as admin');

  // An existing, demoted doc is repaired on the next login.
  const other = await db.getOrCreatePlayer('Nathanielk8', { isAdmin: false, role: db.ROLE_NONE });
  assert.strictEqual(other.role, db.ROLE_SUPER_ADMIN,
    'a pre-existing demoted Nathanielk8 doc is promoted back to super-admin on login');

  // Ordinary players and granted admins keep their own roles.
  const alice = await db.getOrCreatePlayer('Alice');
  assert.strictEqual(alice.role, db.ROLE_NONE, 'an ordinary player is not an admin');
  const bob = await db.getOrCreatePlayer('Bob', { isAdmin: true });
  assert.strictEqual(bob.role, db.ROLE_ADMIN, 'a granted admin holds the admin role, not super-admin');
  assert.strictEqual(bob.isAdmin, true, 'a granted admin is an admin');

  // ensureSuperAdmin must not demote the lower-cased owner, and must not
  // promote anybody else to super-admin.
  await db.ensureSuperAdmin();
  const roster = await db.getAllPlayers();
  const byName = new Map(roster.map((p) => [p.name, p]));
  assert.strictEqual(byName.get('nathanielk8').role, db.ROLE_SUPER_ADMIN,
    'ensureSuperAdmin leaves the lower-cased owner as super-admin');
  assert.strictEqual(byName.get('Alice').role, db.ROLE_NONE, 'ensureSuperAdmin leaves ordinary players alone');
  assert.strictEqual(byName.get('Bob').role, db.ROLE_ADMIN, 'ensureSuperAdmin leaves granted admins at admin');
  assert.strictEqual(roster.filter((p) => p.role === db.ROLE_SUPER_ADMIN).length, 2,
    'both spellings of the owner account resolve to the one super-admin identity');

  // The fixed super-admin role cannot be edited or revoked by anyone.
  const fixed = await db.setPlayerRole('nathanielk8', db.ROLE_NONE);
  assert.strictEqual(fixed.ok, false, 'the super-admin role cannot be revoked via setPlayerRole');
  const demote = await db.setPlayerRole('nathanielk8', db.ROLE_ADMIN);
  assert.strictEqual(demote.ok, false, 'the super-admin role cannot be downgraded to admin via setPlayerRole');
  await assert.rejects(
    () => db.setUserAdmin('nathanielk8', false),
    /Super-admin cannot be revoked/,
    'setUserAdmin cannot revoke the super-admin'
  );
  await assert.rejects(
    () => db.deletePlayer('nathanielk8'),
    /Super-admin cannot be deleted/,
    'the super-admin account cannot be deleted'
  );

  await db.disconnect();
  await mongoServer.stop();
}

checkIdentity()
  .then(() => console.log('admin desktop button tests: passed'))
  .catch((err) => { console.error(err); process.exit(1); });
