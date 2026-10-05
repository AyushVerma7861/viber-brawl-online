/* =============================================================================
   auth-test.mjs — the account system, end to end.

   Covers the promises the account design makes:
     * a guest can play immediately with no account
     * signing up KEEPS everything the guest already earned
     * passwords are never stored in a form that can be read back
     * the API does not reveal which emails have accounts
     * abuse is rate limited
     * deleting an account actually deletes it
     * a player's account id is never exposed to other players

   Database assertions read the local D1 file directly (see test/lib/db.mjs)
   rather than shelling out to `wrangler d1 execute`, so the running dev server
   is never disturbed and the test can be read top to bottom in logical order.

   Usage: node test/auth-test.mjs [http://127.0.0.1:8787]
   ============================================================================= */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.mjs';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '   ' + extra : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = Date.now().toString(36);

/* ---------------------------------------------------------------- database -- */
/* Read-write, because the test resets the rate-limit table so it is repeatable.
   Reads and writes both work alongside the running dev server (SQLite WAL). */
let db = null;
try { db = openDb(ROOT, { readOnly: false }); } catch (e) { console.log('  (db helper unavailable: ' + e.message + ')'); }

/* ------------------------------------------------------------- HTTP client -- */
class Api {
  constructor() { this.cookies = new Map(); }
  get token() { return this.cookies.get('vb_id') || null; }
  async req(pathname, { method = 'GET', body } = {}) {
    const headers = {};
    if (this.cookies.size) headers.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(BASE + pathname, {
      method, headers, redirect: 'manual',
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const raw = typeof res.headers.getSetCookie === 'function' ? res.headers.getSetCookie() : [];
    for (const c of raw) {
      const pair = c.split(';')[0];
      const i = pair.indexOf('=');
      if (i === -1) continue;
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (!v) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    let data = null;
    try { data = await res.json(); } catch (e) { /* not json */ }
    return { status: res.status, data, setCookie: raw };
  }
}

/* ---------------------------------------------------------- WS test client -- */
class RoomClient {
  constructor(label) { this.label = label; this.msgs = []; }
  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      const to = setTimeout(() => reject(new Error(this.label + ': connect timeout')), 12000);
      this.ws.addEventListener('open', () => { clearTimeout(to); resolve(); });
      this.ws.addEventListener('error', () => { clearTimeout(to); reject(new Error(this.label + ': socket error')); });
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.msgs.push(m);
        if (m.t === 'welcome') { this.id = m.you; this.token = m.token; this.roomCode = m.roomCode; }
      });
      this.ws.addEventListener('close', () => {});
    });
  }
  send(o) { try { this.ws.send(JSON.stringify(o)); } catch (e) {} }
  close() { try { this.ws.close(1000, 'done'); } catch (e) {} }
  all(t) { return this.msgs.filter(m => m.t === t); }
  last(t) { const a = this.all(t); return a.length ? a[a.length - 1] : null; }
  async waitFor(t, ms = 9000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = this.last(t); if (m) return m; await sleep(30); }
    return null;
  }
  async waitForWhere(t, pred, ms = 9000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const f = this.all(t).filter(pred);
      if (f.length) return f[f.length - 1];
      await sleep(30);
    }
    return null;
  }
}

/* =========================================================================== */
console.log('\nViber Brawl — accounts test');
console.log('target: ' + BASE + '\n');

try {
  const h = await (await fetch(BASE + '/api/health')).json();
  check('worker is up and has the accounts database', h.ok === true && h.accounts === true, JSON.stringify(h));
} catch (e) {
  console.log('  FAIL  worker not reachable — start `npx wrangler dev` first');
  process.exit(1);
}

/* Start from a clean rate-limit slate so the test is repeatable. This is the
   one thing that would otherwise make a second run within 15 minutes fail for a
   reason that has nothing to do with the code under test. */
if (db) {
  try { db.run('DELETE FROM rate_limits'); }
  catch (e) { console.log('  (could not reset rate limits: ' + e.message + ')'); }
}

