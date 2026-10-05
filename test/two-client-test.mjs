/* =============================================================================
   two-client-test.mjs — end-to-end verification of the multiplayer backend
   against a REAL running worker (`wrangler dev`), using two independent
   WebSocket clients.

   Proves, without a browser:
     * create room / join room / room-not-found
     * server-enforced Viber uniqueness
     * ready + start
     * the authoritative simulation actually moves players
     * client B sees client A's authoritative position changing (real sync)
     * a client cannot dictate damage / position / stocks
     * DISCONNECT POLICY: the dropped player is removed, nothing replaces them,
       the remaining human is declared the winner

   Usage:  node test/two-client-test.mjs [ws://127.0.0.1:8787/ws]
   ============================================================================= */

const BASE = process.argv[2] || 'ws://127.0.0.1:8787/ws';

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '   ' + extra : ''));
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/* --------------------------------------------------------------- harness -- */
class Client {
  constructor(label, name) {
    this.label = label;
    this.name = name || label;
    this.msgs = []; this.ws = null; this.id = null; this.token = null;
  }
  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      const to = setTimeout(() => reject(new Error(this.label + ': connect timeout')), 10000);
      this.ws.addEventListener('open', () => {
        clearTimeout(to);
        /* HELLO must be the first frame on the socket */
        this.send({ t: 'hello', name: this.name, token: this.token || undefined });
        resolve();
      });
      this.ws.addEventListener('error', (e) => { clearTimeout(to); reject(new Error(this.label + ': socket error')); });
      this.ws.addEventListener('message', (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.msgs.push(m);
        if (m.t === 'welcome') { this.id = m.you; this.token = m.token; this.roomCode = m.roomCode; }
      });
      this.ws.addEventListener('close', (ev) => { this.closed = { code: ev.code, reason: ev.reason }; });
    });
  }
  send(o) { this.ws.send(JSON.stringify(o)); }
  close() { try { this.ws.close(1000, 'test done'); } catch (e) {} }
  all(type) { return this.msgs.filter(m => m.t === type); }
  last(type) { const a = this.all(type); return a.length ? a[a.length - 1] : null; }
  clear() { this.msgs.length = 0; }
  async waitFor(type, ms = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = this.last(type);
      if (m) return m;
      await sleep(30);
    }
    return null;
  }
  /** Wait for a message of `type` that also satisfies `pred` (ignores ones already seen). */
  async waitForWhere(type, pred, ms = 6000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const m = this.all(type).filter(pred);
      if (m.length) return m[m.length - 1];
      await sleep(30);
    }
    return null;
  }
  async waitForCount(type, n, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      if (this.all(type).length >= n) return true;
      await sleep(30);
    }
    return false;
  }
}

/* =========================================================================== */
console.log('\nViber Brawl — two-client multiplayer test');
console.log('target: ' + BASE + '\n');

/* ------------------------------------------------------------- health ----- */
const httpBase = BASE.replace(/^ws/, 'http').replace(/\/ws.*$/, '');
let health = null;
try {
  const res = await fetch(httpBase + '/api/health');
  health = await res.json();
  check('worker is up (/api/health)', health && health.ok === true, JSON.stringify(health));
} catch (e) {
  console.log('  FAIL  worker not reachable at ' + httpBase + ' — start `npx wrangler dev` first');
  process.exit(1);
}

/* ----------------------------------------------------------- 1. create ---- */
console.log('\n[1] create a room');
const A = new Client('A', 'ALPHA');
await A.connect(BASE + '?create=1');
const welcomeA = await A.waitFor('welcome');
check('A received welcome', !!welcomeA);
check('A got a room code', !!(welcomeA && welcomeA.roomCode), welcomeA && welcomeA.roomCode);
const CODE = welcomeA.roomCode;
check('room code is 5 chars', typeof CODE === 'string' && CODE.length === 5, CODE);
check('A got a reconnect token', !!(welcomeA && welcomeA.token));
check('server advertised its tick rate', welcomeA.config && welcomeA.tickHz > 0, welcomeA.tickHz + 'Hz');

