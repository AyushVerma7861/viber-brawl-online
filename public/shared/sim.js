/* =============================================================================
   VIBER BRAWL — SHARED DETERMINISTIC GAMEPLAY CORE
   -----------------------------------------------------------------------------
   This module is the SINGLE SOURCE OF TRUTH for gameplay rules.

   It is loaded by:
     1. The Cloudflare Durable Object  (authoritative simulation)  — as an
        ES module imported by BattleRoom.js
     2. The browser client             (client-side prediction)     — via
        `import()` of the very same file, served by the Worker / Pages

   There is therefore exactly ONE copy of the movement / combat / ability /
   hazard / powerup / KO / respawn rules in the project. Nothing is duplicated.

   HARD RULES OBEYED HERE:
     * No THREE.js, no DOM, no window, no document, no AudioContext.
     * No Math.random() — every random draw goes through a seeded PRNG so the
       server is the only thing that decides gameplay randomness, and the same
       tick produces the same result everywhere.
     * No AI. This module has no notion of a bot. A disconnected human is
       removed from `fighters` — never replaced.

   Ported faithfully from `stepFighter(f, dt, ctrl)` and its helpers in the
   original v6 single-file game. Visual side effects (particles, sound,
   camera shake presentation, screen announce) have been replaced with an
   ordered `events` list that the client turns back into FX.
   ============================================================================= */

/* ---------------------------------------------------------------------------
   Tunables — copied verbatim from the original file's CFG / ATTACKS.
   --------------------------------------------------------------------------- */
export const CFG = {
  gravity: -44,
  fallY: -38,
  lives: 3,
  matchTime: 180
};

export const ATTACKS = {
  quick: { startup:0.07, active:0.10, recovery:0.17, dmg:8,  kb:10.5, range:2.5, arc:1.15, up:0.38, hitstop:0.05, stun:0.22, shake:0.28, sound:'hitLight' },
  heavy: { startup:0.21, active:0.14, recovery:0.36, dmg:16, kb:20,   range:3.1, arc:0.95, up:0.52, hitstop:0.11, stun:0.40, shake:0.62, sound:'hitHeavy' }
};

/* Ability parameters that were previously inlined in `useAbility`/`minerSmash`. */
export const ABILITY = {
  smash:   { vy:-6, t:1.2, moveLock:0.2, diveVy:-34, radius:6.2, dmg:16, kb:22, up:18, vertical:3.5 },
  volt:    { blink:11, vx:17, t:0.3, invuln:0.45, radius:2.6, dmg:10, kb:14, up:0.5, stun:0.28, vertical:2.2 },
  phantom: { phaseT:1.4, invuln:1.2, speedBuff:1.4 }
};

export const POWER_TYPES = [
  { id:'spark',  name:'SPARK BOOST', color:0xDFF902, dur:11 },
  { id:'power',  name:'POWER',       color:0xA56BFF, dur:11 },
  { id:'shield', name:'SHIELD',      color:0x5CFFE7, dur:0  },
  { id:'dash',   name:'DASH',        color:0xFFD34D, dur:14 }
];

/* Spawn spots — original POWER_SPOTS, [x, baseY, z]. */
export const POWER_SPOTS = [
  [0,0.9,0], [-14,2.9,-14], [14,4.6,-14], [-14,2.3,14], [14,5.5,14],
  [0,4.5,-19], [0,4.5,19], [-9,1,-9], [9,1,-9], [-9,1,9], [9,1,9]
];

export const MAX_POWERUPS = 3;
export const POWER_LIFE = 26;

/* The four Vibers' GAMEPLAY stats. The model/visual definitions stay in the
   client HTML; only the numbers the simulation needs live here. */
export const CHAR_STATS = {
  miner:   { id:'miner',   name:'CRIMSON MINER VIBER', tag:'HEAVY',     speed:11.5, jump:16.0, health:110, weight:1.20, damageMul:1.08, abilityCd:8, ability:'smash'   },
  moss:    { id:'moss',    name:'MOSS VIBER',          tag:'HEAVY',     speed:11.5, jump:16.0, health:110, weight:1.20, damageMul:1.08, abilityCd:8, ability:'smash'   },
  volt:    { id:'volt',    name:'VOLT VIBER',          tag:'SPEED',     speed:13.8, jump:18.2, health:95,  weight:0.95, damageMul:1.00, abilityCd:5, ability:'flash'   },
  phantom: { id:'phantom', name:'PHANTOM VIBER',       tag:'TRICKSTER', speed:13.0, jump:17.6, health:100, weight:1.00, damageMul:0.98, abilityCd:8, ability:'phase'   }
};

export const CHAR_ORDER = ['miner', 'moss', 'volt', 'phantom'];

/* ---------------------------------------------------------------------------
   ARENA GEOMETRY
   Extracted from `buildArena()` in the original file. Every `slab()` call that
   pushed a collision rectangle (i.e. topY defined and noPlatform not set) is
   listed here. The visual meshes are irrelevant to the simulation, so only the
   numeric rectangles are needed — this is what lets the Worker simulate the
   REAL Viber Brawl arena with no THREE.js.

     slab(cx,cz,w,d,topY,h,color,outline,noPlatform)
       -> { minX: cx-w/2, maxX: cx+w/2, minZ: cz-d/2, maxZ: cz+d/2, top: topY }
   --------------------------------------------------------------------------- */
function slabRect(cx, cz, w, d, top) {
  return { minX: cx - w / 2, maxX: cx + w / 2, minZ: cz - d / 2, maxZ: cz + d / 2, top };
}

export const ARENA_PLATFORMS = [
  slabRect(  0,   0, 34,   34,  0.0),   /* main floor                       */
  slabRect(-14, -14, 11,   11,  3.5),   /* corner platforms                 */
  slabRect( 14, -14, 10,   10,  3.6),
  slabRect(-14,  14, 10.5, 10.5, 3.5),
  slabRect( 14,  14,  9.5,  9.5, 4.5),
  slabRect(  0, -19,  7,    7,  3.5),   /* north / south pads               */
  slabRect(  0,  19,  7,    7,  3.5)
];

export const SPAWN_POINTS = [[8, -8], [-8, 8], [8, 8], [-8, -8]];

