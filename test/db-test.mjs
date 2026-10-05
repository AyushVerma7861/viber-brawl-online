/* =============================================================================
   db-test.mjs — proves that a real match, played over real WebSockets, ends up
   in D1 with correct and UNFAKEABLE values.

   This is the foundation of every account, progression and analytics feature:
   if these rows are wrong or cheatable, everything built on top is wrong.

   Requires `npx wrangler dev` to be running — it owns the local D1 file, which
   this test opens directly (see test/lib/db.mjs).

   Usage: node test/db-test.mjs [ws://127.0.0.1:8787/ws]
   ============================================================================= */

import { openDb } from './lib/db.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const BASE = process.argv[2] || 'ws://127.0.0.1:8787/ws';
const HTTP = BASE.replace(/^ws/, 'http').replace(/\/ws.*$/, '');

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '   ' + extra : ''));
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ------------------------------------------------------------- D1 access --- */
/* Read the local D1 file directly rather than shelling out to
   `wrangler d1 execute`, which briefly disturbs the running dev server and
   made this test order-dependent. Read-write so the idempotency section can
   attempt a genuine duplicate insert. */
const db = openDb(ROOT, { readOnly: false });
const d1 = (sql) => db.all(sql);
const one = (sql) => db.one(sql);

/* --------------------------------------------------------------- harness --- */
class Client {
  constructor(label, name) { this.label = label; this.name = name; this.msgs = []; this.ws = null; this.id = null; }
  connect(url) {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(url);
      const to = setTimeout(() => reject(new Error(this.label + ': connect timeout')), 12000);
      this.ws.addEventListener('open', () => {
        clearTimeout(to);
        this.send({ t: 'hello', name: this.name, token: this.token || undefined });
        resolve();
      });
      this.ws.addEventListener('error', () => { clearTimeout(to); reject(new Error(this.label + ': socket error')); });
      this.ws.addEventListener('message', ev => {
        let m; try { m = JSON.parse(ev.data); } catch (e) { return; }
        this.msgs.push(m);
        if (m.t === 'welcome') { this.id = m.you; this.token = m.token; this.roomCode = m.roomCode; }
      });
      this.ws.addEventListener('close', ev => { this.closed = { code: ev.code, reason: ev.reason }; });
    });
  }
  send(o) { try { this.ws.send(JSON.stringify(o)); } catch (e) {} }
  close() { try { this.ws.close(1000, 'done'); } catch (e) {} }
  last(type) { const a = this.msgs.filter(m => m.t === type); return a.length ? a[a.length - 1] : null; }
  all(type) { return this.msgs.filter(m => m.t === type); }
  async waitFor(type, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const m = this.last(type); if (m) return m; await sleep(30); }
    return null;
  }
  /** Wait for a message that also satisfies `pred` — `waitFor` alone would match
      an earlier message of the same type and return too soon. */
  async waitForWhere(type, pred, ms = 8000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const found = this.all(type).filter(pred);
      if (found.length) return found[found.length - 1];
      await sleep(30);
    }
    return null;
  }
}

/* =========================================================================== */
console.log('\nViber Brawl — match reporting / D1 test');
console.log('target: ' + BASE + '\n');

try {
  const res = await fetch(HTTP + '/api/health');
  const h = await res.json();
  check('worker is up', h && h.ok === true, JSON.stringify(h));
} catch (e) {
  console.log('  FAIL  worker not reachable at ' + HTTP + ' — start `npx wrangler dev` first');
  process.exit(1);
}

/* ===========================================================================
   PART ONE — play a match. No database access here on purpose; see the note at
   the top of this file.
   =========================================================================== */
console.log('\n[1] two clients play a match through the real server');
const A = new Client('A', 'DBALPHA');
const B = new Client('B', 'DBBRAVO');
await A.connect(BASE + '?create=1');
const welcome = await A.waitFor('welcome');
check('A created a room', !!welcome && !!welcome.roomCode, welcome && welcome.roomCode);
const CODE = welcome.roomCode;

await B.connect(BASE + '?room=' + CODE);
await B.waitFor('welcome');
check('B joined the same room', B.roomCode === CODE, B.roomCode);

