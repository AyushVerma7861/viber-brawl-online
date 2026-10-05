/* =============================================================================
   profile-ui-test.mjs — the PROFILE screen, in a real browser.

   Sets up a real account with a real played match over the API, hands the
   session cookie to the browser, then checks the screen renders that data.

   Usage: node test/profile-ui-test.mjs [http://127.0.0.1:8787]
   ============================================================================= */

import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
const WS = BASE.replace(/^http/, 'ws') + '/ws';
const PAGE = BASE + '/viber-brawl-multiplayer.html';
const CHROME = process.env.VB_CHROME ||
  'C:/Users/ellae/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const ART = path.join(ROOT, 'test', 'artifacts');
fs.mkdirSync(ART, { recursive: true });

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '   ' + extra : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
const stamp = Date.now().toString(36);

console.log('\nViber Brawl — profile screen test');
console.log('page: ' + PAGE + '\n');

/* ---------------------------------------------------- set up a real account -- */
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

console.log('[1] setting up a real account with a real played match');
const api = new Api();
const playerName = ('Prof' + stamp.slice(-3)).slice(0, 14);
await api.req('/api/auth/guest', { method: 'POST', body: { name: playerName } });

const host = new RoomClient('host');
await host.connect(WS + '?create=1&id=' + encodeURIComponent(api.token));
host.send({ t: 'hello', name: playerName });
const welcome = await host.waitForWhere('welcome', () => true);
const other = new RoomClient('other');
await other.connect(WS + '?room=' + welcome.roomCode);
other.send({ t: 'hello', name: 'Opponent' });
await sleep(300);
host.send({ t: 'select', charId: 'phantom' });
other.send({ t: 'select', charId: 'moss' });
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
other.close();
await host.waitForWhere('matchend', () => true, 9000);
await sleep(2500);
host.close();
await sleep(300);

const email = 'prof' + stamp + '@example.com';
const reg = await api.req('/api/auth/register', {
  method: 'POST', body: { email, password: 'a-good-long-passphrase', displayName: playerName }
});
check('account created with one match of history', reg.status === 200 && reg.data.claimedMatches >= 1,
  JSON.stringify(reg.data));
const session = api.token;
check('we have a session token to hand to the browser', !!session && session.startsWith('s.'));

/* --------------------------------------------------------------- browser -- */
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-proxy-server', '--enable-unsafe-swiftshader', '--use-gl=angle',
         '--use-angle=swiftshader', '--no-sandbox', '--mute-audio']
});
const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
await ctx.addCookies([{ name: 'vb_id', value: session, url: BASE, httpOnly: true, sameSite: 'Lax' }]);
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });

console.log('\n[2] the menu offers a PROFILE entry');
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!document.getElementById('btnProfile'), null, { timeout: 20000 });
const order = await page.evaluate(() =>
  [...document.querySelectorAll('#scrMenu .btn')].map(b => b.textContent.trim()));
check('menu order is PLAY / MULTIPLAYER / ACCOUNT / PROFILE / HOW TO PLAY / VIBER SELECT',
  JSON.stringify(order) === JSON.stringify(['PLAY', 'MULTIPLAYER', 'ACCOUNT', 'PROFILE', 'HOW TO PLAY', 'VIBER SELECT']),
  order.join(' | '));

const modReady = await page.waitForFunction(
  () => window.__VB_PROFILE && window.__VB_PROFILE.ready === true, null, { timeout: 20000 })
  .then(() => true).catch(() => false);
check('the profile module loaded and fetched data', modReady);

console.log('\n[3] the profile shows the real record');
await page.click('#btnProfile');
await page.waitForSelector('#scrProfile.on', { timeout: 10000 });
await page.waitForFunction(() => {
  const el = document.getElementById('profileState');
  return el && el.querySelector('.pf-level-num');
}, null, { timeout: 15000 }).catch(() => {});

const view = await page.evaluate(() => {
  const host = document.getElementById('profileState');
  const txt = host ? host.textContent : '';
  const stats = {};
  host.querySelectorAll('.pf-stat').forEach(s => {
    stats[s.querySelector('.pf-stat-l').textContent] = s.querySelector('.pf-stat-v').textContent;
  });
  return {
    level: (host.querySelector('.pf-level-num') || {}).textContent,
    xpText: (host.querySelector('.pf-xptext') || {}).textContent,
    next: (host.querySelector('.pf-next') || {}).textContent,
    barWidth: (host.querySelector('.pf-xpbar i') || {}).style ? host.querySelector('.pf-xpbar i').style.width : null,
    tabs: [...host.querySelectorAll('[data-pftab]')].map(b => b.textContent.trim()),
    stats,
    hasGuestPrompt: !!host.querySelector('.pf-empty-h')
  };
});
check('a level is shown', !!view.level && Number(view.level) >= 1, view.level);
check('the XP bar has a real width', !!view.barWidth && view.barWidth !== '0%', view.barWidth);
check('the XP text shows progress toward the next level',
  /XP to level \d/.test(view.xpText || ''), (view.xpText || '').slice(0, 60));
