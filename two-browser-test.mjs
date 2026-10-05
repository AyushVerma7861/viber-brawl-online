/* =============================================================================
   two-browser-test.mjs — THE acceptance test.

   Launches TWO fully isolated browser contexts (separate localStorage, separate
   sockets, separate WebGL canvases), has them create/join the same room through
   the real UI, start a match, and then verifies from inside each page that:

     * the real Viber Brawl arena is loaded (7 collision platforms)
     * each page built the REAL Viber models for both players
     * holding a movement key on page A changes the authoritative position, and
       page B's own copy of that Viber MOVES to match
     * both pages agree on the tick and the player count

   Screenshots from both pages are written to ./test/artifacts/.

   Usage: node test/two-browser-test.mjs [http://127.0.0.1:8787]
   ============================================================================= */

import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ART = path.join(HERE, 'artifacts');
fs.mkdirSync(ART, { recursive: true });

const BASE = process.argv[2] || 'http://127.0.0.1:8787';
const CHROME = process.env.VB_CHROME ||
  'C:/Users/ellae/AppData/Local/ms-playwright/chromium-1243/chrome-win64/chrome.exe';
const PAGE = BASE + '/viber-brawl-multiplayer.html?mp=' + encodeURIComponent(BASE);

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '   ' + extra : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------------------------------------------------------------- boot ---- */
console.log('\nViber Brawl — TWO BROWSER acceptance test');
console.log('page   : ' + PAGE);
console.log('chrome : ' + CHROME + '\n');

const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: [
    '--no-proxy-server',
    '--enable-unsafe-swiftshader',
    '--use-gl=angle',
    '--use-angle=swiftshader',
    '--disable-gpu-sandbox',
    '--no-sandbox',
    '--mute-audio'
  ]
});

const errors = [];
/* always surface collected page errors, even if a step throws */
process.on('uncaughtException', (e) => {
  console.error('\n!! test aborted: ' + (e && e.message));
  if (errors.length) console.error('page errors:\n  ' + errors.slice(0, 8).join('\n  '));
  process.exit(1);
});
process.on('unhandledRejection', (e) => {
  console.error('\n!! unhandled rejection: ' + (e && (e.message || e)));
  if (errors.length) console.error('page errors:\n  ' + errors.slice(0, 8).join('\n  '));
  process.exit(1);
});
async function makeClient(label) {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push(label + ' pageerror: ' + e.message));
  page.on('console', m => {
    if (m.type() === 'error') errors.push(label + ' console.error: ' + m.text());
  });
  return { label, ctx, page };
}

const A = await makeClient('A');
const B = await makeClient('B');

/* ===========================================================================
   [0] THE SAME-BROWSER CASE — the one a real person actually does.

   Opening two windows of the SAME browser profile means they share
   localStorage. If the reconnect token lives there, the second window claims to
   be the first player and silently takes over their seat, so the room shows one
   player instead of two. This was a real reported bug; the check below is what
   stops it coming back.
   =========================================================================== */