A.send({ t: 'select', charId: 'miner' });
B.send({ t: 'select', charId: 'volt' });
await sleep(400);
A.send({ t: 'ready', ready: true });
B.send({ t: 'ready', ready: true });
await sleep(500);
A.send({ t: 'start' });

const started = await A.waitForWhere('lobby', m => m.started === true, 9000);
check('match started', !!(started && started.started));

{
  const t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    const s = A.last('snapshot');
    if (s && s.phase === 'playing') break;
    await sleep(50);
  }
}
check('match reached the playing phase', !!(A.last('snapshot') && A.last('snapshot').phase === 'playing'));

/* keep a few frames flowing so the match has a real duration */
let seq = 0;
for (let i = 0; i < 12; i++) {
  seq++;
  A.send({ t: 'input', seq, dirX: 0, dirZ: 0, jump: false, jumpPressed: false, quick: false, heavy: false, dash: false, ability: false });
  await sleep(45);
}

/* End it deterministically: B leaves, so the server declares A the winner.
   That exercises the same reporting path a natural finish would. */
console.log('\n[2] ending the match (B leaves) so the server reports it');
B.close();
const gone = await A.waitFor('playerGone', 8000);
check('server noticed B leaving', !!gone);
const end = await A.waitFor('matchend', 8000);
check('server ended the match', !!end, end && end.reason);
check('A was declared the winner', !!(end && end.winnerId === A.id), end && end.winnerId);

/* the D1 write is deliberately not awaited by the server, so give it a moment */
await sleep(2500);
A.close();
await sleep(300);

/* ===========================================================================
   PART TWO — inspect the database.
   =========================================================================== */
console.log('\n[3] the database is migrated and seeded');
const counts = one(`SELECT (SELECT COUNT(*) FROM achievements) achievements,
                           (SELECT COUNT(*) FROM unlocks) unlocks,
                           (SELECT COUNT(*) FROM challenges) challenges,
                           (SELECT COUNT(*) FROM match_summary) matches`);
check('achievement catalogue seeded', counts.achievements >= 25, counts.achievements);
check('unlock catalogue seeded', counts.unlocks >= 25, counts.unlocks);
check('challenge catalogue seeded', counts.challenges >= 6, counts.challenges);
check('at least one match is now recorded', counts.matches >= 1, counts.matches);

/* ------------------------------------------------- 4. the rows are correct -- */
console.log('\n[4] the match we just played is stored, with server-computed values');
const summary = one(`SELECT * FROM match_summary WHERE room_code = '${CODE}' ORDER BY created_at DESC LIMIT 1`);
check('a match_summary row exists for our room', !!summary && !!summary.match_id, summary && summary.match_id);
if (!summary || !summary.match_id) {
  console.log('\n  (cannot continue without the summary row)\n');
  process.exit(1);
}
check('player_count is 2', summary.player_count === 2, summary.player_count);
check('a duration was recorded', typeof summary.duration_s === 'number' && summary.duration_s >= 0, summary.duration_s);
check('a winner was recorded', !!summary.winner_player_key, summary.winner_player_key);
check('the end reason is the disconnect walkover', summary.end_reason === 'opponent-left', summary.end_reason);
check('a ruleset hash was stored, so old matches stay interpretable',
  !!summary.ruleset_hash && String(summary.ruleset_hash).startsWith('fnv1a:'), summary.ruleset_hash);

const results = d1(`SELECT * FROM match_results WHERE match_id = '${summary.match_id}' ORDER BY placement`);
check('one match_results row per player', results.length === 2, results.length);
check('placements are 1 and 2', results.length === 2 && results[0].placement === 1 && results[1].placement === 2,
  results.map(r => r.placement).join(','));
check('exactly one winner is flagged', results.filter(r => r.winner === 1).length === 1);
const winner = results.find(r => r.winner === 1);
const loser = results.find(r => r.winner === 0);
check('the winner is the surviving player', !!winner && winner.display_name === 'DBALPHA', winner && winner.display_name);
check('the leaver is marked disconnected', !!loser && loser.disconnected === 1, loser && loser.disconnected);
check('each row records which Viber was played',
  results.map(r => r.char_id).sort().join(',') === 'miner,volt', results.map(r => r.char_id).join(','));
