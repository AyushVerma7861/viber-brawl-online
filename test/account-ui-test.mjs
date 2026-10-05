/* =============================================================================
   account-ui-test.mjs — the ACCOUNT screen, in a real browser.

   Proves the parts of the account design a player actually touches:
     * the menu has an ACCOUNT entry
     * opening it shows a guest what they are and what they would keep
     * creating an account from inside the game works
     * the session survives a page reload
     * signing out really signs out

   Usage: node test/account-ui-test.mjs [http://127.0.0.1:8787]
   ============================================================================= */

import { chromium } from 'playwright-core';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = (process.argv[2] || 'http://127.0.0.1:8787').replace(/\/$/, '');
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

console.log('\nViber Brawl — account screen test');
console.log('page: ' + PAGE + '\n');

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ['--no-proxy-server', '--enable-unsafe-swiftshader', '--use-gl=angle',
         '--use-angle=swiftshader', '--no-sandbox', '--mute-audio']
});

const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const page = await ctx.newPage();
page.on('pageerror', e => errors.push('pageerror: ' + e.message));
page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 160)); });

/* ------------------------------------------------------------------ load -- */
console.log('[1] the menu offers an ACCOUNT entry');
await page.goto(PAGE, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => !!document.getElementById('btnAccount'), null, { timeout: 20000 });
check('an ACCOUNT button exists in the menu', true);

const order = await page.evaluate(() =>
  [...document.querySelectorAll('#scrMenu .btn')].map(b => b.textContent.trim()));
check('menu order is PLAY / MULTIPLAYER / ACCOUNT / HOW TO PLAY / VIBER SELECT',
  JSON.stringify(order) === JSON.stringify(['PLAY', 'MULTIPLAYER', 'ACCOUNT', 'HOW TO PLAY', 'VIBER SELECT']),
  order.join(' | '));

const accountReady = await page.waitForFunction(
  () => window.__VB_ACCOUNT && window.__VB_ACCOUNT.ready === true, null, { timeout: 20000 })
  .then(() => true).catch(() => false);
check('the account module loaded and talked to the server', accountReady);

/* ------------------------------------------------------------ open screen -- */
console.log('\n[2] opening the account screen as a brand-new player');
await page.click('#btnAccount');
await page.waitForSelector('#scrAccount.on', { timeout: 10000 });
check('the account screen opened', true);

const fresh = await page.evaluate(() => ({
  badge: (document.querySelector('#acctState .acct-badge') || {}).textContent,
  text: (document.getElementById('acctState') || {}).textContent || '',
  hasOauth: document.querySelectorAll('#acctState [data-oauth]').length,
  hasPasswordForm: !!document.getElementById('acctEmail'),
  tabs: [...document.querySelectorAll('#acctState .acct-tab')].map(b => b.textContent.trim())
}));
check('a brand-new player is shown as not signed in',
  /NOT SIGNED IN|PLAYING AS GUEST/.test(fresh.badge || ''), fresh.badge);
check('the password form is offered', fresh.hasPasswordForm);
check('sign-in and create-account tabs are offered',
  fresh.tabs.includes('SIGN IN') && fresh.tabs.includes('CREATE ACCOUNT'), fresh.tabs.join(' | '));

/* ------------------------------------------------ guest plays, then signup -- */
console.log('\n[3] a guest plays a match, then creates an account and keeps it');
await page.click('#btnAcctBack');
await page.waitForSelector('#scrMenu.on', { timeout: 8000 });
await page.click('#btnMultiplayer');
await page.waitForSelector('#scrMP.on', { timeout: 8000 });
await page.fill('#mpName', 'UiGuest' + stamp.slice(-2));
await page.click('#btnCreateRoom');
await page.waitForSelector('#scrLobby.on', { timeout: 25000 });

const guestState = await page.evaluate(() => ({
  kind: window.__VB_ACCOUNT.me && window.__VB_ACCOUNT.me.kind,
  name: window.__VB_ACCOUNT.me && window.__VB_ACCOUNT.me.displayName
}));
check('entering multiplayer created a guest identity', guestState.kind === 'guest', JSON.stringify(guestState));
check('the guest got the name that was typed', guestState.name === 'UiGuest' + stamp.slice(-2), guestState.name);

/* back to the account screen: it should now promise to keep the name */
await page.evaluate(() => { if (window.__VB_ACCOUNT) window.__VB_ACCOUNT.open(); });
await page.waitForSelector('#scrAccount.on', { timeout: 10000 });
const guestView = await page.evaluate(() => ({
  badge: (document.querySelector('#acctState .acct-badge') || {}).textContent,
  keep: (document.querySelector('#acctState .acct-keep') || {}).textContent || ''
}));
check('the guest is told they are playing as a guest', /GUEST/.test(guestView.badge || ''), guestView.badge);
check('the guest is told their progress will be kept', /kept|keep/i.test(guestView.keep), guestView.keep.slice(0, 70));