console.log('[0] two windows in the SAME browser profile become TWO players');
{
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const w1 = await ctx.newPage();
  const w2 = await ctx.newPage();
  w1.on('pageerror', e => errors.push('W1 pageerror: ' + e.message));
  w2.on('pageerror', e => errors.push('W2 pageerror: ' + e.message));

  await w1.goto(PAGE, { waitUntil: 'domcontentloaded' });
  await w1.waitForFunction(() => window.__VB_MP && window.__VB_MP.simReady, null, { timeout: 20000 });
  await w1.click('#btnMultiplayer');
  await w1.fill('#mpName', 'SAME1');
  await w1.click('#btnCreateRoom');
  await w1.waitForSelector('#scrLobby.on', { timeout: 20000 });
  const sameCode = (await w1.textContent('#mpRoomCode')).trim();
  check('window 1 created a room', /^[A-Z0-9]{5}$/.test(sameCode), sameCode);

  /* the SAME context — therefore the same localStorage, like two windows of one browser */
  await w2.goto(PAGE + '&room=' + sameCode, { waitUntil: 'domcontentloaded' });
  await w2.waitForFunction(() => window.__VB_MP && window.__VB_MP.simReady, null, { timeout: 20000 });
  const joined = await w2.waitForSelector('#scrLobby.on', { timeout: 20000 }).then(() => true).catch(() => false);
  if (!joined) {
    const why = await w2.evaluate(() => ({
      status: window.__VB_MP && window.__VB_MP.status,
      net: (document.getElementById('mpNet') || {}).textContent,
      msg: (document.getElementById('mpMsg') || {}).textContent,
      pending: window.__VB_MP && !!window.__VB_MP.pendingConnect,
      screen: [...document.querySelectorAll('.screen.on')].map(e => e.id)
    })).catch(() => 'evaluate failed');
    console.log('        window 2 state:', JSON.stringify(why));
  }
  check('window 2 reached the lobby by itself', joined);

  await w1.waitForFunction(() => window.__VB_MP.players.filter(p => p.connected).length === 2,
    null, { timeout: 10000 }).catch(() => {});

  const st = await w1.evaluate(() => ({
    players: window.__VB_MP.players.filter(p => p.connected).length,
    ids: window.__VB_MP.players.map(p => p.id),
    names: window.__VB_MP.players.map(p => p.name)
  }));
  check('window 1 sees TWO players, not one', st.players === 2, st.players + ' -> ' + st.names.join(', '));
  check('the two windows have DIFFERENT identities',
    st.ids.length === 2 && st.ids[0] !== st.ids[1], st.ids.join(' vs '));
  /* the two windows share the saved name, so the server must disambiguate them
     or the lobby reads as the same player listed twice */
  check('the two windows are distinguishable by name',
    st.names.length === 2 && st.names[0] !== st.names[1], st.names.join(' | '));

  const w2id = await w2.evaluate(() => window.__VB_MP.playerId);
  const w1id = await w1.evaluate(() => window.__VB_MP.playerId);
  check('window 2 did not steal window 1\'s identity', w1id !== w2id, w1id + ' / ' + w2id);

  const w2Lobby = await w2.evaluate(() => window.__VB_MP.players.filter(p => p.connected).length);
  check('window 2 also sees two players', w2Lobby === 2, w2Lobby);

  /* picking a Viber in window 2 must not change window 1's pick */
  await w2.click('#mpCharGrid .mp-card:nth-child(3)');   /* volt */
  await sleep(500);
  const picks = await w1.evaluate(() =>
    window.__VB_MP.players.map(p => p.name + '=' + p.charId).sort());
  check('both windows can hold a DIFFERENT Viber at once',
    new Set(picks.map(x => x.split('=')[1])).size === 2, picks.join(', '));

  await ctx.close();
}

/* ---- load + menu button ---- */
console.log('[1] both pages load the game and expose a MULTIPLAYER entry');
await A.page.goto(PAGE, { waitUntil: 'domcontentloaded' });
await B.page.goto(PAGE, { waitUntil: 'domcontentloaded' });

await A.page.waitForFunction(() => !!document.getElementById('btnMultiplayer'), null, { timeout: 20000 });
await B.page.waitForFunction(() => !!document.getElementById('btnMultiplayer'), null, { timeout: 20000 });
check('A shows MULTIPLAYER in the main menu', true);
check('B shows MULTIPLAYER in the main menu', true);

const menuOrder = await A.page.evaluate(() =>
  [...document.querySelectorAll('#scrMenu .btn')].map(b => b.textContent.trim()));
check('menu order is PLAY / MULTIPLAYER / ACCOUNT / HOW TO PLAY / VIBER SELECT',
  JSON.stringify(menuOrder) === JSON.stringify(['PLAY', 'MULTIPLAYER', 'ACCOUNT', 'HOW TO PLAY', 'VIBER SELECT']),
  menuOrder.join(' | '));

/* NOTE: the original game declares its systems with top-level `const`/`let`/
   `class`, which live in the global LEXICAL scope — they are reachable by bare
   name from page.evaluate(), but they are NOT properties of `window`.
   So they must be referenced bare, guarded with typeof. */
const soloIntact = await A.page.evaluate(() => ({
  hasAIControl: typeof aiControl === 'function',
  hasStepFighter: typeof stepFighter === 'function',
  hasTutorial: typeof Tutorial === 'object',
  hasOnboard: typeof Onboard === 'object',
  hasBuildCharGrid: typeof buildCharGrid === 'function',
  characters: typeof CHARACTERS !== 'undefined' ? CHARACTERS.length : null,
  platforms: typeof platforms !== 'undefined' ? platforms.length : null,
  buildViber: typeof buildViber === 'function',
  hazards: typeof hazards !== 'undefined' && !!hazards.spinBar,
  powerTypes: typeof POWER_TYPES !== 'undefined' ? POWER_TYPES.length : null,
  soloMenuButton: !!document.getElementById('btnFight'),
  tutorialButton: !!document.getElementById('btnTutorial')
}));
check('solo AI control still present', soloIntact.hasAIControl);
check('solo stepFighter still present', soloIntact.hasStepFighter);
check('tutorial still present', soloIntact.hasTutorial && soloIntact.tutorialButton);
check('onboarding still present', soloIntact.hasOnboard);
check('Viber select screen still present', soloIntact.hasBuildCharGrid);
check('all 4 Vibers still defined', soloIntact.characters === 4, soloIntact.characters);
check('arena still has 7 collision platforms', soloIntact.platforms === 7, soloIntact.platforms);
check('hazards still built', soloIntact.hazards);
check('all 4 power-up types still defined', soloIntact.powerTypes === 4, soloIntact.powerTypes);
check('SOLO "FIGHT" button still wired', soloIntact.soloMenuButton);
check('buildViber (real models) still present', soloIntact.buildViber);