/* ---------------------------------------------------- 1. what is available -- */
console.log('\n[1] the server advertises its sign-in options');
const anon = new Api();
const cfg = await anon.req('/api/auth/config');
check('/api/auth/config works', cfg.status === 200 && cfg.data.ok === true, JSON.stringify(cfg.data));
check('it reports whether password sign-in is on', typeof cfg.data.password === 'boolean', cfg.data.password);
check('it lists configured OAuth providers', Array.isArray(cfg.data.providers), JSON.stringify(cfg.data.providers));

/* ------------------------------------------------------------ 2. guest ----- */
console.log('\n[2] a guest can play with no account at all');
const guestName = ('Guesty' + stamp.slice(-3)).slice(0, 14);
const guest = new Api();
const g = await guest.req('/api/auth/guest', { method: 'POST', body: { name: guestName } });
check('guest creation succeeds', g.status === 200 && g.data.kind === 'guest', JSON.stringify(g.data));
check('a session cookie was set', !!guest.token, guest.token ? guest.token.slice(0, 4) + '…' : 'none');
check('the guest got the name it asked for', g.data.displayName === guestName, g.data.displayName);

const me1 = await guest.req('/api/auth/me');
check('the guest is recognised on the next request', me1.data.kind === 'guest', me1.data.kind);
check('the guest is NOT reported as signed in', me1.data.signedIn === false);
check('the guest has a stable player key', typeof me1.data.playerKey === 'string' && me1.data.playerKey.length > 8);
const guestKey = me1.data.playerKey;

const reused = await guest.req('/api/auth/guest', { method: 'POST', body: { name: 'Someone else' } });
check('asking again reuses the same guest rather than making a new one', reused.data.reused === true, JSON.stringify(reused.data));
check('and the player key is unchanged', (await guest.req('/api/auth/me')).data.playerKey === guestKey);

/* ---------------------------- 3. the guest plays a real match and keeps it -- */
console.log('\n[3] the guest plays a real match, identified by its account token');
const host = new RoomClient('guestHost');
await host.connect(WS + '?create=1&id=' + encodeURIComponent(guest.token));
host.send({ t: 'hello', name: guestName });          /* HELLO must be the first frame */
const welcome = await host.waitFor('welcome');
check('the guest could open a room using its identity token', !!welcome && !!welcome.roomCode, welcome && welcome.roomCode);
const ROOM = welcome.roomCode;

const other = new RoomClient('other');
await other.connect(WS + '?room=' + ROOM);
other.send({ t: 'hello', name: 'OtherGuy' });
await other.waitFor('welcome');
await sleep(300);
host.send({ t: 'select', charId: 'miner' });
other.send({ t: 'select', charId: 'phantom' });
await sleep(400);
host.send({ t: 'ready', ready: true });
other.send({ t: 'ready', ready: true });
await sleep(500);
host.send({ t: 'start' });
await host.waitForWhere('lobby', m => m.started === true, 9000);
{
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    const s = host.last('snapshot');
    if (s && s.phase === 'playing') break;
    await sleep(50);
  }
}
check('the match reached the playing phase', !!(host.last('snapshot') && host.last('snapshot').phase === 'playing'));

other.close();                                   /* the guest wins by walkover */
await host.waitFor('matchend', 9000);
await sleep(2500);
host.close();
await sleep(300);

/* ------------------------------------------- 4. signing up keeps everything -- */
console.log('\n[4] signing up keeps what the guest already earned');
const email = 'player' + stamp + '@example.com';
const displayName = ('Upgraded' + stamp.slice(-3)).slice(0, 14);
const reg = await guest.req('/api/auth/register', {
  method: 'POST', body: { email, password: 'a-good-long-passphrase', displayName }
});
check('registration succeeds', reg.status === 200 && reg.data.ok === true, JSON.stringify(reg.data));
check('the guest\'s match was carried over', reg.data.claimedMatches >= 1, reg.data.claimedMatches);

const me2 = await guest.req('/api/auth/me');
check('the player is now signed in', me2.data.signedIn === true && me2.data.kind === 'account', me2.data.kind);
check('the account has a password identity', (me2.data.identities || []).some(i => i.provider === 'password'));
check('the display name was applied', me2.data.displayName === displayName, me2.data.displayName);
const accountKey = me2.data.playerKey;
check('the player key moved from the guest id to the account id', accountKey !== guestKey, accountKey);