/* Hazard rig — `buildHazards()` in the original. */
export const HAZARD = {
  spinY: 1.55,
  spinSpeed: 0.62,
  spinHalfLength: 7.3,
  spinHalfWidth: 0.9,
  spinVertical: 1.3,
  padPositions: [[-11, 0], [11, 0], [0, -11], [0, 11]],
  padHalf: 2.2,
  padMaxY: 1.2,
  padActiveTime: 1.9,
  padIdleTime: 2.4
};

/* ---------------------------------------------------------------------------
   Math helpers — same semantics as the original.
   --------------------------------------------------------------------------- */
export const clamp = (v, a, b) => (v < a ? a : (v > b ? b : v));
export const lerp  = (a, b, t) => a + (b - a) * t;
export const TAU   = Math.PI * 2;
export function angLerp(a, b, t) {
  const d = ((b - a + Math.PI) % TAU + TAU) % TAU - Math.PI;
  return a + d * t;
}
export function distFromCenter(x, z) { return Math.hypot(x, z); }

/* ---------------------------------------------------------------------------
   Seeded PRNG (mulberry32). The server owns every gameplay random draw.
   --------------------------------------------------------------------------- */
export function makeRng(seed) {
  let a = seed >>> 0;
  return function rng() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function rngRange(rng, a, b) { return a + rng() * (b - a); }
export function rngInt(rng, a, b)   { return Math.floor(a + rng() * (b - a + 1)); }

/* ---------------------------------------------------------------------------
   Ground query — identical to the original groundYAt().
   --------------------------------------------------------------------------- */
export function groundYAt(x, z, fromY, platforms) {
  const list = platforms || ARENA_PLATFORMS;
  let best = -Infinity;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (x > p.minX && x < p.maxX && z > p.minZ && z < p.maxZ) {
      if (p.top <= fromY + 0.61 && p.top > best) best = p.top;
    }
  }
  return best;
}

/* ---------------------------------------------------------------------------
   Safe-blink targeting (Volt) — ported from blinkSafe() / pickBlinkDir().
   --------------------------------------------------------------------------- */
function blinkSafe(f, dx, dz) {
  const g = groundYAt(f.x + dx * ABILITY.volt.blink, f.z + dz * ABILITY.volt.blink, f.y + 8);
  return g !== -Infinity && g >= f.y - 6;
}
function pickBlinkDir(f, bx, bz) {
  const cand = [[bx, bz]];
  const s = (f.index % 2 === 0) ? 1 : -1;
  cand.push([-bz * s, bx * s]);
  cand.push([ bz * s, -bx * s]);
  const l = Math.hypot(f.x, f.z) || 1;
  cand.push([-f.x / l, -f.z / l]);
  for (const c of cand) {
    const L = Math.hypot(c[0], c[1]);
    if (L < 0.001) continue;
    if (blinkSafe(f, c[0] / L, c[1] / L)) return [c[0] / L, c[1] / L];
  }
  return null;
}

/* ===========================================================================
   SimFighter — pure gameplay state. No meshes, no materials, no audio.
   Field-for-field compatible with the client's Fighter class so the renderer
   can be driven straight from a snapshot.
   =========================================================================== */
export class SimFighter {
  constructor(charId, index) {
    this.def = CHAR_STATS[charId] || CHAR_STATS.miner;
    this.charId = this.def.id;
    this.index = index;
    this.isPlayer = true;      /* every networked fighter is a human            */
    this.isHuman = true;       /* explicit: the server never spawns bots        */
    this.id = null;            /* filled in by the room: the player id          */

    this.x = 0; this.y = 0; this.z = 0;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.facing = 0;

    this.maxHealth = this.def.health;
    this.health = this.def.health;
    this.lives = CFG.lives;
    this.state = 'active';
    this.onGround = false; this.coyote = 0; this.jumpsLeft = 2;

    this.dashCd = 0; this.dashT = 0; this.dashVecX = 0; this.dashVecZ = 0;
    this.abilityCd = 0; this.abilityActive = ''; this.abilityT = 0;
    this.attackType = null; this.attackT = 0; this.attackPhase = '';
    this.hitSet = new Set();
    this.hitstun = 0; this.moveLock = 0; this.invuln = 0;
    this.phaseT = 0; this.shield = 0; this.speedBuff = 0; this.damageBuff = 0; this.dashBuff = 0;
    this.koT = 0; this.respawnT = 0; this.animT = 0; this.flash = 0;
    this.hazardCd = 0;
    this.kos = 0; this.falls = 0; this.dmgDealt = 0; this.dmgTaken = 0;
    this.lastHitBy = null;
    this.landSquash = 0; this.landSquashAmt = 0;
  }

  reset(x, z, lives) {
    const gy = groundYAt(x, z, 20);
    this.x = x; this.y = (gy === -Infinity ? 0 : gy); this.z = z;
    this.vx = 0; this.vy = 0; this.vz = 0;
    this.health = this.maxHealth;
    this.lives = (lives === undefined) ? CFG.lives : lives;
    this.state = 'active';
    this.onGround = true; this.jumpsLeft = 2; this.coyote = 0.12;
    this.dashCd = 0; this.dashT = 0;
    this.abilityCd = 0; this.abilityActive = ''; this.abilityT = 0;
    this.attackType = null; this.attackT = 0; this.attackPhase = '';
    this.hitSet.clear();
    this.hitstun = 0; this.moveLock = 0; this.invuln = 1.6;
    this.phaseT = 0; this.shield = 0; this.speedBuff = 0; this.damageBuff = 0; this.dashBuff = 0;
    this.koT = 0; this.respawnT = 0; this.flash = 0; this.hazardCd = 0;
    this.landSquash = 0; this.landSquashAmt = 0;
    this.facing = Math.atan2(-x, -z);
  }

  resetStats() { this.kos = 0; this.falls = 0; this.dmgDealt = 0; this.dmgTaken = 0; }
}

/* ===========================================================================
   Match state
   =========================================================================== */
export const PHASE = {
  LOBBY: 'lobby',
  COUNTDOWN: 'countdown',
  PLAYING: 'playing',
  OVER: 'over'
};

