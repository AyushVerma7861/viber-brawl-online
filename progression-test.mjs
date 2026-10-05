/* =============================================================================
   progression-test.mjs — XP, levels, achievements and unlocks.

   Two halves:
     PART A  the pure rules, tested directly with no server at all
     PART B  the whole loop end to end: a guest plays, signs up, and is paid out

   Usage: node test/progression-test.mjs [http://127.0.0.1:8787]
   ============================================================================= */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './lib/db.mjs';
import { xpForMatch, xpTotal, periodKeys, isFirstWinToday, XP } from '../multiplayer/src/progression/xp.js';
import { xpForLevel, totalXpForLevel, levelFromTotalXp, MAX_LEVEL } from '../multiplayer/src/progression/level.js';

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

let db = null;
try { db = openDb(ROOT, { readOnly: false }); } catch (e) { /* checked below */ }
/* Reset the rate limiter so a second run within 15 minutes is not blocked for a
   reason that has nothing to do with the code under test. */
if (db) { try { db.run('DELETE FROM rate_limits'); } catch (e) {} }

/* ===========================================================================
   PART A — the pure rules
   =========================================================================== */
console.log('\nViber Brawl — progression test\n');

console.log('[A1] the level curve behaves');
check('level 1 costs a sensible amount of XP', xpForLevel(1) > 50 && xpForLevel(1) < 400, xpForLevel(1));
check('each level costs more than the last',
  xpForLevel(2) > xpForLevel(1) && xpForLevel(10) > xpForLevel(9) && xpForLevel(50) > xpForLevel(49));
check('total XP to reach a level is the sum of the steps',
  totalXpForLevel(5) === xpForLevel(1) + xpForLevel(2) + xpForLevel(3) + xpForLevel(4),
  totalXpForLevel(5));
check('level 1 is reachable with no XP at all', levelFromTotalXp(0).level === 1);
check('the cap is enforced', levelFromTotalXp(999999999).level === MAX_LEVEL, levelFromTotalXp(999999999).level);

const l2 = levelFromTotalXp(totalXpForLevel(2));
check('exactly enough XP lands exactly on the level', l2.level === 2 && l2.xpIntoLevel === 0, JSON.stringify(l2));
const l2b = levelFromTotalXp(totalXpForLevel(2) + 10);
check('a little extra shows as progress, not a new level', l2b.level === 2 && l2b.xpIntoLevel === 10, JSON.stringify(l2b));
check('progress is a fraction between 0 and 1',
  l2b.progress > 0 && l2b.progress < 1, l2b.progress);

console.log('\n[A2] the first level arrives quickly, the later ones do not');
const xpPerMatch = 150;   /* roughly what a decent match pays */
const matchesToLevel = (n) => Math.ceil(totalXpForLevel(n) / xpPerMatch);
check('level 2 arrives after about one match', matchesToLevel(2) <= 2, matchesToLevel(2) + ' matches');
check('level 10 is a few sessions, not a few matches',
  matchesToLevel(10) >= 5 && matchesToLevel(10) <= 40, matchesToLevel(10) + ' matches');
check('level 50 is a real commitment but not absurd',
  matchesToLevel(50) >= 100 && matchesToLevel(50) <= 700, matchesToLevel(50) + ' matches');
check('level 100 is the long-term goal, still reachable',
  matchesToLevel(100) >= 500 && matchesToLevel(100) <= 2500, matchesToLevel(100) + ' matches');

console.log('\n[A3] XP rules');
const win = { placement: 1, kos: 3, falls: 0, dmg_dealt: 250, winner: 1 };
const lose = { placement: 2, kos: 1, falls: 1, dmg_dealt: 120, winner: 0 };
const winXp = xpTotal(xpForMatch(win, { durationS: 120, playerCount: 2, firstWinToday: false }));
const loseXp = xpTotal(xpForMatch(lose, { durationS: 120, playerCount: 2, firstWinToday: false }));
check('winning pays more than losing', winXp > loseXp, winXp + ' vs ' + loseXp);
check('LOSING STILL PAYS — a losing streak is never a dead end', loseXp > 0, loseXp);
check('the winner gets a win bonus line', xpForMatch(win, {}).some(e => e.reason === 'win'));
check('a flawless win gets an extra line', xpForMatch(win, { lostAStock: false }).some(e => e.reason === 'flawless'));
check('a win where you lost a stock does NOT get it', !xpForMatch(win, { lostAStock: true }).some(e => e.reason === 'flawless'));