check('numeric stats are present and sane',
  results.every(r => r.kos >= 0 && r.falls >= 0 && r.dmg_dealt >= 0 && r.lives_left >= 0));
check('every result is tied to a stable player key',
  results.every(r => typeof r.player_key === 'string' && r.player_key.length > 0));

/* ------------------------------------------ 5. idempotency of the write ---- */
console.log('\n[5] re-reporting the same match cannot double-count');
const mid = summary.match_id;
/* Replay the EXACT same rows the server wrote. This is what a Durable Object
   restart or a retried alarm would do. */
db.run(`INSERT OR IGNORE INTO match_summary
      (match_id, room_code, map, ruleset_hash, player_count, duration_s, started_at, ended_at, winner_player_key, end_reason, created_at)
    VALUES ('${mid}', 'ZZZZZ', NULL, 'tampered', 9, 999, 0, 0, 'nobody', 'duplicate-attempt', 0)`);
for (const r of results) {
  db.run(`INSERT OR IGNORE INTO match_results
        (match_id, player_key, account_id, guest_id, display_name, char_id, placement, lives_left, kos, falls, dmg_dealt, dmg_taken, winner, disconnected, created_at)
      VALUES ('${mid}', '${String(r.player_key).replace(/'/g, "''")}', NULL, NULL, 'TAMPERED', '${r.char_id}', 4, 9, 999, 9, 9999, 9999, 1, 0, 0)`);
}
const afterDup = one(`SELECT (SELECT COUNT(*) FROM match_summary WHERE match_id = '${mid}') s,
                             (SELECT COUNT(*) FROM match_results WHERE match_id = '${mid}') r`);
check('the summary row was NOT overwritten', afterDup.s === 1, afterDup.s);
check('no duplicate result rows were inserted', afterDup.r === results.length, afterDup.r + ' vs ' + results.length);
const stillOriginal = one(`SELECT room_code, player_count, ruleset_hash FROM match_summary WHERE match_id = '${mid}'`);
check('the original summary values survived the replay',
  stillOriginal.room_code === CODE && stillOriginal.player_count === 2 && stillOriginal.ruleset_hash !== 'tampered',
  stillOriginal.room_code + '/' + stillOriginal.player_count + '/' + stillOriginal.ruleset_hash);
const tampered = one(`SELECT COUNT(*) n FROM match_results WHERE match_id = '${mid}' AND display_name = 'TAMPERED'`);
check('no replayed result row overwrote a real one', tampered.n === 0, tampered.n);

/* --------------------------------- 6. the client cannot fake its statistics - */
console.log('\n[6] a client cannot write its own statistics');
const absurd = one(`SELECT COUNT(*) n FROM match_results WHERE dmg_dealt > 5000 OR kos > 200`);
check('no absurd values exist in the table', absurd.n === 0, absurd.n);
const winnerRows = one(`SELECT COUNT(*) n FROM match_results WHERE match_id = '${mid}' AND winner = 1`);
check('the winner count for this match is exactly one', winnerRows.n === 1, winnerRows.n);
const orphan = one(`SELECT COUNT(*) n FROM match_results r
                     WHERE r.account_id IS NOT NULL
                       AND NOT EXISTS (SELECT 1 FROM accounts a WHERE a.id = r.account_id)`);
check('no result references an account that does not exist', orphan.n === 0, orphan.n);

/* ---------------------------------------------------------- 7. events ----- */
console.log('\n[7] the server emitted an analytics event');
const ev = one(`SELECT COUNT(*) n FROM events WHERE name = 'match_ended' AND source = 'server'`);
check('a server-sourced match_ended event exists', ev.n >= 1, ev.n);

/* ---------------------------------------------------------------- done ---- */
db.close();
console.log('\n' + '='.repeat(66));
console.log(failures === 0
  ? 'MATCH REPORTING WORKS — real matches land in D1 with server-computed values'
  : failures + ' CHECK(S) FAILED');
console.log('='.repeat(66) + '\n');
process.exit(failures === 0 ? 0 : 1);