export function createMatchState(opts) {
  opts = opts || {};
  return {
    tick: 0,
    time: 0,                 /* Game.time — drives cosmetic animation phase     */
    matchTime: CFG.matchTime,
    countdown: 3.4,
    hitStop: 0,
    shake: 0,
    phase: PHASE.COUNTDOWN,
    over: false,
    winner: null,            /* fighter index, or -1 for a draw                 */
    winnerId: null,
    rng: makeRng(opts.seed >>> 0 || 123456789),
    fighters: [],
    platforms: ARENA_PLATFORMS,
    hazards: {
      spinAngle: 0,
      spinEnabled: opts.hardHazards === true,
      padsEnabled: opts.hardHazards !== false,
      pads: HAZARD.padPositions.map((p, i) => ({
        x: p[0], z: p[1], active: false, timer: i * 0.9, phase: false
      }))
    },
    powerups: [],
    powerSpawnTimer: 4,
    nextPowerupId: 1,
    events: []
  };
}

/* Seed a fresh match from a list of { id, charId } slots. */
export function seedMatch(state, slots, opts) {
  opts = opts || {};
  state.fighters = slots.map((s, i) => {
    const f = new SimFighter(s.charId, i);
    f.id = s.id;
    f.resetStats();
    const sp = SPAWN_POINTS[i % SPAWN_POINTS.length];
    f.reset(sp[0], sp[1], CFG.lives);
    f.invuln = 0;
    return f;
  });
  state.tick = 0;
  state.time = 0;
  state.matchTime = CFG.matchTime;
  state.countdown = 3.4;
  state.hitStop = 0;
  state.shake = 0;
  state.over = false;
  state.winner = null;
  state.winnerId = null;
  state.phase = PHASE.COUNTDOWN;
  state.powerups.length = 0;
  state.powerSpawnTimer = 4;
  state.nextPowerupId = 1;
  state.events.length = 0;
  state.hazards.spinAngle = 0;
  state.hazards.pads.forEach((p, i) => {
    p.active = false; p.phase = false; p.timer = i * 0.9;
  });
  if (opts.rng) state.rng = opts.rng;
  return state;
}

/* ---------------------------------------------------------------------------
   Event emission — the ONLY channel through which the server tells the client
   "something visually happened". Keeps the sim free of FX code.
   --------------------------------------------------------------------------- */
function emit(state, ev) {
  if (state.events.length < 240) state.events.push(ev);
}

/* ===========================================================================
   Core fighter step — a faithful port of stepFighter(f, dt, ctrl).
   `dt` here is already hit-stop scaled (sdt) exactly as in the original.
   =========================================================================== */