/* --------------------------------------------------- 2. room-not-found ---- */
console.log('\n[2] joining a room that does not exist must fail cleanly');
const Ghost = new Client('Ghost', 'GHOST');
let ghostErr = null;
try {
  await Ghost.connect(BASE + '?room=ZZZZZ');
  ghostErr = await Ghost.waitFor('error', 4000);
} catch (e) { /* a closed socket is also acceptable */ }
check('ghost room rejected', !!(ghostErr && ghostErr.code === 'room_not_found') || !!Ghost.closed,
  ghostErr ? ghostErr.code : ('closed ' + JSON.stringify(Ghost.closed)));
Ghost.close();

/* --------------------------------------------------------------- 3. join -- */
console.log('\n[3] a second client joins the same room');
const B = new Client('B', 'BRAVO');
await B.connect(BASE + '?room=' + CODE);
const welcomeB = await B.waitFor('welcome');
check('B received welcome', !!welcomeB);
check('B landed in the SAME room', welcomeB && welcomeB.roomCode === CODE, welcomeB && welcomeB.roomCode);
const lobby2 = await A.waitFor('lobby');
await sleep(200);
check('A sees 2 players in the lobby', A.last('lobby') && A.last('lobby').players.length === 2,
  A.last('lobby') && A.last('lobby').players.length);

/* ------------------------------------------------- 4. viber uniqueness ---- */
console.log('\n[4] Viber uniqueness is enforced by the server');
A.send({ t: 'select', charId: 'miner' });
await sleep(250);
B.send({ t: 'select', charId: 'miner' });
const takenErr = await B.waitFor('error', 3000);
check('B cannot steal A\'s Viber', !!(takenErr && takenErr.code === 'char_taken'), takenErr && takenErr.code);
B.clear();
B.send({ t: 'select', charId: 'volt' });
await sleep(300);
const lb4 = B.last('lobby');
const bChar = lb4 && lb4.players.find(p => p.id === B.id);
check('B picked a different Viber', bChar && bChar.charId === 'volt', bChar && bChar.charId);

/* ----------------------------------------------------- 5. ready + start -- */
console.log('\n[5] ready up and start the match');
A.clear(); B.clear();
A.send({ t: 'ready', ready: true });
B.send({ t: 'ready', ready: true });
await sleep(400);
check('server says the match can start', A.last('lobby') && A.last('lobby').canStart === true,
  A.last('lobby') && A.last('lobby').blockReason);
A.send({ t: 'start' });
const lobbyStarted = await A.waitForWhere('lobby', m => m.started === true, 5000);
check('match started broadcast reached A', !!(lobbyStarted && lobbyStarted.started));
check('roster names both humans', !!(lobbyStarted && lobbyStarted.roster && lobbyStarted.roster.length === 2),
  lobbyStarted && lobbyStarted.roster && lobbyStarted.roster.map(r => r.charId).join(','));

/* -------------------------------------------------------- 6. snapshots -- */
console.log('\n[6] the authoritative simulation broadcasts snapshots');
const gotSnaps = await A.waitForCount('snapshot', 20, 6000);
check('A receives a steady snapshot stream', gotSnaps, A.all('snapshot').length + ' snapshots');
const s0 = A.last('snapshot');
check('snapshot carries both fighters', s0 && s0.players.length === 2, s0 && s0.players.length);
check('snapshot carries a tick number', s0 && typeof s0.tick === 'number', s0 && s0.tick);
check('snapshot carries the match clock', s0 && typeof s0.matchTime === 'number', s0 && s0.matchTime);
check('countdown is running', s0 && s0.countdown > 0, s0 && s0.countdown);

/* ------------------------------------------- 7. input moves the fighter -- */
console.log('\n[7] input drives movement — and the OTHER client sees it');
/* wait out the countdown */
const t0 = Date.now();
while (Date.now() - t0 < 6000) {
  const s = A.last('snapshot');
  if (s && s.phase === 'playing') break;
  await sleep(50);
}
check('match reached the playing phase', A.last('snapshot').phase === 'playing', A.last('snapshot').phase);

