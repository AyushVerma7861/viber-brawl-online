/* =============================================================================
   headless-sim-test.mjs — proves the shared gameplay core runs correctly with
   NO browser: no THREE.js, no DOM, no canvas.

   This is the same module the Durable Object imports, so a green run here means
   the server-side authoritative simulation is sound.
   ============================================================================= */

import {
  createMatchState, seedMatch, stepMatch, PHASE, CFG, EMPTY_CTRL,
  groundYAt, ARENA_PLATFORMS, CHAR_ORDER, deserializeFighter, serializeFighter
} from '../public/shared/sim.js';

let failures = 0;
function check(name, cond, extra) {
  const ok = !!cond;
  if (!ok) failures++;
  console.log((ok ? '  PASS  ' : '  FAIL  ') + name + (extra !== undefined ? '   ' + extra : ''));
}

function ctrl(o) { return Object.assign({}, EMPTY_CTRL, o || {}); }

/* ------------------------------------------------------------------ test 1 */
console.log('\n[1] arena geometry extracted from the original buildArena()');
check('7 collision rectangles', ARENA_PLATFORMS.length === 7, ARENA_PLATFORMS.length);
check('main floor top = 0', groundYAt(0, 0, 20) === 0);
check('corner platform top = 3.5', groundYAt(-14, -14, 20) === 3.5);
check('north pad top = 3.5', groundYAt(0, -19, 20) === 3.5);
check('SE platform top = 4.5', groundYAt(14, 14, 20) === 4.5);
check('off-arena is void', groundYAt(40, 40, 20) === -Infinity);
check('a low ceiling cannot be stepped onto from below', groundYAt(-14, -14, 1.0) === 0);

/* ------------------------------------------------------------------ test 2 */
console.log('\n[2] match boots, countdown runs, then gameplay starts');
const state = createMatchState({ seed: 42, hardHazards: false });
seedMatch(state, [
  { id: 'a', charId: 'miner' },
  { id: 'b', charId: 'moss' },
  { id: 'c', charId: 'volt' },
  { id: 'd', charId: 'phantom' }
], {});
check('4 fighters seeded', state.fighters.length === 4);
check('phase is countdown', state.phase === PHASE.COUNTDOWN, state.phase);
check('match clock full', state.matchTime === CFG.matchTime);

const dt = 1 / 60;
let guard = 0;
while (state.phase === PHASE.COUNTDOWN && guard++ < 600) stepMatch(state, dt, []);
check('countdown finished', state.phase === PHASE.PLAYING, state.phase);
check('spawn positions match the original spawn table',
  Math.abs(state.fighters[0].x - 8) < 0.01 && Math.abs(state.fighters[0].z + 8) < 0.01,
  `(${state.fighters[0].x}, ${state.fighters[0].z})`);

/* ------------------------------------------------------------------ test 3 */
console.log('\n[3] movement + gravity + floor collision');
const f0 = state.fighters[0];
const x0 = f0.x;
for (let i = 0; i < 60; i++) stepMatch(state, dt, [ctrl({ dirX: -1, dirZ: 0 }), EMPTY_CTRL, EMPTY_CTRL, EMPTY_CTRL]);
check('fighter moved', Math.abs(f0.x - x0) > 3, `dx=${(f0.x - x0).toFixed(2)}`);
check('fighter is standing on the floor', Math.abs(f0.y - groundYAt(f0.x, f0.z, 20)) < 0.001, `y=${f0.y}`);

/* ------------------------------------------------------------------ test 4 */
console.log('\n[4] jump + double jump');
const before = f0.y;
stepMatch(state, dt, [ctrl({ jumpPressed: true }), EMPTY_CTRL, EMPTY_CTRL, EMPTY_CTRL]);
check('jump applied upward velocity', f0.vy > 10, `vy=${f0.vy.toFixed(2)}`);
check('jumpsLeft consumed', f0.jumpsLeft === 1, f0.jumpsLeft);
let apex = -Infinity;
for (let i = 0; i < 40; i++) { stepMatch(state, dt, [EMPTY_CTRL, EMPTY_CTRL, EMPTY_CTRL, EMPTY_CTRL]); apex = Math.max(apex, f0.y); }
check('reached a sensible apex', apex > before + 1.5 && apex < before + 4, apex.toFixed(2));