const simLoaded = await A.page.waitForFunction(() => window.__VB_MP && window.__VB_MP.simReady, null, { timeout: 20000 });
check('A loaded the SHARED gameplay core', !!simLoaded);
await B.page.waitForFunction(() => window.__VB_MP && window.__VB_MP.simReady, null, { timeout: 20000 });
check('B loaded the SHARED gameplay core', true);

/* ------------------------------------------------------------- 2. lobby --- */
console.log('\n[2] A creates a room through the real UI');
await A.page.click('#btnMultiplayer');
await A.page.fill('#mpName', 'ALPHA');
await A.page.click('#btnCreateRoom');
await A.page.waitForSelector('#scrLobby.on', { timeout: 20000 });
const CODE = (await A.page.textContent('#mpRoomCode')).trim();
check('A is in a lobby with a room code', /^[A-Z0-9]{5}$/.test(CODE), CODE);
check('A\'s socket reports connected', (await A.page.textContent('#mpNet')).toLowerCase().includes('connected'));

console.log('\n[3] B joins that room by code');
await B.page.goto(PAGE + '&room=' + CODE, { waitUntil: 'domcontentloaded' });
await B.page.waitForSelector('#scrLobby.on', { timeout: 20000 });
const bCode = (await B.page.textContent('#mpRoomCode')).trim();
check('B landed in the SAME room', bCode === CODE, bCode);

await A.page.waitForFunction(() =>
  window.__VB_MP.players.filter(p => p.connected).length === 2, null, { timeout: 10000 });
const aPlayers = await A.page.evaluate(() => window.__VB_MP.players.map(p => p.name));
check('A\'s lobby lists both players', aPlayers.length === 2, aPlayers.join(', '));

/* ------------------------------------------------- 4. character select --- */
console.log('\n[4] both pick a Viber — selection syncs to the other window');
await A.page.click('#mpCharGrid .mp-card:nth-child(1)');   /* miner  */
await B.page.click('#mpCharGrid .mp-card:nth-child(3)');   /* volt   */
await sleep(500);
const aChars = await A.page.evaluate(() => window.__VB_MP.players.map(p => p.charId).sort());
check('A sees miner + volt chosen', JSON.stringify(aChars) === JSON.stringify(['miner', 'volt']), aChars.join(','));
const bChars = await B.page.evaluate(() => window.__VB_MP.players.map(p => p.charId).sort());
check('B sees the same choices', JSON.stringify(bChars) === JSON.stringify(['miner', 'volt']), bChars.join(','));
const takenCards = await B.page.evaluate(() =>
  [...document.querySelectorAll('#mpCharGrid .mp-card')].map(c => c.className.includes('taken')));
check('B sees A\'s Viber greyed out as taken', takenCards[0] === true, JSON.stringify(takenCards));

/* ------------------------------------------------------ 5. ready/start --- */
console.log('\n[5] ready up, then start the match');
await A.page.click('#btnReady');
await B.page.click('#btnReady');
await A.page.waitForFunction(() => window.__VB_MP.canStart === true, null, { timeout: 10000 });
check('server reports the match can start', true);
await A.page.click('#btnStartMatch');

await A.page.waitForFunction(() => window.__VB_MP.inMatch === true, null, { timeout: 15000 });
await B.page.waitForFunction(() => window.__VB_MP.inMatch === true, null, { timeout: 15000 });
check('A entered the match', true);
check('B entered the match', true);

/* -------------------------------------------------- 6. real arena/models -- */
console.log('\n[6] both pages built the REAL Vibers inside the REAL arena');
await A.page.waitForFunction(() => window.__VB_MP.snap && window.__VB_MP.snap.phase === 'playing', null, { timeout: 20000 });
await B.page.waitForFunction(() => window.__VB_MP.snap && window.__VB_MP.snap.phase === 'playing', null, { timeout: 20000 });
check('match reached the playing phase on A', true);
check('match reached the playing phase on B', true);