const farm = xpTotal(xpForMatch({ placement: 4, kos: 0, falls: 0, dmg_dealt: 99999, winner: 0 }, { durationS: 300 }));
const normal = xpTotal(xpForMatch({ placement: 4, kos: 0, falls: 0, dmg_dealt: 500, winner: 0 }, { durationS: 300 }));
check('damage XP is CAPPED so it cannot be farmed', farm - normal <= XP.damageCap, 'extra ' + (farm - normal));

const longGame = xpTotal(xpForMatch({ placement: 4, kos: 0, falls: 0, dmg_dealt: 0, winner: 0 }, { durationS: 100000 }));
check('survival XP is capped too', longGame <= XP.participation + XP.placement[4] + XP.survivalCap + 1, longGame);

const firstWin = xpTotal(xpForMatch(win, { firstWinToday: true }));
const repeatWin = xpTotal(xpForMatch(win, { firstWinToday: false }));
check('the first win of the day is worth a lot more',
  firstWin - repeatWin === XP.firstWinOfDay, firstWin - repeatWin);

console.log('\n[A4] period keys and the daily reset');
const keys = periodKeys();
check('a day key looks like a date', /^\d{4}-\d{2}-\d{2}$/.test(keys.day), keys.day);
check('a week key looks like an ISO week', /^\d{4}-W\d{2}$/.test(keys.week), keys.week);
const noon = new Date('2026-10-05T12:00:00Z').getTime();
const yesterday = new Date('2026-10-04T12:00:00Z').getTime();
check('a player who never won has a first win available', isFirstWinToday(0, noon));
check('a win today blocks another today', !isFirstWinToday(noon, noon + 3600000));
check('a win yesterday does not block today', isFirstWinToday(yesterday, noon));

/* ===========================================================================
   PART B — the whole loop
   =========================================================================== */
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
      const k = pair.slice(0, i).trim(), v = pair.slice(i + 1).trim();
      if (!v) this.cookies.delete(k); else this.cookies.set(k, v);
    }
    let data = null;
    try { data = await res.json(); } catch (e) {}
    return { status: res.status, data };
  }
}
class RoomClient {
  constructor(label) { this.label = label; this.msgs = []; }
  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      const to = setTimeout(() => reject(new Error(this.label + ': timeout')), 12000);
      this.ws.addEventListener('open', () => { clearTimeout(to); resolve(); });
      this.ws.addEventListener('error', () => { clearTimeout(to); reject(new Error(this.label + ': socket error')); });
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.msgs.push(m);
      });
    });
  }
  send(o) { try { this.ws.send(JSON.stringify(o)); } catch (e) {} }
  close() { try { this.ws.close(1000, 'done'); } catch (e) {} }
  all(t) { return this.msgs.filter(m => m.t === t); }
  last(t) { const a = this.all(t); return a.length ? a[a.length - 1] : null; }
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

console.log('\n[B1] a guest plays a match and signs up');
const guest = new Api();
const gname = ('Prog' + stamp.slice(-3)).slice(0, 14);
await guest.req('/api/auth/guest', { method: 'POST', body: { name: gname } });
const guestKey = (await guest.req('/api/auth/me')).data.playerKey;