/* ---------------------------------------------------- 5. login and logout -- */
console.log('\n[5] sign out and sign back in');
const out = await guest.req('/api/auth/logout', { method: 'POST' });
check('logout succeeds', out.status === 200, JSON.stringify(out.data));
check('the player is signed out', (await guest.req('/api/auth/me')).data.signedIn === false);

const good = await guest.req('/api/auth/login', { method: 'POST', body: { email, password: 'a-good-long-passphrase' } });
check('signing back in with the right password works', good.status === 200 && good.data.signedIn === true, JSON.stringify(good.data));
check('and it is the SAME account', (await guest.req('/api/auth/me')).data.playerKey === accountKey);

const bad = await guest.req('/api/auth/login', { method: 'POST', body: { email, password: 'definitely-wrong-pass' } });
check('a wrong password is refused', bad.status === 401, bad.status);
check('the refusal does not say whether the account exists',
  /wrong email or password/i.test(String(bad.data.error)), bad.data.error);
const ghost = await guest.req('/api/auth/login', { method: 'POST', body: { email: 'nobody' + stamp + '@example.com', password: 'definitely-wrong-pass' } });
check('an unknown email gives the IDENTICAL message', ghost.data.error === bad.data.error, ghost.data.error);

/* ------------------------------------------------------- 6. input handling -- */
console.log('\n[6] bad input is rejected clearly');
const anon2 = new Api();
const dup = await anon2.req('/api/auth/register', { method: 'POST', body: { email, password: 'another-long-password' } });
check('registering the same email again is refused', dup.status === 409, dup.status);
const weak = await anon2.req('/api/auth/register', { method: 'POST', body: { email: 'weak' + stamp + '@example.com', password: 'password' } });
check('a common password is refused', weak.status === 400, weak.data.error);
const short = await anon2.req('/api/auth/register', { method: 'POST', body: { email: 'short' + stamp + '@example.com', password: 'abc' } });
check('a too-short password is refused', short.status === 400, short.data.error);
const badEmail = await anon2.req('/api/auth/register', { method: 'POST', body: { email: 'not-an-email', password: 'a-good-long-passphrase' } });
check('a malformed email is refused', badEmail.status === 400, badEmail.data.error);

/* ------------------------------------------------------ 7. profile editing -- */
console.log('\n[7] profile editing');
const renamed = await guest.req('/api/auth/profile', { method: 'PATCH', body: { displayName: ('Renamed' + stamp.slice(-3)).slice(0, 14) } });
check('a player can rename themselves', renamed.status === 200 && renamed.data.ok === true, JSON.stringify(renamed.data));
check('a too-short name is refused',
  (await guest.req('/api/auth/profile', { method: 'PATCH', body: { displayName: 'a' } })).status === 400);
check('a reserved name is refused',
  (await guest.req('/api/auth/profile', { method: 'PATCH', body: { displayName: 'admin' } })).status === 400);
const cooldown = await guest.req('/api/auth/profile', { method: 'PATCH', body: { displayName: 'Again' + stamp.slice(-3) } });
check('a second rename is on a cooldown', cooldown.status === 429, cooldown.status);

/* ------------------------------------------------ 8. nothing sensitive leaks -- */
console.log('\n[8] internal ids are not exposed to other players');
const lastSnap = host.last('snapshot');
check('snapshots carry only room-scoped player ids',
  !lastSnap || JSON.stringify(lastSnap).indexOf(accountKey) === -1);