const sceneA = await A.page.evaluate(() => {
  const MP = window.__VB_MP;
  return {
    arena: { platforms: typeof platforms !== 'undefined' ? platforms.length : -1, children: scene.children.length },
    fighters: Object.keys(MP.playerFighter).map(id => {
      const f = MP.playerFighter[id];
      let meshes = 0;
      f.group.traverse(o => { if (o.isMesh) meshes++; });
      return { id, char: f.def.id, name: f.def.name, meshes, visible: f.group.visible, isMe: f.isPlayer };
    }),
    hudOn: document.getElementById('hud').className.includes('on'),
    cards: document.querySelectorAll('#cards .pcard').length,
    inScene: Object.keys(MP.playerFighter).filter(id => {
      let n = MP.playerFighter[id].group; let found = false;
      while (n) { if (n === scene) { found = true; break; } n = n.parent; }
      return found;
    }).length
  };
});
check('A\'s arena is the real one (7 platforms)', sceneA.arena.platforms === 7, sceneA.arena.platforms);
check('A built one Viber per player', sceneA.fighters.length === 2, sceneA.fighters.length);
check('both Vibers are attached to the live Three.js scene', sceneA.inScene === 2, sceneA.inScene);
check('the Vibers are full models, not placeholders',
  sceneA.fighters.every(f => f.meshes >= 10), sceneA.fighters.map(f => f.char + ':' + f.meshes + 'meshes').join(' '));
check('exactly one Viber is flagged as the local player',
  sceneA.fighters.filter(f => f.isMe).length === 1);
check('the in-match HUD is showing', sceneA.hudOn);
check('HUD shows one card per player', sceneA.cards === 2, sceneA.cards);

/* ---------------------------------------------- 7. REAL movement sync ---- */
console.log('\n[7] THE TEST: A moves, and B watches A\'s Viber move');
const readPositions = () => {
  const MP = window.__VB_MP;
  const out = {};
  for (const id of Object.keys(MP.playerFighter)) {
    const f = MP.playerFighter[id];
    out[id] = {
      char: f.def.id,
      x: +f.group.position.x.toFixed(2),
      y: +f.group.position.y.toFixed(2),
      z: +f.group.position.z.toFixed(2),
      visible: f.group.visible,
      state: f.state
    };
  }
  return { tick: MP.snap.tick, phase: MP.snap.phase, localId: MP.playerId, fighters: out };
};

const aId = await A.page.evaluate(() => window.__VB_MP.playerId);
const bId = await B.page.evaluate(() => window.__VB_MP.playerId);

const aBefore = await A.page.evaluate(readPositions);
const bBefore = await B.page.evaluate(readPositions);
check('B renders a Viber object for A', !!bBefore.fighters[aId], Object.keys(bBefore.fighters).join(','));

/* Drive the local fighter with real key presses, computed from the same camera
   basis the client uses. `mode` picks the target: the arena centre (safe) or the
   opponent. When `edgeGuard` is on, the direction is bent toward the middle near
   the boundary — the same trick the game's own AI uses, so the test does not
   walk itself off the platform and die. */
const held = { w: false, a: false, s: false, d: false };
async function pressToward(page, mode, edgeGuard) {
  const st = await page.evaluate((m) => {
    const MP = window.__VB_MP;
    const me = MP.playerId;
    const a = MP.mirrors[me];
    if (!a) return null;
    const otherId = Object.keys(MP.mirrors).find(id => id !== me);
    const b = otherId ? MP.mirrors[otherId] : null;
    return {
      camYaw: Game.camYaw, ax: a.x, az: a.z, state: a.state,
      bx: b ? b.x : 0, bz: b ? b.z : 0
    };
  }, mode);
  if (!st) return null;

  let tx = 0, tz = 0;
  if (mode === 'opponent') { tx = st.bx; tz = st.bz; }
  let dx = tx - st.ax, dz = tz - st.az;
  let d = Math.hypot(dx, dz) || 1;
  let ux = dx / d, uz = dz / d;

  const EDGE = 16.2;
  const ed = Math.min(EDGE - Math.abs(st.ax), EDGE - Math.abs(st.az));
  if (edgeGuard && ed < 5.5) {
    const cx = -st.ax, cz = -st.az;
    const cl = Math.hypot(cx, cz) || 1;
    const w = Math.min(0.9, (5.5 - ed) / 5.5);
    ux = ux * (1 - w) + (cx / cl) * w;
    uz = uz * (1 - w) + (cz / cl) * w;
    const l = Math.hypot(ux, uz) || 1;
    ux /= l; uz /= l;
  }

  const cy = st.camYaw;
  const fx = -Math.sin(cy), fz = -Math.cos(cy);
  const rx = Math.cos(cy), rz = -Math.sin(cy);
  const mz = ux * fx + uz * fz;
  const mx = ux * rx + uz * rz;
  const want = { w: mz > 0.25, s: mz < -0.25, d: mx > 0.25, a: mx < -0.25 };
  for (const k of ['w', 'a', 's', 'd']) {
    if (want[k] && !held[k]) { await page.keyboard.down(k); held[k] = true; }
    else if (!want[k] && held[k]) { await page.keyboard.up(k); held[k] = false; }
  }
  return { dist: Math.hypot(st.bx - st.ax, st.bz - st.az), state: st.state };
}
async function releaseAll(page) {
  for (const k of ['w', 'a', 's', 'd']) if (held[k]) { await page.keyboard.up(k); held[k] = false; }
}