const host = new RoomClient('host');
await host.connect(WS + '?create=1&id=' + encodeURIComponent(guest.token));
host.send({ t: 'hello', name: gname });
const other = new RoomClient('other');
{
  const w = await host.waitForWhere('welcome', () => true);
  check('the guest opened a room', !!(w && w.roomCode), w && w.roomCode);
  await other.connect(WS + '?room=' + w.roomCode);
  other.send({ t: 'hello', name: 'Opponent' });
  await sleep(300);
  host.send({ t: 'select', charId: 'miner' });
  other.send({ t: 'select', charId: 'volt' });
  await sleep(400);
  host.send({ t: 'ready', ready: true });
  other.send({ t: 'ready', ready: true });
  await sleep(500);
  host.send({ t: 'start' });
  await host.waitForWhere('lobby', m => m.started === true, 9000);
  const t0 = Date.now();
  while (Date.now() - t0 < 9000) {
    const s = host.last('snapshot');
    if (s && s.phase === 'playing') break;
    await sleep(50);
  }
  check('the match started', !!(host.last('snapshot') && host.last('snapshot').phase === 'playing'));
  other.close();                       /* the guest wins by walkover */
  await host.waitForWhere('matchend', () => true, 9000);
  await sleep(2500);
  host.close();
  await sleep(400);
}

const email = 'prog' + stamp + '@example.com';
const reg = await guest.req('/api/auth/register', {
  method: 'POST', body: { email, password: 'a-good-long-passphrase', displayName: ('Prog' + stamp.slice(-3)).slice(0, 14) }
});
check('signing up succeeded', reg.status === 200 && reg.data.ok === true, JSON.stringify(reg.data));
check('their guest match was claimed', reg.data.claimedMatches >= 1, reg.data.claimedMatches);
const accountKey = (await guest.req('/api/auth/me')).data.playerKey;

console.log('\n[B2] they were paid out for the match they played as a guest');
let prog = null;
for (let i = 0; i < 20; i++) {
  const r = await guest.req('/api/progress/me');
  if (r.data && r.data.ok && r.data.level) { prog = r.data; break; }
  await sleep(400);
}
check('/api/progress/me returns a level', !!(prog && prog.level >= 1), prog && prog.level);
check('they earned XP for the claimed match', !!(prog && prog.xpTotal > 0), prog && prog.xpTotal);
check('the XP bar is a sensible fraction',
  prog && prog.progress >= 0 && prog.progress <= 1, prog && prog.progress);
check('career stats were rebuilt', !!(prog && prog.stats && prog.stats.matches >= 1), prog && prog.stats && prog.stats.matches);
check('they were credited with the win', !!(prog && prog.stats && prog.stats.wins >= 1), prog && prog.stats && prog.stats.wins);
check('per-Viber mastery was created', !!(prog && prog.mastery && prog.mastery.length >= 1),
  prog && prog.mastery && prog.mastery.map(m => m.char_id + ':' + m.level).join(','));
check('the unlock catalogue came back with ownership flags',
  !!(prog && prog.unlocks && prog.unlocks.all && prog.unlocks.all.length > 0),
  prog && prog.unlocks && prog.unlocks.all && prog.unlocks.all.length);
check('the next level reward is named', !!(prog && prog.unlocks && prog.unlocks.next),
  prog && prog.unlocks && prog.unlocks.next && ('level ' + prog.unlocks.next.level));

console.log('\n[B3] achievements were evaluated');
const ach = await guest.req('/api/progress/achievements');
check('the achievement list came back', ach.status === 200 && Array.isArray(ach.data.achievements), ach.status);
check('there is a real catalogue', ach.data.achievements.length >= 25, ach.data.achievements.length);
const firstMatch = (ach.data.achievements || []).find(a => a.id === 'first_match');
const firstWinAch = (ach.data.achievements || []).find(a => a.id === 'first_win');
check('"play your first match" unlocked', firstMatch && firstMatch.unlocked === true, firstMatch && firstMatch.progress);
check('"win your first match" unlocked', firstWinAch && firstWinAch.unlocked === true, firstWinAch && firstWinAch.progress);
const notYet = (ach.data.achievements || []).find(a => a.id === 'win_100');
check('a long-term achievement is still locked', notYet && notYet.unlocked === false, notYet && notYet.progress);
check('locked achievements show a progress bar', !!(notYet && notYet.target > 0), notYet && notYet.target);
check('secret achievements are hidden until earned',
  (ach.data.achievements || []).filter(a => a.secret && !a.unlocked).every(a => a.name === '???'));