export function stepFighter(state, f, dt, ctrl) {
  if (f.state === 'dead') return;

  f.dashCd    = Math.max(0, f.dashCd - dt);
  f.abilityCd = Math.max(0, f.abilityCd - dt);
  f.invuln    = Math.max(0, f.invuln - dt);
  f.hitstun   = Math.max(0, f.hitstun - dt);
  f.moveLock  = Math.max(0, f.moveLock - dt);
  f.speedBuff = Math.max(0, f.speedBuff - dt);
  f.damageBuff= Math.max(0, f.damageBuff - dt);
  f.dashBuff  = Math.max(0, f.dashBuff - dt);
  f.phaseT    = Math.max(0, f.phaseT - dt);
  f.dashT     = Math.max(0, f.dashT - dt);
  f.abilityT  = Math.max(0, f.abilityT - dt);
  f.flash     = Math.max(0, f.flash - dt);

  /* ---------------------------------------------------------------- KO fall */
  if (f.state === 'ko') {
    f.koT -= dt;
    f.vy += CFG.gravity * 0.42 * dt;
    f.x += f.vx * dt; f.y += f.vy * dt; f.z += f.vz * dt;
    f.vx *= 0.995; f.vz *= 0.995;
    if (f.koT <= 0) {
      if (f.lives > 0) { f.respawnT = 0.35; f.state = 'respawning'; }
      else { f.state = 'dead'; }
    }
    return;
  }

  /* ------------------------------------------------------------- respawning */
  if (f.state === 'respawning') {
    f.respawnT -= dt;
    if (f.respawnT <= 0) {
      let sp = [0, 0]; let tries = 0;
      do {
        sp = SPAWN_POINTS[rngInt(state.rng, 0, 3)];
        tries++;
      } while (tries < 10 && state.fighters.some(o =>
        o !== f && o.state === 'active' && Math.hypot(o.x - sp[0], o.z - sp[1]) < 4));
      const gy = groundYAt(sp[0], sp[1], 20);
      f.x = sp[0]; f.z = sp[1]; f.y = (gy === -Infinity ? 0 : gy) + 0.2;
      f.vx = 0; f.vy = 0; f.vz = 0;
      f.health = f.maxHealth; f.state = 'active'; f.invuln = 1.8;
      f.onGround = false; f.jumpsLeft = 2;
      emit(state, { t: 'respawn', i: f.index, x: f.x, y: f.y, z: f.z });
    }
    return;
  }

  const canAct = f.hitstun <= 0 && f.attackT <= 0;

  /* -------------------------------------------------------------- abilities */
  if (f.abilityActive === 'smash') {
    f.vy = Math.min(f.vy, ABILITY.smash.diveVy);
    const g = groundYAt(f.x, f.z, f.y + 1);
    if (f.onGround || f.y <= ((g === -Infinity ? 0 : g) + 0.05)) {
      f.abilityActive = '';
      minerSmash(state, f);
    }
  }
  if (f.abilityActive === 'spark') {
    for (const o of state.fighters) {
      if (o === f || o.state !== 'active') continue;
      const d = Math.hypot(o.x - f.x, o.z - f.z);
      if (d < 2.3 && Math.abs(o.y - f.y) < 2.2 && !f.hitSet.has(o)) {
        f.hitSet.add(o);
        applyHit(state, f, o, { dmg:11, kb:15, up:0.5, stun:0.3, hitstop:0.06, shake:0.45, range:2.3, sound:'hitHeavy' });
      }
    }
    if (f.abilityT <= 0) { f.abilityActive = ''; f.hitSet.clear(); }
  }
  if (f.abilityActive === 'flash') { if (f.abilityT <= 0) f.abilityActive = ''; }

  /* ------------------------------------------------------------- locomotion */
  const moving = (Math.abs(ctrl.dirX) > 0.01 || Math.abs(ctrl.dirZ) > 0.01);
  let speedMul = 1;
  if (f.speedBuff > 0) speedMul *= 1.35;
  if (f.phaseT > 0)    speedMul *= 1.45;
  if (f.attackT > 0)   speedMul *= 0.55;
  const maxSpd = f.def.speed * speedMul;

  let tx = 0, tz = 0;
  if (moving && canAct && f.abilityActive !== 'smash') {
    const l = Math.hypot(ctrl.dirX, ctrl.dirZ);
    tx = (ctrl.dirX / l) * maxSpd;
    tz = (ctrl.dirZ / l) * maxSpd;
    if (f.moveLock <= 0 && f.dashT <= 0) {
      const targetFacing = Math.atan2(ctrl.dirX, ctrl.dirZ);
      /* turnRate 18 — the AI-only "slow pivot near a foe" branch does not apply
         to networked humans, and the AI backing-away damping is unreachable. */
      const t3 = (1 - Math.exp(-18 * dt));
      f.facing = angLerp(f.facing, targetFacing, t3);
    }
  }
  let k;
  if (f.onGround) k = (f.moveLock > 0) ? 5 : 16;
  else            k = (f.moveLock > 0) ? 0.7 : 2.4;
  const damp = Math.exp(-k * dt);
  f.vx = f.vx * damp + tx * (1 - damp);
  f.vz = f.vz * damp + tz * (1 - damp);

  /* ------------------------------------------------------------------ dash */
  if (ctrl.dash && f.dashCd <= 0 && canAct && f.moveLock <= 0) {
    let dx = ctrl.dirX, dz = ctrl.dirZ;
    if (Math.hypot(dx, dz) < 0.1) { dx = Math.sin(f.facing); dz = Math.cos(f.facing); }
    const l = Math.hypot(dx, dz) || 1;
    f.dashVecX = dx / l; f.dashVecZ = dz / l;
    const dashPower = f.dashBuff > 0 ? 30 : 24;
    f.vx = f.dashVecX * dashPower; f.vz = f.dashVecZ * dashPower;
    if (!f.onGround) f.vy = Math.max(f.vy, 1.5);
    f.dashT = 0.22;
    f.dashCd = f.dashBuff > 0 ? 0.55 : 1.05;
    f.moveLock = 0.16;
    f.facing = Math.atan2(f.dashVecX, f.dashVecZ);
    emit(state, { t: 'dash', i: f.index, x: f.x, y: f.y, z: f.z, dx: f.dashVecX, dz: f.dashVecZ });
  }

  /* ------------------------------------------------------------------ jump */
  if (ctrl.jumpPressed && canAct && f.moveLock <= 0) {
    if (f.onGround || f.coyote > 0) {
      f.vy = f.def.jump; f.onGround = false; f.coyote = 0; f.jumpsLeft = 1;
      emit(state, { t: 'jump', i: f.index, x: f.x, y: f.y, z: f.z, dbl: false });
    } else if (f.jumpsLeft > 0) {
      f.vy = f.def.jump * 0.92; f.jumpsLeft--;
      f.vx *= 0.75; f.vz *= 0.75;
      emit(state, { t: 'jump', i: f.index, x: f.x, y: f.y, z: f.z, dbl: true });
    }
  }

  /* ---------------------------------------------------------------- attacks */
  if (canAct && f.attackT <= 0 && f.moveLock <= 0) {
    if (ctrl.quick) startAttack(state, f, 'quick');
    else if (ctrl.heavy) startAttack(state, f, 'heavy');
  }
  if (f.attackT > 0) {
    f.attackT -= dt;
    const atk = ATTACKS[f.attackType];
    const total = atk.startup + atk.active + atk.recovery;
    const elapsed = total - f.attackT;
    if (elapsed >= atk.startup && elapsed < atk.startup + atk.active) {
      if (f.attackPhase !== 'active') { f.attackPhase = 'active'; emit(state, { t: 'swing', i: f.index, heavy: f.attackType === 'heavy' }); }
      tryHit(state, f);
    }
    if (f.attackT <= 0) { f.attackT = 0; f.attackType = null; f.attackPhase = ''; f.hitSet.clear(); }
  }

  if (ctrl.ability && f.abilityCd <= 0 && canAct && f.moveLock <= 0) useAbility(state, f);

  /* --------------------------------------------------------------- gravity */
  const prevY = f.y;
  f.vy += CFG.gravity * dt;
  if (f.vy < -60) f.vy = -60;
  f.x += f.vx * dt; f.z += f.vz * dt; f.y += f.vy * dt;

  const gy = groundYAt(f.x, f.z, Math.max(prevY, f.y) + 1);
  if (f.vy <= 0 && prevY >= gy - 0.35 && f.y <= gy) {
    if (!f.onGround && f.vy < -6) {
      const impact = clamp(-f.vy / 34, 0, 1);
      f.landSquash = 0.16 + impact * 0.24;
      f.landSquashAmt = 0.09 + impact * 0.20;
      emit(state, { t: 'land', i: f.index, x: f.x, y: gy, z: f.z, impact });
      if (impact > 0.5) state.shake = Math.max(state.shake, (impact - 0.5) * 0.55);
    }
    f.y = gy; f.vy = 0; f.onGround = true; f.jumpsLeft = 2; f.coyote = 0.12;
  } else {
    if (f.onGround) f.coyote = 0.12;
    f.onGround = false;
    f.coyote = Math.max(0, f.coyote - dt);
  }

  checkHazards(state, f, dt);

  if (f.y < CFG.fallY) {
    f.falls++;
    koByFall(state, f);
    return;
  }
}

/* ---------------------------------------------------------------------------
   Attacks
   --------------------------------------------------------------------------- */
export function startAttack(state, f, type) {
  const atk = ATTACKS[type];
  f.attackType = type;
  f.attackT = atk.startup + atk.active + atk.recovery;
  f.attackPhase = 'startup';
  f.hitSet.clear();
  let best = null, bd = 5.5;
  for (const o of state.fighters) {
    if (o === f || o.state !== 'active') continue;
    const dx = o.x - f.x, dz = o.z - f.z;
    const d = Math.hypot(dx, dz);
    if (d < bd) {
      const dot = (dx * Math.sin(f.facing) + dz * Math.cos(f.facing)) / (d || 1);
      if (dot > 0.15) { bd = d; best = o; }
    }
  }
  if (best) f.facing = Math.atan2(best.x - f.x, best.z - f.z);
}