/* walk toward the arena centre, which cannot fall off */
await A.page.bringToFront();
for (let i = 0; i < 18; i++) { await pressToward(A.page, 'centre', true); await sleep(80); }
await releaseAll(A.page);
await sleep(600);           /* let the last snapshots arrive + interpolate */

const aAfter = await A.page.evaluate(readPositions);
const bAfter = await B.page.evaluate(readPositions);

const aMoved = Math.hypot(aAfter.fighters[aId].x - aBefore.fighters[aId].x,
                          aAfter.fighters[aId].z - aBefore.fighters[aId].z);
const bSawMove = Math.hypot(bAfter.fighters[aId].x - bBefore.fighters[aId].x,
                            bAfter.fighters[aId].z - bBefore.fighters[aId].z);

check('A\'s own Viber moved', aMoved > 2, aMoved.toFixed(2) + ' units');
check('B SAW A\'s Viber move', bSawMove > 2, bSawMove.toFixed(2) + ' units');
check('both windows agree on A\'s position (within interpolation lag)',
  Math.hypot(aAfter.fighters[aId].x - bAfter.fighters[aId].x,
             aAfter.fighters[aId].z - bAfter.fighters[aId].z) < 2.6,
  'dx=' + (aAfter.fighters[aId].x - bAfter.fighters[aId].x).toFixed(2) +
  ' dz=' + (aAfter.fighters[aId].z - bAfter.fighters[aId].z).toFixed(2));
check('both windows agree on the server tick (same match, same stream)',
  Math.abs(aAfter.tick - bAfter.tick) < 90,
  aAfter.tick + ' vs ' + bAfter.tick);
/* and prove the stream is actually live rather than both frozen at one value */
const tickLater = await A.page.evaluate(() => window.__VB_MP.snap.tick);
await sleep(500);
const tickEvenLater = await A.page.evaluate(() => window.__VB_MP.snap.tick);
check('A\'s snapshot stream is live (tick is advancing)', tickEvenLater > tickLater,
  tickLater + ' -> ' + tickEvenLater);
check('A\'s Viber is visible in B\'s scene', bAfter.fighters[aId].visible === true);
check('B\'s own Viber is visible in B\'s scene', bAfter.fighters[bId].visible === true);
check('A still renders B\'s Viber (B is idle but present)', !!aAfter.fighters[bId]);
check('A survived the movement test (still standing)', aAfter.fighters[aId].state === 'active',
  aAfter.fighters[aId].state);

/* --------------------------------------- 7b. DOUBLE JUMP with a real keyboard -- */
console.log('\n[7b] double jump with the real keyboard, judged by the SERVER');
/* Read the authoritative snapshot, not the client's prediction — this has to
   prove what the SERVER did with the key press. */
const srvState = () => A.page.evaluate((id) => {
  const MP = window.__VB_MP;
  const arr = MP.snap && MP.snap.players.find(p => p[0] === id);
  if (!arr) return null;
  return { y: arr[3], vy: arr[6], state: arr[11], onGround: arr[12] === 1, jumpsLeft: arr[13] };
}, aId);

await releaseAll(A.page);
let jumpProven = false;
let doubled = false;

/* Press Space and then WAIT until the client has actually put the press on the
   wire, instead of guessing with a fixed sleep. A software-rendered WebGL page
   can take a while to run its next frame, and a fixed delay made this flaky. */
async function pressSpaceAndConfirm() {
  await A.page.evaluate(() => { window.__VB_MP.lastSentCtrl = null; });
  await A.page.keyboard.press('Space');
  return A.page.waitForFunction(
    () => window.__VB_MP.lastSentCtrl && window.__VB_MP.lastSentCtrl.jumpPressed === true,
    null, { timeout: 6000 }).then(() => true).catch(() => false);
}