check('rarity is a percentage', (ach.data.achievements || []).every(a => a.rarity >= 0 && a.rarity <= 100));

console.log('\n[B4] challenges progressed');
const chal = await guest.req('/api/progress/challenges');
check('the challenge list came back', chal.status === 200 && Array.isArray(chal.data.challenges), chal.status);
check('there are daily and weekly challenges',
  chal.data.challenges.some(c => c.period === 'daily') && chal.data.challenges.some(c => c.period === 'weekly'));
check('playing a match progressed the "play 3 matches" daily',
  (chal.data.challenges.find(c => c.id === 'd_play_3') || {}).progress >= 1,
  (chal.data.challenges.find(c => c.id === 'd_play_3') || {}).progress);
check('progress never exceeds the target',
  chal.data.challenges.every(c => c.progress <= c.target));

console.log('\n[B5] the database agrees, and nothing can be double-paid');
if (!db) {
  check('database helper available', false, 'skipped');
} else {
  const ledgerSum = db.scalar('SELECT COALESCE(SUM(amount),0) FROM xp_ledger WHERE account_id = ?', accountKey);
  const stored = db.scalar('SELECT xp_total FROM progress WHERE account_id = ?', accountKey);
  check('progress.xp_total EQUALS the ledger sum (it is derived, not incremented)',
    ledgerSum === stored, ledgerSum + ' vs ' + stored);

  const dupes = db.one(
    `SELECT COUNT(*) n FROM (
       SELECT account_id, reason, match_id FROM xp_ledger
        WHERE match_id IS NOT NULL
        GROUP BY account_id, reason, match_id HAVING COUNT(*) > 1)`);
  check('no XP line was ever paid twice', dupes.n === 0, dupes.n);

  const reasons = db.all('SELECT DISTINCT reason FROM xp_ledger WHERE account_id = ?', accountKey)
    .map(r => r.reason);
  check('the ledger records WHY each grant happened', reasons.length >= 2, reasons.join(','));

  const ownedCount = db.scalar('SELECT COUNT(*) FROM account_unlocks WHERE account_id = ?', accountKey);
  check('the default cosmetics are owned', ownedCount >= 4, ownedCount);

  const badUnlock = db.one(
    `SELECT COUNT(*) n FROM unlocks
      WHERE payload_json IS NOT NULL
        AND (payload_json LIKE '%speed%' OR payload_json LIKE '%health%'
             OR payload_json LIKE '%jump%' OR payload_json LIKE '%damage%')`);
  check('NO cosmetic can carry a gameplay value', badUnlock.n === 0, badUnlock.n);
}

console.log('\n[B6] re-running the payout cannot inflate anything');
const beforeXp = prog ? prog.xpTotal : 0;
{
  /* a fresh guest, then signing in — this runs the claim-and-award path again */
  const second = new Api();
  await second.req('/api/auth/guest', { method: 'POST', body: { name: 'Second' + stamp.slice(-2) } });
  const login = await second.req('/api/auth/login', { method: 'POST', body: { email, password: 'a-good-long-passphrase' } });
  check('signing in again works', login.status === 200 && login.data.ok === true, JSON.stringify(login.data));
  await sleep(1200);
  const after = await second.req('/api/progress/me');
  check('XP did not change after a second payout run',
    (after.data && after.data.xpTotal) === beforeXp,
    beforeXp + ' -> ' + (after.data && after.data.xpTotal));
}

if (db) db.close();

console.log('\n' + '='.repeat(66));
console.log(failures === 0
  ? 'PROGRESSION WORKS — matches pay out, levels are earned, nothing double-counts'
  : failures + ' CHECK(S) FAILED');
console.log('='.repeat(66) + '\n');
process.exit(failures === 0 ? 0 : 1);