check('the next reward is named', /level \d/i.test(view.next || ''), view.next);
check('there are three tabs', view.tabs.length === 3, view.tabs.join(' | '));
check('career stats are rendered', Object.keys(view.stats).length >= 10, Object.keys(view.stats).length);
check('the match count is real', Number(view.stats['Matches']) >= 1, view.stats['Matches']);
check('the win was recorded', Number(view.stats['Wins']) >= 1, view.stats['Wins']);
check('win rate is a percentage', /%$/.test(view.stats['Win rate'] || ''), view.stats['Win rate']);
check('knockouts are shown', view.stats['Knockouts'] !== undefined, view.stats['Knockouts']);
check('time played is shown', /[sm]/.test(view.stats['Time played'] || ''), view.stats['Time played']);
check('no guest prompt is shown for a signed-in player', view.hasGuestPrompt === false);
await page.screenshot({ path: path.join(ART, 'profile-career.png') });

console.log('\n[4] the tabs work');
await page.click('[data-pftab="vibers"]');
await sleep(250);
const vib = await page.evaluate(() => {
  const host = document.getElementById('profileState');
  return {
    rows: host.querySelectorAll('.pf-viber').length,
    text: (host.querySelector('.pf-viber') || {}).textContent || ''
  };
});
check('the per-Viber tab lists the Viber that was played', vib.rows >= 1, vib.rows);
check('it names the Viber and shows a mastery level', /MASTERY \d/.test(vib.text), vib.text.slice(0, 70));

await page.click('[data-pftab="history"]');
await sleep(250);
const hist = await page.evaluate(() => {
  const host = document.getElementById('profileState');
  const rows = [...host.querySelectorAll('.pf-match')];
  return {
    count: rows.length,
    first: rows[0] ? rows[0].textContent : '',
    winner: rows[0] ? rows[0].className.indexOf('win') !== -1 : false
  };
});
check('the match history lists the match that was played', hist.count >= 1, hist.count);
check('the winning match is highlighted as a win', hist.winner === true, hist.first.slice(0, 80));
check('the row shows placement, Viber, KOs and damage',
  /(1ST|2ND|3RD|4TH)/.test(hist.first) && /KO/.test(hist.first) && /dmg/.test(hist.first),
  hist.first.slice(0, 80));
check('the row shows when it was played', /ago|just now/.test(hist.first), hist.first.slice(-24));
await page.screenshot({ path: path.join(ART, 'profile-history.png') });

console.log('\n[5] a brand-new player sees a clear empty state, not a broken screen');
{
  /* A second context means a second software-rendered WebGL game competing for
     CPU, so this needs a generous navigation timeout and a small viewport. */
  const freshCtx = await browser.newContext({ viewport: { width: 900, height: 700 } });
  const fresh = await freshCtx.newPage();
  fresh.on('pageerror', e => errors.push('fresh pageerror: ' + e.message));
  await fresh.goto(PAGE, { waitUntil: 'domcontentloaded', timeout: 90000 });
  const ready = await fresh.waitForFunction(
    () => window.__VB_PROFILE && window.__VB_PROFILE.ready === true, null, { timeout: 40000 })
    .then(() => true).catch(() => false);
  check('the profile module loaded for a signed-out visitor too', ready);
  await fresh.click('#btnProfile');
  await fresh.waitForSelector('#scrProfile.on', { timeout: 15000 });
  await sleep(800);
  const empty = await fresh.evaluate(() => {
    const host = document.getElementById('profileState');
    return { text: host.textContent || '', hasButton: !!host.querySelector('#pfSignIn') };
  });
  check('a signed-out player is told what to do rather than shown a blank page',
    /No profile yet|guest/i.test(empty.text), empty.text.slice(0, 90));
  check('and is offered a way to create an account', empty.hasButton === true);
  await freshCtx.close();
}

console.log('\n[6] the original game is still intact');
const solo = await page.evaluate(() => ({
  characters: typeof CHARACTERS !== 'undefined' ? CHARACTERS.length : -1,
  platforms: typeof platforms !== 'undefined' ? platforms.length : -1,
  hasFight: !!document.getElementById('btnFight')
}));
check('all 4 Vibers still defined', solo.characters === 4, solo.characters);
check('arena still has 7 platforms', solo.platforms === 7, solo.platforms);
check('the solo FIGHT button is still there', solo.hasFight);

console.log('\n[7] no uncaught errors');
const real = errors.filter(e => !/favicon|WebGL|swiftshader|AudioContext|Autoplay/i.test(e));
check('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' || '));

await browser.close();

console.log('\n' + '='.repeat(66));
console.log(failures === 0
  ? 'PROFILE SCREEN WORKS — level, stats, per-Viber breakdown and real match history'
  : failures + ' CHECK(S) FAILED');
console.log('='.repeat(66) + '\n');
process.exit(failures === 0 ? 0 : 1);