for (let attempt = 1; attempt <= 6 && !jumpProven; attempt++) {
  /* stand still until grounded */
  let grounded = false;
  for (let i = 0; i < 90; i++) {
    const s = await srvState();
    if (s && s.onGround && s.state === 0 && Math.abs(s.vy) < 0.5) { grounded = true; break; }
    await sleep(90);
  }
  if (!grounded) continue;
  const before = await srvState();

  /* press Space ONCE */
  if (!(await pressSpaceAndConfirm())) continue;
  await sleep(170);
  const afterOne = await srvState();
  if (!afterOne) continue;

  /* Judge by the JUMP COUNTER, not by velocity. The arena's spike pads and
     spinning rod both launch a fighter upward without consuming a jump, so a
     rising vy is not proof that Space did anything. */
  if (afterOne.jumpsLeft === 2) continue;          /* did not fire; retry */
  if (afterOne.jumpsLeft === 0) {
    /* THE REGRESSION: one press spent both jumps. */
    check('one Space press spends exactly ONE jump, not two', false, 'jumpsLeft=0 — press applied twice');
    jumpProven = true;
    break;
  }
  check('one Space press spends exactly ONE jump', afterOne.jumpsLeft === 1, 'jumpsLeft=' + afterOne.jumpsLeft);
  check('the air jump is still available after the first jump', true, 'jumpsLeft=1');

  /* press again as soon as the Viber is just past the TOP of the arc — pressing
     too late means it has already landed and the press is just a normal jump */
  let nearApex = false;
  for (let i = 0; i < 60; i++) {
    const s = await srvState();
    if (s && !s.onGround && s.vy < 0.5 && s.y > 1.5) { nearApex = true; break; }
    await sleep(25);
  }
  if (!nearApex) continue;
  const apex = await srvState();

  if (!(await pressSpaceAndConfirm())) continue;
  await sleep(150);
  const afterTwo = await srvState();
  if (afterTwo && afterTwo.jumpsLeft === 2) continue;   /* landed first; retry */

  const okTwo = !!(afterTwo && afterTwo.jumpsLeft === 0);
  if (!okTwo && afterTwo) {
    const diag = await A.page.evaluate((id) => {
      const MP = window.__VB_MP;
      const m = MP.mirrors[id];
      return {
        clientPredicted: m ? { jumpsLeft: m.jumpsLeft, vy: +m.vy.toFixed(2), onGround: m.onGround } : null,
        seq: MP.seq, lastSentSeq: MP.lastSentSeq,
        lastSentCtrl: MP.lastSentCtrl || null
      };
    }, aId);
    console.log('        after 2nd press: ' + JSON.stringify({ server: afterTwo, client: diag }));
  }
  check('a second Space press in mid-air spends the second jump',
    okTwo, afterTwo ? 'jumpsLeft=' + afterTwo.jumpsLeft : 'no snapshot');
  if (okTwo) { doubled = true; jumpProven = true; }
}

check('the double jump was demonstrated end to end', doubled, doubled ? '' : 'gave up after 6 attempts');
await A.page.screenshot({ path: path.join(ART, 'client-A-jump.png') });

/* ------------------------------------------------- 8. live combat sync --- */
console.log('\n[8] combat: A steers onto B and attacks; B sees the damage');
/* The arena is running its HARD hazard loadout (spinning rod + spike pads), so
   a fighter standing in the middle can be stunned or knocked out mid-approach —
   which is the game working correctly, not a fault. So: wait until A is actually
   able to act, close the gap, then attack in a tight burst while standing still
   (facing is already pointing at the opponent from the walk-in). Retry a few
   times if a hazard interrupts. */
const bHpBefore = await B.page.evaluate(id => window.__VB_MP.mirrors[id].health, bId);
const bLivesBefore = await B.page.evaluate(id => window.__VB_MP.mirrors[id].lives, bId);

let serverAttacks = 0;
const attackWatcher = setInterval(async () => {
  try {
    const at = await A.page.evaluate(([id]) => {
      const MP = window.__VB_MP;
      const arr = MP.snap && MP.snap.players.find(p => p[0] === id);
      return arr ? arr[14] : 0;              /* attackType code */
    }, [aId]);
    if (at) serverAttacks++;
  } catch (e) {}
}, 90);

const ableToAct = (page, id) => page.evaluate((pid) => {
  const m = window.__VB_MP.mirrors[pid];
  return !!m && m.state === 'active' && m.hitstun <= 0;
}, id).catch(() => false);

let closest = 1e9;
let landed = false;
let attempts = 0;

for (attempts = 1; attempts <= 4 && !landed; attempts++) {
  /* wait for A to be standing and not stunned (up to 15s) */
  for (let w = 0; w < 60; w++) { if (await ableToAct(A.page, aId)) break; await sleep(250); }

  /* close the gap */
  for (let i = 0; i < 45; i++) {
    const r = await pressToward(A.page, 'opponent', true);
    if (!r) break;
    closest = Math.min(closest, r.dist);
    if (r.dist < 2.2) break;
    await sleep(70);
  }

  /* attack burst, standing still so facing stays on the opponent */
  for (let k = 0; k < 8; k++) {
    if (!(await ableToAct(A.page, aId))) break;
    await A.page.keyboard.press(k === 4 ? 'k' : 'j');    /* quick, one heavy */
    await sleep(130);
  }
  await sleep(400);

  const hpNow = await B.page.evaluate(id => window.__VB_MP.mirrors[id].health, bId);
  const livesNow = await B.page.evaluate(id => window.__VB_MP.mirrors[id].lives, bId);
  landed = hpNow < bHpBefore || livesNow < bLivesBefore;
}
await releaseAll(A.page);
clearInterval(attackWatcher);