/* TEMPORARY DEBUG HOOK — set SIM_DEBUG.on = true to trace hit resolution.
   Left in deliberately: it is inert (one boolean check) and is the fastest way
   to diagnose a "the swing plays but nothing connects" report. */
export const SIM_DEBUG = { on: false, calls: 0, last: null };

function tryHit(state, f) {
  const atk = ATTACKS[f.attackType];
  const fwdX = Math.sin(f.facing), fwdZ = Math.cos(f.facing);
  for (const o of state.fighters) {
    if (SIM_DEBUG.on && o !== f) {
      SIM_DEBUG.calls++;
      const ddx = o.x - f.x, ddz = o.z - f.z;
      const dd = Math.hypot(ddx, ddz);
      SIM_DEBUG.last = {
        type: f.attackType, ai: f.index, oi: o.index,
        d: +dd.toFixed(2), dy: +Math.abs(o.y - f.y).toFixed(2),
        facing: +f.facing.toFixed(3),
        dot: dd > 0.01 ? +((ddx * fwdX + ddz * fwdZ) / dd).toFixed(3) : null,
        need: +Math.cos(atk.arc).toFixed(3),
        maxD: +(atk.range + 0.85).toFixed(2),
        oState: o.state, oInv: +o.invuln.toFixed(2), oPhase: +o.phaseT.toFixed(2),
        inHitSet: f.hitSet.has(o)
      };
    }
    if (o === f || o.state !== 'active' || f.hitSet.has(o)) continue;
    if (o.invuln > 0 || o.phaseT > 0) continue;
    const dx = o.x - f.x, dz = o.z - f.z;
    const d = Math.hypot(dx, dz);
    if (d > atk.range + 0.85) continue;
    if (Math.abs(o.y - f.y) > 2.1) continue;
    if (d > 0.01) {
      const dot = (dx * fwdX + dz * fwdZ) / d;
      if (dot < Math.cos(atk.arc)) continue;
    }
    f.hitSet.add(o);
    applyHit(state, f, o, atk);
  }
}

export function applyHit(state, a, o, atk) {
  const dmgMul = (a.damageBuff > 0 ? 1.5 : 1);
  let dmg = atk.dmg * (a.def ? a.def.damageMul : 1) * dmgMul;
  if (a.charId === 'phantom' && a.phaseT > 0) dmg *= 1.2;

  let shielded = false;
  if (o.shield > 0) {
    const absorbed = Math.min(o.shield, dmg);
    o.shield -= absorbed; dmg -= absorbed;
    shielded = absorbed > 0;
  }

  o.health -= dmg; o.dmgTaken += dmg; a.dmgDealt += dmg;

  const dx = o.x - a.x, dz = o.z - a.z;
  const d = Math.hypot(dx, dz) || 1;
  const nx = dx / d, nz = dz / d;
  const dmgRatio = 1 - clamp(o.health / o.maxHealth, 0, 1);
  const scale = (1 + dmgRatio * 1.7) / o.def.weight;
  const kb = atk.kb * scale * (a.damageBuff > 0 ? 1.25 : 1);

  o.vx += nx * kb; o.vz += nz * kb;
  o.vy = Math.max(o.vy, atk.kb * atk.up * scale * 1.05);
  o.hitstun = Math.max(o.hitstun, atk.stun);
  o.moveLock = Math.max(o.moveLock, atk.stun * 0.85);
  o.lastHitBy = a;
  o.flash = 0.16;

  state.hitStop = Math.max(state.hitStop, atk.hitstop);
  state.shake = Math.max(state.shake, atk.shake + (dmg > 12 ? 0.2 : 0));

  emit(state, {
    t: 'hit', a: a.index, o: o.index, heavy: atk.dmg > 12, shielded,
    x: (a.x + o.x) / 2, y: (a.y + o.y) / 2 + 1.4, z: (a.z + o.z) / 2,
    nx, nz, dmg
  });

  if (o.health <= 0) { o.health = 0; koFighter(state, o, a); }
}

/* ---------------------------------------------------------------------------
   KO / fall / respawn
   --------------------------------------------------------------------------- */
export function koFighter(state, f, by) {
  if (f.state === 'ko' || f.state === 'dead') return;
  f.lives--;
  f.state = 'ko';
  f.koT = 1.5;
  f.vx = rngRange(state.rng, -8, 8);
  f.vz = rngRange(state.rng, -8, 8);
  f.vy = 26;
  f.hitSet.clear();
  state.shake = 1.1;
  state.hitStop = Math.max(state.hitStop, 0.16);
  if (by && by !== f) by.kos++;
  emit(state, { t: 'ko', victim: f.index, by: (by && by !== f) ? by.index : -1, x: f.x, y: f.y + 1.2, z: f.z });
  emit(state, { t: 'announce', text: 'KNOCKOUT!', dur: 1.1, small: false });
}

export function koByFall(state, f) {
  if (f.state === 'ko' || f.state === 'dead') return;
  f.lives--;
  f.state = 'ko';
  f.koT = 1.2;
  f.vy = 0; f.vx = 0; f.vz = 0;
  emit(state, { t: 'fall', victim: f.index, x: f.x, y: Math.max(f.y, CFG.fallY + 2), z: f.z });
  emit(state, { t: 'announce', text: 'FALL!', dur: 0.9, small: true });
}

/* ---------------------------------------------------------------------------
   Abilities
   --------------------------------------------------------------------------- */