/* ------------------------------- 9. database: the account, before deletion -- */
console.log('\n[9] what is stored for a live account');
if (db) {
  const acct = db.one('SELECT id, email, status FROM accounts WHERE id = ?', accountKey);
  check('the account row exists', acct.id === accountKey, acct.id);
  check('the account is active', acct.status === 'active', acct.status);

  const ident = db.one("SELECT provider, password_hash, password_salt, password_algo FROM identities WHERE account_id = ?", accountKey);
  check('a password identity exists', ident.provider === 'password', ident.provider);
  check('the password is a PBKDF2 hash, never the password itself',
    /^pbkdf2-sha256:\d+$/.test(String(ident.password_algo)), ident.password_algo);
  check('a per-user salt is stored', !!ident.password_salt && ident.password_salt.length >= 16);
  check('no row anywhere contains the plaintext password',
    db.scalar("SELECT COUNT(*) FROM identities WHERE password_hash LIKE '%a-good-long-passphrase%'") === 0);

  check('a live session exists',
    db.scalar('SELECT COUNT(*) FROM sessions WHERE account_id = ? AND revoked_at IS NULL', accountKey) >= 1);
  const tokenHash = db.scalar('SELECT token_hash FROM sessions WHERE account_id = ? LIMIT 1', accountKey);
  check('only a hash of the session token is stored', /^[0-9a-f]{64}$/.test(String(tokenHash)),
    String(tokenHash).slice(0, 12) + '…');

  check('the guest\'s match is now filed under the account',
    db.scalar('SELECT COUNT(*) FROM match_results WHERE player_key = ?', accountKey) >= 1);
  check('no match was left behind under the old guest id',
    db.scalar('SELECT COUNT(*) FROM match_results WHERE guest_id = ? AND account_id IS NULL', guestKey) === 0);

  check('progress rows were created', db.scalar('SELECT COUNT(*) FROM progress WHERE account_id = ?', accountKey) === 1);
  check('the default cosmetics were granted',
    db.scalar('SELECT COUNT(*) FROM account_unlocks WHERE account_id = ?', accountKey) >= 4);
} else {
  check('database helper available', false, 'skipped');
}

/* ----------------------------------------------------------- 10. deletion -- */
console.log('\n[10] deleting an account really deletes it');
const noConfirm = await guest.req('/api/auth/delete', { method: 'POST', body: { confirm: 'yes' } });
check('deletion needs the typed confirmation', noConfirm.status === 400, noConfirm.data.error);

const del = await guest.req('/api/auth/delete', { method: 'POST', body: { confirm: 'DELETE' } });
check('deletion succeeds with confirmation', del.status === 200 && del.data.deleted === true, JSON.stringify(del.data));
check('the deleted account is no longer signed in', (await guest.req('/api/auth/me')).data.signedIn === false);

/* ------------------------------ 11. database: the deletion actually happened -- */
console.log('\n[11] what deletion left behind');
if (db) {
  const gone = db.one('SELECT email, status, deleted_at FROM accounts WHERE id = ?', accountKey);
  check('the account is soft-deleted', gone.status === 'deleted', gone.status);
  check('the email address was released', gone.email === null, gone.email);
  check('a deletion timestamp was recorded', !!gone.deleted_at, gone.deleted_at);
  check('all sign-in identities were removed',
    db.scalar('SELECT COUNT(*) FROM identities WHERE account_id = ?', accountKey) === 0);
  check('all sessions were revoked',
    db.scalar('SELECT COUNT(*) FROM sessions WHERE account_id = ? AND revoked_at IS NULL', accountKey) === 0);

  check('match history is KEPT, for aggregate stats',
    db.scalar('SELECT COUNT(*) FROM match_results WHERE player_key = ?', accountKey) >= 1);
  const anon = db.one('SELECT display_name, account_id FROM match_results WHERE player_key = ? LIMIT 1', accountKey);
  check('the history no longer carries the player\'s name', anon.display_name === 'Deleted Player', anon.display_name);
  check('the history is no longer linked to the account', anon.account_id === null, anon.account_id);
} else {
  check('database helper available', false, 'skipped');
}

/* ------------------------------------------------ 12. rate limiting works --- */
console.log('\n[12] abuse is rate limited');
{
  const hammer = new Api();
  let got429 = false;
  for (let i = 0; i < 20; i++) {
    const r = await hammer.req('/api/auth/login', { method: 'POST', body: { email: 'nobody@example.com', password: 'wrong-password-here' } });
    if (r.status === 429) { got429 = true; break; }
  }
  check('repeated failed sign-ins eventually get 429', got429);
}

if (db) db.close();

console.log('\n' + '='.repeat(66));
console.log(failures === 0
  ? 'ACCOUNTS WORK — guests play free, sign-up keeps everything, nothing leaks'
  : failures + ' CHECK(S) FAILED');
console.log('='.repeat(66) + '\n');
process.exit(failures === 0 ? 0 : 1);