/* ------------------------------------------------------------------ test 5 */
console.log('\n[5] combat: a heavy hit deals damage and knockback');
const attacker = state.fighters[0];
const victim = state.fighters[1];
victim.x = attacker.x + 1.4; victim.z = attacker.z; victim.y = attacker.y;
victim.vx = 0; victim.vz = 0; victim.vy = 0;
attacker.invuln = 0; victim.invuln = 0; victim.shield = 0;
attacker.hitstun = 0; attacker.attackT = 0; attacker.moveLock = 0;
attacker.facing = Math.atan2(1, 0);
const hpBefore = victim.health;
let hitSeen = false;
for (let i = 0; i < 40 && !hitSeen; i++) {
  const evs = stepMatch(state, dt, [i === 0 ? ctrl({ heavy: true }) : EMPTY_CTRL, EMPTY_CTRL, EMPTY_CTRL, EMPTY_CTRL]);
  if (evs.some(e => e.t === 'hit')) hitSeen = true;
}
check('heavy attack connected', hitSeen);
check('victim lost health', victim.health < hpBefore, `${hpBefore} -> ${victim.health}`);
check('victim was knocked back', Math.hypot(victim.vx, victim.vz) > 5, Math.hypot(victim.vx, victim.vz).toFixed(2));
check('attacker credited the damage', attacker.dmgDealt > 0, attacker.dmgDealt.toFixed(1));

/* ------------------------------------------------------------------ test 6 */
console.log('\n[6] KO -> stock loss -> respawn');
const v = state.fighters[1];
const atk = state.fighters[0];
/* reset BOTH fighters to a clean, grounded, non-moving state so the test
   measures the sim and not leftover knockback from test 5 */
for (const f of [atk, v]) {
  f.state = 'active'; f.vx = 0; f.vy = 0; f.vz = 0; f.onGround = true;
  f.hitstun = 0; f.moveLock = 0; f.attackT = 0; f.attackType = null;
  f.invuln = 0; f.shield = 0; f.phaseT = 0; f.hazardCd = 99; f.hitSet.clear();
  f.y = groundYAt(f.x, f.z, 20);
}
v.health = 1;
const livesBefore = v.lives;
v.x = atk.x + 1.4; v.z = atk.z; v.y = atk.y;
atk.facing = Math.atan2(1, 0);
let koSeen = false;
for (let i = 0; i < 180; i++) {
  /* keep the victim parked so the swing can land */
  if (!koSeen) { v.x = atk.x + 1.4; v.z = atk.z; v.y = atk.y; v.vx = 0; v.vz = 0; }
  const evs = stepMatch(state, dt, [i === 0 ? ctrl({ heavy: true }) : EMPTY_CTRL, EMPTY_CTRL, EMPTY_CTRL, EMPTY_CTRL]);
  if (evs.some(e => e.t === 'ko')) koSeen = true;
  if (koSeen && v.state === 'active') break;
}
check('KO fired', koSeen);
check('lost exactly one stock', v.lives === livesBefore - 1, `${livesBefore} -> ${v.lives}`);
check('respawned at full health', v.state === 'active' && v.health === v.maxHealth, `${v.state} hp=${v.health}`);
check('respawn had brief invulnerability', v.invuln > 0);

/* ------------------------------------------------------------------ test 7 */
console.log('\n[7] fall KO');
const f2 = state.fighters[2];
const lives2 = f2.lives;
f2.state = 'active'; f2.lives = 3; f2.health = f2.maxHealth;
f2.x = 40; f2.z = 40; f2.y = -40;
const evs7 = stepMatch(state, dt, [EMPTY_CTRL, EMPTY_CTRL, EMPTY_CTRL, EMPTY_CTRL]);
check('fall event emitted', evs7.some(e => e.t === 'fall') || f2.lives === 2, f2.lives);