export function useAbility(state, f) {
  if (f.abilityCd > 0) return;
  f.abilityCd = f.def.abilityCd;
  const fx = Math.sin(f.facing), fz = Math.cos(f.facing);
  f.hitSet.clear();
  emit(state, { t: 'ability', i: f.index, charId: f.charId, x: f.x, y: f.y, z: f.z });

  switch (f.def.ability) {
    case 'smash': {
      f.vy = ABILITY.smash.vy;
      f.abilityActive = 'smash';
      f.abilityT = ABILITY.smash.t;
      f.moveLock = ABILITY.smash.moveLock;
      break;
    }
    case 'flash': {
      let bx = fx, bz = fz;
      if (!blinkSafe(f, bx, bz)) {
        const alt = pickBlinkDir(f, fx, fz);
        if (!alt) { f.abilityCd = 0.8; break; }
        bx = alt[0]; bz = alt[1];
      }
      const B = ABILITY.volt;
      const gx = groundYAt(f.x + bx * B.blink, f.z + bz * B.blink, f.y + 8);
      f.x += bx * B.blink; f.z += bz * B.blink;
      if (gx !== -Infinity && gx > f.y - 6) f.y = Math.max(f.y, gx);
      f.vx = bx * B.vx; f.vz = bz * B.vx;
      f.abilityActive = 'flash'; f.abilityT = B.t;
      f.invuln = Math.max(f.invuln, B.invuln);
      emit(state, { t: 'blink', i: f.index, x: f.x, y: f.y, z: f.z, charId: f.charId });
      for (const o of state.fighters) {
        if (o === f || o.state !== 'active') continue;
        const d = Math.hypot(o.x - f.x, o.z - f.z);
        if (d < B.radius && Math.abs(o.y - f.y) < B.vertical) {
          applyHit(state, f, o, { dmg:B.dmg, kb:B.kb, up:B.up, stun:B.stun, hitstop:0.06, shake:0.4, range:B.radius, sound:'hitHeavy' });
        }
      }
      state.shake = Math.max(state.shake, 0.35);
      break;
    }
    case 'phase': {
      const P = ABILITY.phantom;
      f.phaseT = P.phaseT;
      f.invuln = Math.max(f.invuln, P.invuln);
      f.speedBuff = Math.max(f.speedBuff, P.speedBuff);
      state.shake = Math.max(state.shake, 0.25);
      break;
    }
  }
}

export function minerSmash(state, f) {
  const R = ABILITY.smash.radius;
  state.shake = Math.max(state.shake, 1.0);
  state.hitStop = Math.max(state.hitStop, 0.09);
  emit(state, { t: 'smash', i: f.index, x: f.x, y: f.y + 0.3, z: f.z, charId: f.charId });
  for (const o of state.fighters) {
    if (o === f || o.state !== 'active') continue;
    const dx = o.x - f.x, dz = o.z - f.z;
    const d = Math.hypot(dx, dz);
    if (d < R && Math.abs(o.y - f.y) < ABILITY.smash.vertical) {
      const nx = dx / (d || 1), nz = dz / (d || 1);
      const dmgRatio = 1 - clamp(o.health / o.maxHealth, 0, 1);
      const scale = (1 + dmgRatio * 1.7) / o.def.weight;
      o.vx += nx * ABILITY.smash.kb * scale;
      o.vz += nz * ABILITY.smash.kb * scale;
      o.vy = Math.max(o.vy, ABILITY.smash.up * scale);
      o.health -= ABILITY.smash.dmg;
      o.dmgTaken += ABILITY.smash.dmg;
      f.dmgDealt += ABILITY.smash.dmg;
      o.hitstun = Math.max(o.hitstun, 0.4);
      o.moveLock = Math.max(o.moveLock, 0.35);
      o.flash = 0.16;
      emit(state, { t: 'hit', a: f.index, o: o.index, heavy: true, shielded: false,
                    x: o.x, y: o.y + 1.2, z: o.z, nx, nz, dmg: ABILITY.smash.dmg, smash: true });
      if (o.health <= 0) { o.health = 0; koFighter(state, o, f); }
    }
  }
}

/* ---------------------------------------------------------------------------
   Hazards — ported from checkHazards(f, dt)
   --------------------------------------------------------------------------- */
export function checkHazards(state, f, dt) {
  if (f.state !== 'active' || f.invuln > 0 || f.phaseT > 0) return;
  f.hazardCd = Math.max(0, f.hazardCd - dt);
  if (f.hazardCd > 0) return;

  const H = state.hazards;

  if (H.spinEnabled) {
    const by = f.y + 1.3;
    if (Math.abs(by - HAZARD.spinY) < HAZARD.spinVertical) {
      const ang = H.spinAngle;
      const ax = Math.sin(ang), az = Math.cos(ang);
      const localX = f.x * ax + f.z * az;
      const localZ = -f.x * az + f.z * ax;
      if (Math.abs(localX) < HAZARD.spinHalfLength && Math.abs(localZ) < HAZARD.spinHalfWidth) {
        const nx = f.x / (Math.hypot(f.x, f.z) || 1);
        const nz = f.z / (Math.hypot(f.x, f.z) || 1);
        let d = 9;
        if (f.shield > 0) { const a = Math.min(f.shield, d); f.shield -= a; d -= a; }
        f.health -= d; f.dmgTaken += d;
        f.vx += nx * 26; f.vz += nz * 26; f.vy = Math.max(f.vy, 14);
        f.hitstun = 0.4; f.moveLock = 0.35; f.flash = 0.16; f.hazardCd = 1.0;
        state.shake = Math.max(state.shake, 0.5);
        emit(state, { t: 'hazard', i: f.index, kind: 'spin', x: f.x, y: f.y + 1.2, z: f.z });
        if (f.health <= 0) { f.health = 0; koFighter(state, f, null); }
      }
    }
  }

  if (H.padsEnabled) {
    for (const p of H.pads) {
      if (!p.active) continue;
      if (Math.abs(f.x - p.x) < HAZARD.padHalf && Math.abs(f.z - p.z) < HAZARD.padHalf && f.y < HAZARD.padMaxY) {
        let nx = (f.x - p.x), nz = (f.z - p.z);
        if (!nx) nx = rngRange(state.rng, -0.3, 0.3);
        if (!nz) nz = rngRange(state.rng, -0.3, 0.3);
        const l = Math.hypot(nx, nz) || 1;
        let d = 8;
        if (f.shield > 0) { const a = Math.min(f.shield, d); f.shield -= a; d -= a; }
        f.health -= d; f.dmgTaken += d;
        f.vx += nx / l * 20; f.vz += nz / l * 20;
        f.vy = Math.max(f.vy, 20);
        f.hitstun = 0.35; f.moveLock = 0.3; f.flash = 0.16; f.hazardCd = 0.9;
        state.shake = Math.max(state.shake, 0.45);
        emit(state, { t: 'hazard', i: f.index, kind: 'pad', x: f.x, y: f.y + 0.4, z: f.z });
        if (f.health <= 0) { f.health = 0; koFighter(state, f, null); }
      }
    }
  }
}