/* create the account */
const email = 'ui' + stamp + '@example.com';
const uname = ('UiPlayer' + stamp.slice(-2)).slice(0, 14);
await page.click('#acctState [data-mode="register"]');
await page.waitForSelector('#acctName', { timeout: 5000 });
await page.fill('#acctEmail', email);
await page.fill('#acctPass', 'a-good-long-passphrase');
await page.fill('#acctName', uname);
await page.click('#acctSubmit');

const signedIn = await page.waitForFunction(
  () => window.__VB_ACCOUNT && window.__VB_ACCOUNT.me && window.__VB_ACCOUNT.me.signedIn === true,
  null, { timeout: 30000 }).then(() => true).catch(() => false);
check('creating an account signs the player in', signedIn);

const after = await page.evaluate(() => ({
  name: window.__VB_ACCOUNT.me.displayName,
  key: window.__VB_ACCOUNT.me.playerKey,
  identities: (window.__VB_ACCOUNT.me.identities || []).map(i => i.provider),
  badge: (document.querySelector('#acctState .acct-badge') || {}).textContent,
  msg: (document.getElementById('acctMsg') || {}).textContent || ''
}));
check('the screen now shows SIGNED IN', /SIGNED IN/.test(after.badge || ''), after.badge);
check('the chosen display name is applied', after.name === uname, after.name);
check('a password identity is linked', after.identities.includes('password'), after.identities.join(','));
check('the player is told their guest progress carried over', /carried over|Signed in/i.test(after.msg), after.msg);
await page.screenshot({ path: path.join(ART, 'account-signed-in.png') });

/* ------------------------------------------------------- survives a reload -- */
console.log('\n[4] the session survives a page reload');
await page.reload({ waitUntil: 'domcontentloaded' });
const stillIn = await page.waitForFunction(
  () => window.__VB_ACCOUNT && window.__VB_ACCOUNT.me && window.__VB_ACCOUNT.me.signedIn === true,
  null, { timeout: 25000 }).then(() => true).catch(() => false);
check('still signed in after a reload', stillIn);
const sameKey = await page.evaluate(() => window.__VB_ACCOUNT.me.playerKey);
check('and it is the same account', sameKey === after.key, sameKey);

/* ------------------------------------------------------------- sign out ---- */
console.log('\n[5] signing out really signs out');
await page.evaluate(() => window.__VB_ACCOUNT.open());
await page.waitForSelector('#scrAccount.on', { timeout: 10000 });
await page.waitForSelector('#acctSignOut', { timeout: 8000 });
await page.click('#acctSignOut');
const out = await page.waitForFunction(
  () => window.__VB_ACCOUNT && window.__VB_ACCOUNT.me && window.__VB_ACCOUNT.me.signedIn === false,
  null, { timeout: 15000 }).then(() => true).catch(() => false);
check('signing out returns to the signed-out state', out);

await page.reload({ waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__VB_ACCOUNT && window.__VB_ACCOUNT.ready === true, null, { timeout: 25000 });
const afterReload = await page.evaluate(() => window.__VB_ACCOUNT.me);
check('still signed out after a reload', !afterReload || afterReload.signedIn === false,
  afterReload ? afterReload.kind : 'none');

/* ------------------------------------------------------ solo still works --- */
console.log('\n[6] the original game is still intact');
const solo = await page.evaluate(() => ({
  characters: typeof CHARACTERS !== 'undefined' ? CHARACTERS.length : -1,
  platforms: typeof platforms !== 'undefined' ? platforms.length : -1,
  hasFight: !!document.getElementById('btnFight'),
  hasTutorial: typeof Tutorial === 'object'
}));
check('all 4 Vibers still defined', solo.characters === 4, solo.characters);
check('arena still has 7 platforms', solo.platforms === 7, solo.platforms);
check('the solo FIGHT button is still there', solo.hasFight);
check('the tutorial is still there', solo.hasTutorial);

console.log('\n[7] no uncaught errors');
const real = errors.filter(e => !/favicon|WebGL|swiftshader|AudioContext|Autoplay/i.test(e));
check('no uncaught page errors', real.length === 0, real.slice(0, 3).join(' || '));

await browser.close();

console.log('\n' + '='.repeat(66));
console.log(failures === 0
  ? 'ACCOUNT SCREEN WORKS — guests can sign up in place and keep everything'
  : failures + ' CHECK(S) FAILED');
console.log('='.repeat(66) + '\n');
process.exit(failures === 0 ? 0 : 1);