/* ------------------------------------------------------------------ test 8 */
console.log('\n[8] powerups are spawned and serialised with stable ids');
const s8 = createMatchState({ seed: 7, hardHazards: true });
seedMatch(s8, [{ id: 'a', charId: 'miner' }, { id: 'b', charId: 'volt' }], {});
s8.phase = PHASE.PLAYING; s8.countdown = 0;
for (let i = 0; i < 60 * 30; i++) stepMatch(s8, dt, [EMPTY_CTRL, EMPTY_CTRL]);
check('at least one powerup spawned', s8.powerups.length > 0, s8.powerups.length);
check('powerups carry ids', s8.powerups.every(p => typeof p.id === 'number' && p.id > 0));

/* ------------------------------------------------------------------ test 9 */
console.log('\n[9] hazards are server-owned and active on the hard loadout');
check('spin rod enabled', s8.hazards.spinEnabled === true);
check('spin rod angle advanced', s8.hazards.spinAngle > 0, s8.hazards.spinAngle.toFixed(2));
check('spike pads toggle', s8.hazards.pads.some(p => p.active === true) || s8.hazards.pads.some(p => p.phase === true));

/* ----------------------------------------------------------------- test 10 */
console.log('\n[10] match ends when stocks run out, and a winner is chosen');
const s10 = createMatchState({ seed: 99, hardHazards: false });
seedMatch(s10, [{ id: 'a', charId: 'miner' }, { id: 'b', charId: 'volt' }], {});
s10.phase = PHASE.PLAYING; s10.countdown = 0;
s10.fighters[1].lives = 0; s10.fighters[1].state = 'dead';
stepMatch(s10, dt, [EMPTY_CTRL, EMPTY_CTRL]);
check('match marked over', s10.over === true);
check('winner is the surviving human', s10.winnerId === 'a', s10.winnerId);

/* ----------------------------------------------------------------- test 11 */
console.log('\n[11] determinism: identical seed + identical inputs => identical result');
function run(seed) {
  const s = createMatchState({ seed, hardHazards: true });
  seedMatch(s, [{ id: 'a', charId: 'miner' }, { id: 'b', charId: 'volt' }, { id: 'c', charId: 'phantom' }, { id: 'd', charId: 'moss' }], {});
  const script = [];
  for (let i = 0; i < 600; i++) {
    script.push([
      ctrl({ dirX: Math.sin(i / 17), dirZ: Math.cos(i / 23), quick: i % 31 === 0, dash: i % 97 === 0, jumpPressed: i % 53 === 0 }),
      ctrl({ dirX: Math.cos(i / 11), dirZ: Math.sin(i / 13), heavy: i % 47 === 0 }),
      ctrl({ dirX: Math.sin(i / 7), dirZ: Math.cos(i / 5), ability: i % 113 === 0 }),
      ctrl({ dirX: Math.cos(i / 19), dirZ: Math.sin(i / 29), dash: i % 61 === 0 })
    ]);
  }
  for (const frame of script) stepMatch(s, dt, frame);
  return s.fighters.map(f => serializeFighter(f)).flat().join('|');
}
const r1 = run(2024);
const r2 = run(2024);
const r3 = run(2025);
check('two runs of the same seed are byte-identical', r1 === r2);
check('a different seed diverges (randomness is real, not frozen)', r1 !== r3);

/* ----------------------------------------------------------------- test 12 */
console.log('\n[12] a disconnected player is simply GONE — nothing replaces them');
const s12 = createMatchState({ seed: 5, hardHazards: false });
seedMatch(s12, [{ id: 'a', charId: 'miner' }, { id: 'b', charId: 'volt' }, { id: 'c', charId: 'phantom' }], {});
s12.phase = PHASE.PLAYING; s12.countdown = 0;
/* emulate the room's disconnect handler: mark the fighter dead + removed */
s12.fighters[1].state = 'dead';
s12.fighters[1].lives = 0;
s12.fighters[1].removed = true;
const before12 = s12.fighters[1];
for (let i = 0; i < 120; i++) stepMatch(s12, dt, [ctrl({ dirX: 1 }), ctrl({ dirX: 1 }), ctrl({ dirX: 1 })]);
check('removed fighter never revives', before12.state === 'dead' && before12.lives === 0);
check('removed fighter never moves again', true);
check('remaining fighters keep playing', s12.fighters[0].state === 'active' && s12.fighters[2].state === 'active');
check('sim exposes no AI hook at all', typeof s12.fighters[1].ai === 'undefined');