/* ---------------------------------------------------------------------------
   Powerups
   --------------------------------------------------------------------------- */
export function spawnPowerup(state) {
  const t = POWER_TYPES[rngInt(state.rng, 0, POWER_TYPES.length - 1)];
  const spot = POWER_SPOTS[rngInt(state.rng, 0, POWER_SPOTS.length - 1)];
  const groundHere = groundYAt(spot[0], spot[2], 200);
  const safeMinY = (groundHere === -Infinity) ? spot[1] + 1.4 : groundHere + 1.4;
  const finalY = Math.max(spot[1] + 1.4, safeMinY);
  const p = {
    id: state.nextPowerupId++,
    type: t, x: spot[0], y: finalY, z: spot[2],
    life: POWER_LIFE, spin: rngRange(state.rng, 0.8, 1.6)
  };
  state.powerups.push(p);
  emit(state, { t: 'powerSpawn', id: p.id, powerId: t.id, x: p.x, y: p.y, z: p.z });
  return p;
}

export function applyPowerup(state, f, t) {
  if (t.id === 'spark')  f.speedBuff = t.dur;
  if (t.id === 'power')  f.damageBuff = t.dur;
  if (t.id === 'shield') f.shield = 40;
  if (t.id === 'dash')   { f.dashBuff = t.dur; f.dashCd = 0; }
  emit(state, { t: 'powerup', i: f.index, powerId: t.id, name: t.name });
}

/* ---------------------------------------------------------------------------
   Match end
   --------------------------------------------------------------------------- */
export function endMatch(state) {
  if (state.over) return;
  state.over = true;
  const alive = state.fighters.filter(f => f.lives > 0);
  let winner = alive.length > 0 ? alive[0] : null;
  if (alive.length > 1) {
    alive.sort((a, b) => {
      if (b.lives !== a.lives) return b.lives - a.lives;
      return a.dmgTaken - b.dmgTaken;
    });
    winner = alive[0];
  }
  state.winner = winner ? winner.index : -1;
  state.winnerId = winner ? winner.id : null;
  state.phase = PHASE.OVER;
  emit(state, { t: 'gameover', winner: state.winner });
}

export function checkMatchEnd(state) {
  const alive = state.fighters.filter(f => f.lives > 0);
  if (alive.length <= 1) endMatch(state);
}

/* ===========================================================================
   stepMatch — one fixed server tick. This is the authoritative game loop body.
   `ctrls` is an array (indexed by fighter index) of input control objects.
   Returns the event list produced by this tick.
   =========================================================================== */
export function stepMatch(state, dt, ctrls) {
  state.events = [];
  if (state.phase === PHASE.OVER) { state.tick++; return state.events; }

  state.time += dt;

  /* Global hit-stop time scaling — identical to the original updateWorld(). */
  let sdt = dt;
  if (state.hitStop > 0) { state.hitStop -= dt; sdt = dt * 0.12; }

  /* Hazards tick first (matches the original ordering). */
  if (state.hazards.spinEnabled) state.hazards.spinAngle += HAZARD.spinSpeed * sdt;
  if (state.hazards.padsEnabled) {
    for (const p of state.hazards.pads) {
      p.timer -= sdt;
      if (p.timer <= 0) {
        p.phase = !p.phase;
        p.timer = p.phase ? HAZARD.padActiveTime : HAZARD.padIdleTime;
        if (p.phase) emit(state, { t: 'padUp', x: p.x, z: p.z });
        p.active = p.phase;
      }
    }
  }

  /* Countdown */
  if (state.phase === PHASE.COUNTDOWN) {
    const before = Math.ceil(state.countdown);
    state.countdown -= sdt;
    const after = Math.ceil(state.countdown);
    if (after !== before && after > 0) emit(state, { t: 'announce', text: String(after), dur: 0.7, small: false });
    if (state.countdown <= 0) {
      state.countdown = 0;
      state.phase = PHASE.PLAYING;
      emit(state, { t: 'announce', text: 'FIGHT!', dur: 0.9, small: false });
    }
  } else if (state.phase === PHASE.PLAYING) {
    state.matchTime -= sdt;
    if (state.matchTime <= 0) { state.matchTime = 0; endMatch(state); }
  }

  /* Fighters */
  for (let i = 0; i < state.fighters.length; i++) {
    const f = state.fighters[i];
    let ctrl = ctrls[i] || EMPTY_CTRL;
    if (state.phase === PHASE.COUNTDOWN && f.state === 'active') ctrl = EMPTY_CTRL;
    if (state.phase === PHASE.OVER) ctrl = EMPTY_CTRL;
    stepFighter(state, f, sdt, ctrl);
    if (f.state === 'dead') {
      /* a fighter only reaches 'dead' through koFighter/koByFall -> check end */
      if (!state.over) checkMatchEnd(state);
    }
  }

  /* Fighter-vs-fighter body collision (minD 1.25) — after all steps. */
  for (let i = 0; i < state.fighters.length; i++) {
    for (let j = i + 1; j < state.fighters.length; j++) {
      const a = state.fighters[i], b = state.fighters[j];
      if (a.state !== 'active' || b.state !== 'active') continue;
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      const minD = 1.25;
      if (d < minD && d > 0.001 && Math.abs(a.y - b.y) < 2.2) {
        const push = (minD - d) * 0.5;
        const nx = dx / d, nz = dz / d;
        a.x -= nx * push; a.z -= nz * push;
        b.x += nx * push; b.z += nz * push;
        const rel = Math.hypot(a.vx - b.vx, a.vz - b.vz);
        if (rel > 7 && state.time - (a._bumpT === undefined ? -9 : a._bumpT) > 0.22) {
          a._bumpT = state.time; b._bumpT = state.time;
          const mag = clamp(rel / 24, 0, 1);
          emit(state, { t: 'bump', x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 + 1.0, z: (a.z + b.z) / 2, nx, nz, mag });
          state.shake = Math.max(state.shake, 0.10 + mag * 0.20);
        }
      }
    }
  }

  /* Powerup spawn + lifetime + pickup */
  if (state.phase === PHASE.PLAYING && !state.over) {
    state.powerSpawnTimer -= sdt;
    if (state.powerSpawnTimer <= 0 && state.powerups.length < MAX_POWERUPS) {
      spawnPowerup(state);
      state.powerSpawnTimer = rngRange(state.rng, 6.5, 10.5);
    }
  }
  for (let i = state.powerups.length - 1; i >= 0; i--) {
    const p = state.powerups[i];
    p.life -= sdt;
    if (p.life <= 0) { state.powerups.splice(i, 1); continue; }
    /* the pickup test uses the power-up's BOB position, exactly as the
       original did (mesh.position.y = pos.y + sin(time*2 + i)*0.22) */
    const bobY = p.y + Math.sin(state.time * 2 + i) * 0.22;
    for (const f of state.fighters) {
      if (f.state !== 'active') continue;
      const dx = f.x - p.x, dz = f.z - p.z, dy = f.y + 1 - bobY;
      if (Math.hypot(dx, dz) < 1.5 && Math.abs(dy) < 2.0) {
        applyPowerup(state, f, p.type);
        state.powerups.splice(i, 1);
        break;
      }
    }
  }

  state.tick++;
  return state.events;
}