const bHpAfter = await B.page.evaluate(id => window.__VB_MP.mirrors[id].health, bId);
const bLivesAfter = await B.page.evaluate(id => window.__VB_MP.mirrors[id].lives, bId);
const aStats = await A.page.evaluate(id => {
  const m = window.__VB_MP.mirrors[id];
  return { dealt: m.dmgDealt, hp: m.health, state: m.state, lives: m.lives };
}, aId);
console.log('        closest approach ' + closest.toFixed(2) + 'u after ' + (attempts - 1) +
            ' attempt(s); server saw ' + serverAttacks + ' attack windows; A.dmgDealt=' +
            aStats.dealt.toFixed(1) + ' A.lives=' + aStats.lives);

check('A walked into melee range of B', closest < 3.4, 'closest ' + closest.toFixed(2) + ' units');
check('A\'s attacks reach the server', serverAttacks > 0, serverAttacks + ' sampled attack windows');
check('B\'s health is server-authoritative and dropped from A\'s attacks',
  bHpAfter < bHpBefore || bLivesAfter < bLivesBefore,
  'hp ' + bHpBefore + ' -> ' + bHpAfter + '  lives ' + bLivesBefore + ' -> ' + bLivesAfter);
check('A was credited with damage dealt', aStats.dealt > 0, aStats.dealt.toFixed(1));
await A.page.screenshot({ path: path.join(ART, 'client-A-fight.png') });

/* ------------------------------------------------------ 9. screenshots --- */
console.log('\n[9] capturing both windows');
await A.page.screenshot({ path: path.join(ART, 'client-A.png') });
await B.page.screenshot({ path: path.join(ART, 'client-B.png') });
check('screenshots written to test/artifacts/', fs.existsSync(path.join(ART, 'client-A.png')) &&
  fs.existsSync(path.join(ART, 'client-B.png')));

/* ------------------------------------------------ 10. disconnect policy -- */
console.log('\n[10] DISCONNECT POLICY live: closing B must not spawn a bot');

/* The duel above can legitimately end the match (stocks run out, or the clock).
   Restart it so the disconnect test always begins from a clean, live 2-player
   match and is measuring the disconnect rule — not the end of a fight.
   This drives the wire protocol directly rather than the UI, which is fine: the
   lobby UI is already covered by sections [2]-[5]. */
async function restartMatch() {
  const send = (c, obj) => c.page.evaluate((o) => {
    const MP = window.__VB_MP;
    const ov = document.getElementById('photoOverlay');
    if (ov) ov.classList.remove('on');
    MP.showingResults = false;
    if (MP.ws && MP.ws.readyState === 1) MP.ws.send(JSON.stringify(o));
  }, obj);

  for (const c of [A, B]) await send(c, { t: 'rematch' });
  await sleep(900);
  for (const c of [A, B]) await send(c, { t: 'ready', ready: true });
  await sleep(700);
  await A.page.evaluate(() => {
    const MP = window.__VB_MP;
    if (MP.ws && MP.ws.readyState === 1) MP.ws.send(JSON.stringify({ t: 'start' }));
  });
  const ok = await A.page.waitForFunction(
    () => window.__VB_MP.snap && window.__VB_MP.snap.phase === 'playing' &&
          window.__VB_MP.snap.players.length === 2,
    null, { timeout: 20000 }).then(() => true).catch(() => false);
  if (ok) await B.page.waitForFunction(
    () => window.__VB_MP.snap && window.__VB_MP.snap.phase === 'playing',
    null, { timeout: 8000 }).catch(() => {});
  return ok;
}

const restarted = await restartMatch();
check('a fresh 2-player match was running before the drop', restarted);
await sleep(400);

await B.ctx.close();

/* Wait for the server's removal to actually reach A rather than guessing a
   delay — on a loaded machine a fixed sleep reads a stale snapshot and reports a
   false failure. */
const sawRemoval = await A.page.waitForFunction(
  () => window.__VB_MP.snap && window.__VB_MP.snap.players.length === 1,
  null, { timeout: 15000 }).then(() => true).catch(() => false);
check('the removal reached A within 15s', sawRemoval);
await A.page.waitForFunction(
  () => window.__VB_MP.snap && window.__VB_MP.snap.phase === 'over',
  null, { timeout: 10000 }).catch(() => {});
await sleep(300);

const afterB = await A.page.evaluate(() => {
  const MP = window.__VB_MP;
  return {
    snapPlayers: MP.snap ? MP.snap.players.length : -1,
    fighterIds: Object.keys(MP.playerFighter),
    fighterCount: typeof fighters !== 'undefined' ? fighters.length : -1,
    over: MP.snap ? MP.snap.phase === 'over' : false,
    winnerId: MP.winnerId,
    me: MP.playerId,
    showingResults: MP.showingResults,
    title: (document.getElementById('resTitle') || {}).textContent
  };
});
check('the arena now holds only A\'s fighter', afterB.snapPlayers === 1, afterB.snapPlayers);
check('no extra fighter object was created for the leaver', afterB.fighterIds.length === 2, afterB.fighterIds.length);
check('the server ended the match', afterB.over === true);
check('A was declared the winner', afterB.winnerId === afterB.me, afterB.winnerId);
await sleep(3600);
/* the winning local player gets the solo victory-photo beat first; click
   through it exactly as a human would */