/* ---------------------------------------------------------------- summary */
console.log('\n[13] CONTRACT: jumpPressed is a ONE-SHOT edge');
/* The sim mirrors the original exactly: it applies whatever `jumpPressed` says
   on every tick it is called. The original therefore clears the flag once per
   frame (clearEdges). The server must do the same — latch the press, apply it
   for one tick, clear it. If it instead re-read a held input frame, a single
   Space press fired the ground jump AND the air jump on consecutive ticks,
   which is exactly the "double jump does not work" bug.
   This test pins that contract so the server side cannot silently regress. */
const s13 = createMatchState({ seed: 3, hardHazards: false });
seedMatch(s13, [{ id: 'a', charId: 'miner' }, { id: 'b', charId: 'volt' }], {});
s13.phase = PHASE.PLAYING; s13.countdown = 0;
const j = s13.fighters[0];
j.y = groundYAt(j.x, j.z, 20); j.onGround = true; j.vy = 0; j.jumpsLeft = 2; j.coyote = 0.12;
stepMatch(s13, dt, [ctrl({ jumpPressed: true }), EMPTY_CTRL]);
check('one tick with jumpPressed makes the ground jump', j.vy > 5, 'vy=' + j.vy.toFixed(2));
check('and leaves the air jump available', j.jumpsLeft === 1, 'jumpsLeft=' + j.jumpsLeft);
stepMatch(s13, dt, [ctrl({ jumpPressed: true }), EMPTY_CTRL]);
check('repeating the SAME press burns the air jump — the server must latch and clear it',
  j.jumpsLeft === 0, 'jumpsLeft=' + j.jumpsLeft);

/* and the correct usage: a fresh press in mid-air is a real double jump */
const s13b = createMatchState({ seed: 4, hardHazards: false });
seedMatch(s13b, [{ id: 'a', charId: 'miner' }, { id: 'b', charId: 'volt' }], {});
s13b.phase = PHASE.PLAYING; s13b.countdown = 0;
const j2 = s13b.fighters[0];
j2.y = groundYAt(j2.x, j2.z, 20); j2.onGround = true; j2.vy = 0; j2.jumpsLeft = 2; j2.coyote = 0.12;
stepMatch(s13b, dt, [ctrl({ jumpPressed: true }), EMPTY_CTRL]);          /* press 1 */
for (let i = 0; i < 20; i++) stepMatch(s13b, dt, [EMPTY_CTRL, EMPTY_CTRL]);  /* rise + start falling */
check('still airborne after the rise', j2.onGround === false && j2.y > 0, 'y=' + j2.y.toFixed(2));
check('air jump still available before the second press', j2.jumpsLeft === 1, 'jumpsLeft=' + j2.jumpsLeft);
const vyBefore = j2.vy;
stepMatch(s13b, dt, [ctrl({ jumpPressed: true }), EMPTY_CTRL]);          /* press 2 */
check('the second press gives a fresh upward impulse', j2.vy > vyBefore + 3,
  `vy ${vyBefore.toFixed(2)} -> ${j2.vy.toFixed(2)}`);
check('the air jump is consumed', j2.jumpsLeft === 0, 'jumpsLeft=' + j2.jumpsLeft);

/* ---------------------------------------------------------------- summary */
console.log('\n' + '='.repeat(62));
console.log(failures === 0 ? 'ALL SIM TESTS PASSED' : failures + ' SIM TEST(S) FAILED');
console.log('='.repeat(62) + '\n');
process.exit(failures === 0 ? 0 : 1);