/* A holds "right" for a while */
let seq = 0;
const startX = A.last('snapshot').players.find(p => p[0] === A.id)[2];
const startZ = A.last('snapshot').players.find(p => p[0] === A.id)[4];
for (let i = 0; i < 45; i++) {
  seq++;
  A.send({ t: 'input', seq, dirX: 1, dirZ: 0, jump: false, jumpPressed: false, quick: false, heavy: false, dash: false, ability: false });
  await sleep(33);
}
const sEnd = A.last('snapshot');
const aEnd = sEnd.players.find(p => p[0] === A.id);
check('A\'s authoritative position changed', Math.abs(aEnd[2] - startX) > 1.5 || Math.abs(aEnd[4] - startZ) > 1.5,
  `x ${startX.toFixed(2)} -> ${aEnd[2].toFixed(2)}`);

/* B is a passive observer — it sends no input, yet its snapshots show A moving */
const bSeesA = B.last('snapshot').players.find(p => p[0] === A.id);
check('B sees A\'s position too (real sync, not local-only)', bSeesA && Math.abs(bSeesA[2] - aEnd[2]) < 0.9,
  bSeesA ? `A.x on B = ${bSeesA[2].toFixed(2)} vs ${aEnd[2].toFixed(2)}` : 'missing');

/* ------------------------------------------------ 7b. DOUBLE JUMP over the wire -- */
console.log('\n[7b] double jump works over the network');
/* Snapshot field order: [0]=id [2]=x [3]=y [4]=z [5]=vx [6]=vy [7]=vz
   [11]=state [12]=onGround [13]=jumpsLeft */
const readA = () => {
  const s = A.last('snapshot');
  const arr = s.players.find(p => p[0] === A.id);
  return { x: arr[2], y: arr[3], z: arr[4], vy: arr[6], state: arr[11], onGround: arr[12] === 1, jumpsLeft: arr[13] };
};
const neutral = () => ({ dirX: 0, dirZ: 0, jump: false, jumpPressed: false, quick: false, heavy: false, dash: false, ability: false });
const pressJump = () => ({ dirX: 0, dirZ: 0, jump: true, jumpPressed: true, quick: false, heavy: false, dash: false, ability: false });

let jumpOk = false;
let burnedBug = false;
let lastDiag = '';

for (let attempt = 1; attempt <= 4 && !jumpOk; attempt++) {
  /* wait until A is standing still on the ground */
  let grounded = false;
  let seen = null;
  for (let i = 0; i < 80; i++) {
    const r = readA();
    seen = r;
    if (r.onGround && r.state === 0 && Math.abs(r.vy) < 0.5) { grounded = true; break; }
    seq++; A.send(Object.assign({ t: 'input', seq }, neutral()));
    await sleep(60);
  }
  if (!grounded) {
    lastDiag = 'never grounded: ' + JSON.stringify(seen);
    continue;
  }

  const before = readA();

  /* ONE press, then neutral frames — with the SAME cadence the real browser
     client uses: the press goes out immediately, and the next frame follows on
     the 30 Hz slot ~33 ms later. Sending the neutral frame sooner than that is
     unrealistic and would hide the real defect. */
  seq++; A.send(Object.assign({ t: 'input', seq }, pressJump()));
  await sleep(40);
  for (let i = 0; i < 3; i++) { seq++; A.send(Object.assign({ t: 'input', seq }, neutral())); await sleep(33); }

  await sleep(120);
  const rising = readA();
  if (!(rising.vy > 3 || rising.y > before.y + 0.15)) {
    lastDiag = 'jump did not fire: ' + JSON.stringify({ before, rising });
    continue;
  }

  check('one press produces a jump', true, `vy=${rising.vy.toFixed(2)}`);

  /* THE REGRESSION CHECK: the press must be consumed exactly once. Before the
     fix the server re-applied it on the next tick, spent the air jump instantly,
     and the player could never double jump. */
  if (rising.jumpsLeft === 0) {
    burnedBug = true;
    check('the air jump is NOT spent by the same press', false, 'jumpsLeft=0 — press was applied twice');
    break;
  }
  check('the air jump is NOT spent by the same press', rising.jumpsLeft === 1, 'jumpsLeft=' + rising.jumpsLeft);

  /* fall back down to the apex, like a player would, then press again */
  let falling = false;
  for (let i = 0; i < 40; i++) {
    const r = readA();
    if (r.vy < -1) { falling = true; break; }
    seq++; A.send(Object.assign({ t: 'input', seq }, neutral()));
    await sleep(33);
  }
  if (!falling) { lastDiag = 'never started falling'; continue; }

  const apex = readA();
  check('the air jump survives the whole rise and fall', apex.jumpsLeft === 1, 'jumpsLeft=' + apex.jumpsLeft);

  seq++; A.send(Object.assign({ t: 'input', seq }, pressJump()));
  for (let i = 0; i < 2; i++) { seq++; A.send(Object.assign({ t: 'input', seq }, neutral())); await sleep(33); }
  await sleep(90);

  const after = readA();
  check('the second press performs a DOUBLE JUMP (new upward impulse)',
    after.vy > 5 && after.vy > apex.vy + 3,
    `vy ${apex.vy.toFixed(2)} -> ${after.vy.toFixed(2)}`);
  check('the double jump is consumed exactly once', after.jumpsLeft === 0, 'jumpsLeft=' + after.jumpsLeft);
  jumpOk = true;
}