const photoOn = await A.page.evaluate(() => document.getElementById('photoOverlay').classList.contains('on'));
if (photoOn) await A.page.click('#btnContinuePhoto');
await A.page.waitForSelector('#scrResults.on', { timeout: 8000 }).catch(() => {});
await sleep(400);

/* diagnostic: is the online results override actually the active one? */
const diag = await A.page.evaluate(() => {
  const MP = window.__VB_MP;
  let err = null;
  MP.showingResults = false;                 /* allow a clean re-run */
  try { MP.showResults(); } catch (e) { err = String((e && e.stack) || e); }
  return {
    overrideActive: String(window.showResults).indexOf('mpShowResults') !== -1,
    showingResults: MP.showingResults,
    matchEndReason: MP.matchEndReason,
    standingsCount: MP.standings ? MP.standings.length : -1,
    inMatch: MP.inMatch,
    spectating: MP.spectating,
    err
  };
});
if (diag.err) console.log('        (mpShowResults threw: ' + diag.err.split('\n')[0] + ')');
check('the online results override is installed', diag.overrideActive);
check('the client knows why the match ended', diag.matchEndReason === 'opponent-left', diag.matchEndReason);
check('mpShowResults runs without throwing', !diag.err, diag.err ? diag.err.split('\n')[0] : '');

await A.page.waitForSelector('#scrResults.on', { timeout: 5000 }).catch(() => {});
const results = await A.page.evaluate(() => ({
  screen: document.getElementById('scrResults').className,
  title: document.getElementById('resTitle').textContent,
  sub: document.getElementById('resSub').textContent,
  hasStandings: document.getElementById('resStats').innerHTML.includes('FINAL STANDINGS'),
  rematchLabel: document.getElementById('btnRematch').textContent,
  raw: document.getElementById('resStats').innerHTML.slice(0, 160)
}));
check('A got the results screen', results.screen.includes('on'), results.screen + ' | ' + results.raw);
check('A is told it won', results.title === 'VICTORY!', results.title);
check('results explain the walkover', /last Viber standing/i.test(results.sub), results.sub);
check('standings list is rendered', results.hasStandings);
check('the rematch button is relabelled for online play',
  results.rematchLabel === 'BACK TO ROOM', results.rematchLabel);
await A.page.screenshot({ path: path.join(ART, 'client-A-results.png') });

/* ------------------------------------------------- 10b. rematch -> lobby */
console.log('\n[10b] rematch returns everyone to the ROOM, not a new match');
const canRematch = await A.page.evaluate(() => {
  /* the solo victory-photo overlay can sit above the results screen — dismiss
     it first, exactly as a player would */
  const ov = document.getElementById('photoOverlay');
  if (ov && ov.classList.contains('on')) ov.classList.remove('on');
  const b = document.getElementById('btnRematch');
  return !!b && b.offsetParent !== null;
});
if (canRematch) {
  await A.page.click('#btnRematch', { force: true });
  await A.page.waitForSelector('#scrLobby.on', { timeout: 8000 }).catch(() => {});
  await sleep(600);
}
const backInLobby = await A.page.evaluate(() => ({
  lobbyOn: document.getElementById('scrLobby').classList.contains('on'),
  phase: window.__VB_MP.phase,
  inMatch: window.__VB_MP.inMatch,
  room: (document.getElementById('mpRoomCode').textContent || '').trim(),
  fightersRestored: typeof fighters !== 'undefined' ? fighters.length : -1
}));
check('the rematch button was reachable', canRematch);
check('rematch put A back in the lobby', backInLobby.lobbyOn, JSON.stringify(backInLobby));
check('the same room was kept', backInLobby.room === CODE, backInLobby.room);
check('the client is out of the finished match', backInLobby.inMatch === false);

/* ------------------------------------------------------------- errors ---- */
console.log('\n[11] no uncaught page errors');
const realErrors = errors.filter(e => !/AudioContext|Autoplay|Failed to load resource|favicon|WebGL|swiftshader/i.test(e));
check('no uncaught errors in either page', realErrors.length === 0, realErrors.slice(0, 4).join(' || '));

await browser.close();

console.log('\n' + '='.repeat(66));
console.log(failures === 0
  ? 'TWO BROWSER CLIENTS JOINED ONE ROOM AND SAW EACH OTHER MOVE AND FIGHT'
  : failures + ' CHECK(S) FAILED');
console.log('='.repeat(66) + '\n');
process.exit(failures === 0 ? 0 : 1);