export const EMPTY_CTRL = { dirX:0, dirZ:0, jump:false, jumpPressed:false, quick:false, heavy:false, dash:false, ability:false };
export function blankCtrl() { return { dirX:0, dirZ:0, jump:false, jumpPressed:false, quick:false, heavy:false, dash:false, ability:false }; }

/* ===========================================================================
   Snapshot / restore — compact wire format.
   =========================================================================== */

/* Field list is fixed and documented in protocol.js. Keeping it as an ordered
   array (not an object) is what keeps a 4-player snapshot small enough to
   broadcast 20x/second. */
export const FIGHTER_FIELDS = [
  'x','y','z','vx','vy','vz','facing',
  'health','lives','state','onGround','jumpsLeft',
  'attackType','attackT','attackPhase','hitstun','moveLock',
  'dashT','abilityActive','abilityT','abilityCd','dashCd',
  'invuln','phaseT','shield','speedBuff','damageBuff','dashBuff',
  'koT','flash','hazardCd','landSquash','landSquashAmt',
  'kos','falls','dmgDealt','dmgTaken'
];

const STATE_CODES = { active:0, ko:1, respawning:2, dead:3 };
const STATE_NAMES = ['active','ko','respawning','dead'];
const ATTACK_CODES = { quick:1, heavy:2 };
const ATTACK_NAMES = [null,'quick','heavy'];
const ABILITY_CODES = { '':0, smash:1, flash:2, spark:3, phase:4 };
const ABILITY_NAMES = ['','smash','flash','spark','phase'];
const PHASE_CODES = { startup:0, active:1, recovery:2, '':3 };
const PHASE_NAMES = ['startup','active','recovery',''];

export function serializeFighter(f) {
  return [
    f.id,
    f.charId,
    +f.x.toFixed(3), +f.y.toFixed(3), +f.z.toFixed(3),
    +f.vx.toFixed(2), +f.vy.toFixed(2), +f.vz.toFixed(2),
    +f.facing.toFixed(3),
    Math.round(f.health * 10) / 10,
    f.lives,
    STATE_CODES[f.state] || 0,
    f.onGround ? 1 : 0,
    f.jumpsLeft,
    ATTACK_CODES[f.attackType] || 0,
    +f.attackT.toFixed(3),
    PHASE_CODES[f.attackPhase] === undefined ? 3 : PHASE_CODES[f.attackPhase],
    +f.hitstun.toFixed(3), +f.moveLock.toFixed(3),
    +f.dashT.toFixed(3),
    ABILITY_CODES[f.abilityActive] || 0,
    +f.abilityT.toFixed(3), +f.abilityCd.toFixed(2), +f.dashCd.toFixed(2),
    +f.invuln.toFixed(2), +f.phaseT.toFixed(2), Math.round(f.shield * 10) / 10,
    +f.speedBuff.toFixed(2), +f.damageBuff.toFixed(2), +f.dashBuff.toFixed(2),
    +f.koT.toFixed(2), +f.flash.toFixed(2), +f.hazardCd.toFixed(2),
    +f.landSquash.toFixed(2), +f.landSquashAmt.toFixed(2),
    f.kos, f.falls, Math.round(f.dmgDealt), Math.round(f.dmgTaken)
  ];
}

export function deserializeFighter(arr) {
  return {
    id: arr[0], charId: arr[1],
    x: arr[2], y: arr[3], z: arr[4],
    vx: arr[5], vy: arr[6], vz: arr[7],
    facing: arr[8],
    health: arr[9], lives: arr[10],
    state: STATE_NAMES[arr[11]] || 'active',
    onGround: arr[12] === 1, jumpsLeft: arr[13],
    attackType: ATTACK_NAMES[arr[14]] || null,
    attackT: arr[15], attackPhase: PHASE_NAMES[arr[16]] || '',
    hitstun: arr[17], moveLock: arr[18], dashT: arr[19],
    abilityActive: ABILITY_NAMES[arr[20]] || '',
    abilityT: arr[21], abilityCd: arr[22], dashCd: arr[23],
    invuln: arr[24], phaseT: arr[25], shield: arr[26],
    speedBuff: arr[27], damageBuff: arr[28], dashBuff: arr[29],
    koT: arr[30], flash: arr[31], hazardCd: arr[32],
    landSquash: arr[33], landSquashAmt: arr[34],
    kos: arr[35], falls: arr[36], dmgDealt: arr[37], dmgTaken: arr[38]
  };
}

export function serializePowerups(state) {
  return state.powerups.map(p => [p.id, p.type.id, +p.x.toFixed(2), +p.y.toFixed(2), +p.z.toFixed(2), +p.life.toFixed(1)]);
}

export function serializeHazards(state) {
  return {
    a: +state.hazards.spinAngle.toFixed(4),
    s: state.hazards.spinEnabled ? 1 : 0,
    p: state.hazards.padsEnabled ? 1 : 0,
    pads: state.hazards.pads.map(p => [p.x, p.z, p.active ? 1 : 0, p.phase ? 1 : 0])
  };
}