check('the double-jump sequence completed', jumpOk, jumpOk ? '' : lastDiag);

/* ----------------------------------------- 8. clients cannot cheat state -- */
console.log('\n[8] a client cannot dictate damage / position / stocks');
B.clear();
B.send({ t: 'input', seq: 999, dirX: 0, dirZ: 0, damage: 9999, health: 0, lives: 99, position: { x: 500, y: 500, z: 500 }, winner: true });
await sleep(500);
const bSnap = B.last('snapshot');
const bSelf = bSnap.players.find(p => p[0] === B.id);
check('injected damage ignored', bSelf[9] > 0, 'health=' + bSelf[9]);
check('injected stocks ignored', bSelf[10] === 3, 'lives=' + bSelf[10]);
check('injected position ignored', Math.abs(bSelf[2]) < 40 && Math.abs(bSelf[4]) < 40, `x=${bSelf[2]} z=${bSelf[4]}`);
check('injected winner ignored', bSnap.phase !== 'over', bSnap.phase);

/* ------------------------------- 9. DISCONNECT POLICY (the critical rule) -- */
console.log('\n[9] DISCONNECT POLICY: no AI substitute, clean removal, winner declared');
A.clear();
B.close();
await sleep(900);
const gone = A.last('playerGone');
check('A was told B left', !!gone && gone.id === B.id, gone && (gone.name + ' / ' + gone.reason));
const endMsg = await A.waitFor('matchend', 4000);
check('server ended the match for the last human', !!endMsg, endMsg && endMsg.reason);
check('the remaining human was declared the winner', endMsg && endMsg.winnerId === A.id,
  endMsg && ('winner=' + endMsg.winnerId + ' A=' + A.id));
const finalSnap = A.last('snapshot');
check('only ONE fighter remains in the arena', finalSnap && finalSnap.players.length === 1,
  finalSnap && finalSnap.players.length);
check('no AI/bot fighter was created', finalSnap && finalSnap.players.every(p => p[0] === A.id));
check('standings mark the leaver as disconnected',
  endMsg && endMsg.standings.some(s => s.id === B.id && s.disconnected === true));

/* --------------------------------------------- 10. room survives rejoin --- */
console.log('\n[10] the room keeps working after the host-equivalent leaves');
A.clear();
const C = new Client('C', 'CHARLIE');
await C.connect(BASE + '?room=' + CODE);
const welcomeC = await C.waitFor('welcome');
check('C can still join the room', !!welcomeC && welcomeC.roomCode === CODE, welcomeC && welcomeC.roomCode);
check('C got a fresh identity', welcomeC && welcomeC.you !== A.id);
await sleep(300);
const lb10 = C.last('lobby');
check('C sees A still present', lb10 && lb10.players.some(p => p.id === A.id), lb10 && lb10.players.length + ' players');

/* A leaves via the LEAVE message — the socket must close cleanly */
A.send({ t: 'leave' });
await sleep(700);
check('A\'s socket was closed after leave', !!A.closed, A.closed && JSON.stringify(A.closed));

C.close();
await sleep(200);

/* ---------------------------------------------------------------- done --- */
console.log('\n' + '='.repeat(64));
console.log(failures === 0 ? 'ALL MULTIPLAYER BACKEND TESTS PASSED' : failures + ' TEST(S) FAILED');
console.log('='.repeat(64) + '\n');
process.exit(failures === 0 ? 0 : 1);
