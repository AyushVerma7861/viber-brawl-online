# Viber Brawl — Real-Time Online Multiplayer

Cloudflare-native multiplayer for the existing Viber Brawl game.
**Worker + Durable Objects + WebSockets.** No VPS, no Firebase, no Colyseus, no Socket.io, no Supabase.

> **Solo mode is untouched.** `public/viber-brawl-v6-original.html` is a byte-identical copy of your file
> (md5 `3676261bea7f36177d02bc63854e52f9`). The multiplayer build adds to a *copy* of it; the build
> script refuses to write output unless every byte of your original script survives verbatim.

---

## 1. Files created

```
multiplayer implementation/
├── wrangler.toml                        Worker config + Durable Object binding + migrations
├── package.json                         wrangler / playwright-core dev deps
├── build-client.mjs                     assembles the multiplayer page from the original (never edits it)
│
├── public/                              ← static assets (served by the Worker)
│   ├── viber-brawl-v6-original.html     YOUR FILE, byte-identical, READ-ONLY
│   ├── viber-brawl-multiplayer.html     ← the deliverable: original + multiplayer layer
│   ├── _headers                         CORS for the shared core (cross-origin Pages use)
│   └── shared/
│       └── sim.js                       ★ THE shared deterministic gameplay core
│
├── multiplayer/
│   ├── src/
│   │   ├── worker.js                    Worker entry: /ws routing, room probing, assets
│   │   ├── BattleRoom.js                Durable Object = one battle room + 60 Hz game loop
│   │   ├── gameState.js                 room model: players, lobby, host, standings, disconnect
│   │   └── protocol.js                  wire format, message types, room codes, limits
│   └── client/
│       ├── mp-layer.js                  the client layer (input, prediction, interpolation, FX, UI)
│       ├── mp-ui.html                   the two new screens (create/join, lobby)
│       └── mp.css                       namespaced styles for those screens
│
└── test/
    ├── headless-sim-test.mjs            40 assertions: the gameplay core with no browser
    ├── two-client-test.mjs              36 assertions: two WebSocket clients vs the live Worker
    ├── two-browser-test.mjs             40+ assertions: two real browsers in one arena
    └── artifacts/                        screenshots captured by the browser test
```

## 2. Files modified

**None of yours.** The original HTML is never written to. Everything is additive:

| What | How |
|---|---|
| `viber-brawl-multiplayer.html` | generated — original file + 3 injected blocks |
| menu | a `MULTIPLAYER` button is inserted after `PLAY` at runtime |
| `updateWorld` | wrapped: multiplayer frames divert to the MP updater, solo falls straight through |
| `togglePause` | wrapped: no-op online (one client may never freeze an online match) |
| `resetToMenu`, `showResults` | wrapped for online lifecycle / server standings |

## 3. Exact code changes

### 3a. The one real architectural change: a shared gameplay core

Your `stepFighter(f, dt, ctrl)` was the centre of the simulation, but it was fused to rendering
(particles, `SFX`, `Game.shake`, `announce`, `THREE.Vector3`). Multiplayer needs those rules to run
somewhere with no browser — so they were **extracted, not duplicated**:

`public/shared/sim.js` is imported by **both** the Durable Object and the browser. There is exactly
one copy of the rules. It contains:

| Original | In `sim.js` |
|---|---|
| `CFG`, `ATTACKS` | `CFG`, `ATTACKS`, `ABILITY` (the values inlined in `useAbility`) |
| `CHARACTERS[i].speed/jump/health/weight/damageMul/abilityCd` | `CHAR_STATS` |
| `buildArena()` slab rectangles | `ARENA_PLATFORMS` (7 collision rects) |
| `groundYAt(x,z,fromY)` | `groundYAt(x,z,fromY,platforms)` — identical logic |
| `stepFighter(f,dt,ctrl)` | `stepFighter(state, f, dt, ctrl)` — same order, same constants |
| `startAttack` / `tryHit` / `applyHit` | identical, `Save.*` stat writes removed |
| `koFighter` / `koByFall` | identical |
| `useAbility` / `minerSmash` / `blinkSafe` / `pickBlinkDir` | identical |
| `checkHazards` | identical (spin rod + 4 spike pads) |
| `spawnPowerup` / `applyPowerup` | identical, plus a stable powerup `id` for client mesh sync |
| `updateWorld` body-order | `stepMatch(state, dt, ctrls)` — one fixed authoritative tick |

The three real differences, all deliberate:

1. **FX became events.** Where the original called `burst()` / `SFX.hit()` / `announce()`, `sim.js`
   pushes `{t:'hit', …}` onto `state.events`. The client replays each event through the *original*
   FX functions, so hits still look and sound exactly as before.
2. **Randomness is seeded.** Every `Math.random()` / `rand()` / `randi()` that affects gameplay
   (powerup spawn + type, spawn point, KO tumble, pad knockback) now draws from a `mulberry32` PRNG
   owned by the server. Two runs of the same seed are byte-identical (asserted by test 11).
3. **No AI, structurally.** `sim.js` has no `aiControl`, no `ai` field, no bot concept. A
   disconnected human cannot be replaced because there is nothing to replace them with.

### 3b. Durable Object = one battle room

```
Browser ──WebSocket──► Worker ──stub.fetch──► BattleRoom (Durable Object)
                                                    │  60 Hz authoritative loop
                                                    └── N player sockets
```

* Room code **is** the object name: `env.BATTLE_ROOM.idFromName('X7K4Q')` → every player typing
  `X7K4Q` lands on the same single-threaded object. The Worker mints the code on create and passes it
  into the forwarded request, so the code and the object identity can never drift apart.
* Tick rate **60 Hz** fixed `dt = 1/60`; snapshots broadcast every 3rd tick → **20 Hz**.
* Hit-stop is applied exactly as in the original: `sdt = dt * 0.12` while `hitStop > 0`.
* A **hard cap of 6 catch-up steps per loop**, then the backlog is dropped — a stalled object cannot
  spiral into a death loop.
* The loop runs only while a match is live and stops when the room empties.
* Lobby identity (name / Viber / host) is persisted to DO storage; **live positions never are**, so
  an evicted object can never resurrect a stale fighter.

### 3c. Protocol

Client → server (`multiplayer/src/protocol.js`):

```
{t:'hello', name, token?}                     must be the first frame
{t:'select', charId}                          server enforces uniqueness
{t:'ready', ready}
{t:'start'}
{t:'input', seq, dirX, dirZ, jump, jumpPressed, quick, heavy, dash, ability}
{t:'leave'}  {t:'rematch'}  {t:'ping', ts}
```

**That is the complete list.** There is no client message that carries position, damage, HP, KO,
stocks or a winner. Unknown fields are ignored; `seq` must strictly increase or the frame is dropped.

**One-shot inputs are latched and cleared — this is not optional.** Five fields in an input frame
are *edges*, not states: `jumpPressed`, `quick`, `heavy`, `dash`, `ability`. In the original game
`clearEdges()` runs once per frame, so each lives for exactly one frame. The server does the
equivalent: `_onMessage` ORs each edge into `player.pendingEdges`, `_stepOnce` feeds those into the
tick and then clears them.

Without that, two things break, and both were real bugs:

* **The press repeats.** `player.lastCtrl` persists between ticks, and the client only sends every
  33 ms (≈2 ticks at 60 Hz). Reading edges straight off `lastCtrl` meant one Space press fired the
  ground jump on tick 1 and the *air* jump on tick 2 — so the double jump was spent before the player
  asked for it, and pressing Space again in mid-air did nothing.
* **The press is lost.** If a neutral frame arrives before the next tick it overwrites `lastCtrl`,
  and the press never fires at all.

Continuous state (`dirX`, `dirZ`, and held `jump`) still comes straight from the latest frame.
The rule in general: **every edge-triggered input needs a server-side equivalent of `clearEdges()`.**

Server → client: `welcome`, `lobby`, `snapshot`, `matchend`, `playerGone`, `error`, `pong`.

Snapshot (compact, field-ordered arrays):

```js
{ t:'snapshot', tick, ack, phase, matchTime, countdown, time, shake, winnerId,
  players:  [ [id, charId, x,y,z, vx,vy,vz, facing, health, lives, state,
               onGround, jumpsLeft, attackType, attackT, attackPhase,
               hitstun, moveLock, dashT, abilityActive, abilityT, abilityCd,
               dashCd, invuln, phaseT, shield, speedBuff, damageBuff, dashBuff,
               koT, flash, hazardCd, landSquash, landSquashAmt,
               kos, falls, dmgDealt, dmgTaken], … ],
  powerups: [ [id, typeId, x, y, z, life], … ],
  hazards:  { a: spinAngle, s: spinOn, p: padsOn, pads:[[x,z,active,phase],…] },
  events:   [ {t:'hit',…}, {t:'ko',…}, {t:'jump',…}, … ] }
```

`ack` is the highest input `seq` the server has consumed **for that specific client**, so the base
payload is built once and only `ack` differs per recipient.

### 3d. Client: prediction + interpolation + reconciliation

* **Local player — predict-and-replay.** Every frame the client steps its own `SimFighter` with the
  local control frame and records `{seq, ctrl, dt}`. When a snapshot arrives it resets that fighter
  to the server state at `ack`, then re-applies every frame the server has not consumed yet.
* **Correction is smooth.** The visual delta between "where I was rendering" and "where the replay
  puts me" becomes a `renderOffset` that decays at 13/s — no jitter. Above **3.0 units** it is a hard
  snap instead (a genuine desync, not drift).
* **Remote players — interpolation.** Snapshots are buffered per player and rendered **110 ms in the
  past**, interpolating position, velocity and facing (`angLerp`) between the two bracketing frames.
* **No positional assumptions.** Everything is keyed by `playerId`, never by array index, so a
  removed fighter cannot shift anyone else's state.
* **Rendering is the original.** Each fighter is a real `Fighter` built by the original
  `buildViber()`, animated by the original `updateModelTransform()`. Multiplayer only supplies the
  state; the KO tumble, walk cycle, attack arcs, invulnerability flicker and ghost bob are unchanged.

### 3e. Disconnect policy (implemented in `gameState.js` → `removePlayer`)

| Rule | Implementation |
|---|---|
| Never replace a disconnected player with AI | `sim.js` contains no AI at all — structurally impossible |
| Never convert a human into a bot | no `isBot`/`ai` flag exists anywhere in the online path |
| Never let AI take a human slot | fighters are only created from the roster at match start |
| Remove them cleanly | fighter marked `removed`, `lives = 0`, `state = 'dead'` → disappears |
| Remaining humans continue | the loop keeps ticking the survivors |
| Only one human left → end + declare winner | `endMatch(remainingId, 'opponent-left')` |
| Host leaving must not break the room | `isHost` is lobby-only; promotion happens in `removePlayer` |
| A network drop must not duplicate/corrupt | identity is keyed by `playerId`; a stale socket's close event is ignored if a newer socket already owns the identity |
| Safe reconnect, no AI replacement | the token restores the **lobby slot only**; a reconnecting player waits for the next match rather than re-inserting a fighter mid-match |

Verified live by the browser test: closing window B mid-match leaves **1** fighter in the arena, ends
the match, and declares A the winner.

### 3f. Lobby / room lifecycle

create room → join by code → pick Viber (server-enforced uniqueness) → ready → start →
countdown → fight → `matchend` + standings → **rematch returns everyone to the same room** →
leave → room reaped when empty.

---

## 4. Cloudflare setup steps

1. `npm install`
2. `npx wrangler login` (only needed to deploy; `wrangler dev` runs entirely locally)
3. Deploy: `npx wrangler deploy`
   → prints `https://viber-brawl-multiplayer.<your-subdomain>.workers.dev`
4. The Worker serves the game **and** the WebSocket from that one origin, so the deployed page works
   with no configuration.

**If you want to keep the game on Cloudflare Pages** (your existing front end) and only put the
socket on the Worker, copy `viber-brawl-multiplayer.html` and `shared/sim.js` to your Pages site and
point the page at the Worker:

```
https://your-pages-site/viber-brawl-multiplayer.html?mp=https://viber-brawl-multiplayer.<sub>.workers.dev
```

The `?mp=` value is remembered in `localStorage`. `public/_headers` already sets
`Access-Control-Allow-Origin: *` on `/shared/sim.js` for that case.

**Durable Objects on the free plan use SQLite-backed storage** — that is what
`new_sqlite_classes = ["BattleRoom"]` in `wrangler.toml` selects. On a paid plan you may switch to
`new_classes`.

## 5. Wrangler configuration

`wrangler.toml` at the project root:

```toml
name = "viber-brawl-multiplayer"
main = "multiplayer/src/worker.js"
compatibility_date = "2025-07-18"

[durable_objects]
bindings = [
  { name = "BATTLE_ROOM", class_name = "BattleRoom" }
]

[[migrations]]
tag = "v1"
new_sqlite_classes = ["BattleRoom"]

[assets]
directory = "public"
binding = "ASSETS"

[observability]
enabled = true

[vars]
SIM_DEBUG = "0"      # set to "1" to log why each swing connected or missed
```

**`SIM_DEBUG = "1"`** makes the Durable Object print, for every swing, the
distance, height difference, facing angle, the cone `dot` and the value it
needed to beat. That is how the "my attacks do nothing" class of bug is
diagnosed — it is how the acceptance test found that the test fighter was
simply facing away from its opponent. Leave it at `"0"` in production; when off
it costs one boolean test per tick.

## 6. Durable Object binding required

One binding, name **`BATTLE_ROOM`**, class **`BattleRoom`**, exposed to the Worker as
`env.BATTLE_ROOM`. `worker.js` re-exports the class (`export { BattleRoom }`) as the runtime requires.

```js
const stub = env.BATTLE_ROOM.get(env.BATTLE_ROOM.idFromName(ROOM_CODE));
return stub.fetch(request);          // 101 + webSocket
```

## 7. Deployment commands

```bash
npm install                     # wrangler + playwright-core
npx wrangler dev                # local dev on http://127.0.0.1:8787
npx wrangler deploy             # ship it
npx wrangler tail               # live logs: joins, disconnects, match results
```

Rebuild the client page after editing anything in `multiplayer/client/`:

```bash
node build-client.mjs
```

## 8. Local testing with two browser windows

```bash
npx wrangler dev                       # terminal 1
```

Then **window 1**: `http://127.0.0.1:8787/viber-brawl-multiplayer.html`
→ `MULTIPLAYER` → type a name → `CREATE ROOM` → note the 5-character code.

**Window 2**: `http://127.0.0.1:8787/viber-brawl-multiplayer.html?room=CODE`
→ it auto-joins. (Or `MULTIPLAYER` → type the code → `JOIN ROOM`.)

Both pick a different Viber → `READY` on both → `START MATCH` → you should see two real Vibers in the
real arena, moving and fighting in sync.

Useful console handles in either window: `__VB_MP.snap`, `__VB_MP.playerFighter`, `__VB_MP.rtt`.

### Automated versions of the same thing

```bash
npm run verify:sim        # gameplay core, no browser        (40 checks)
npx wrangler dev          # must be running for the next two
npm run verify:net        # two WebSocket clients            (36 checks)
npm run verify:browser    # two real browsers                (44 checks)

npm run verify            # all three, in that order
npm run build             # rebuild the multiplayer page after editing client files
```

`npm run verify` needs `wrangler dev` running in another terminal; the sim suite
does not.

## 9. How to verify the WebSocket connection

* **In the page** — the lobby header shows `connecting… → handshaking… → connected`, and
  `__VB_MP.rtt` holds a live round-trip time (ping every 2 s).
* **In DevTools** — Network → `WS` → `/ws?room=XXXXX`; the Messages pane shows `hello`, `welcome`,
  `lobby`, then a `snapshot` roughly every 50 ms and an `input` roughly every 33 ms.
* **From a shell** — `npx wrangler tail` prints room joins, match starts and every removal.
* **Probe without a browser:**

```bash
curl -s http://127.0.0.1:8787/api/health
curl -s http://127.0.0.1:8787/api/room/X7K4Q      # {"exists":true|false,...}
```

## 10. Known limitations

* **Spectators.** Joining a room whose match is already running puts you in the lobby, not the
  arena — you are told "you will join the next one". Mid-match spectating is not implemented.
* **Reconnect resumes the lobby slot only.** A reconnecting player does not re-enter a live match
  (that would be the mid-match fighter insertion the spec forbids). They rejoin for the next match.
* **Host migration is lobby-only.** The simulation never needed a host, so a host leaving is
  invisible to gameplay; the next connected player just gains the (cosmetic) host badge.
* **No lag compensation / rewind.** A hit is judged on the server's current positions. At 100 ms RTT
  you will occasionally trade where you expected to win. Server-side rewind is the standard next step.
* **Prediction covers movement and your own fighter only.** Power-up pickups and hazard hits are
  server-decided and land ~1 snapshot later than they would locally.
* **Fixed 60 Hz tick, 20 Hz snapshots.** Fine on a Durable Object; not tuned for >4 players or
  >150 ms RTT.
* **Room codes are ephemeral.** They live in Durable Object storage and are reaped after 15 minutes
  empty. There is no global room directory — by design (no matchmaking).
* **Viber uniqueness is strict.** If all four are taken, a fifth player cannot join (the room caps at
  four anyway).
* **`wrangler dev` was run as a single instance.** A real deploy should be smoke-tested once against
  the production Worker, since Miniflare and production are not identical runtimes.
* **Three Windows-only binaries are pinned in `devDependencies`**
  (`@esbuild/win32-x64`, `@cloudflare/workerd-windows-64`, `@img/sharp-win32-x64`). npm failed to
  resolve them as optional transitive dependencies of wrangler in this environment, which broke
  `wrangler dev` with "package could not be found". They are harmless elsewhere but are not needed
  on macOS/Linux — delete them from `package.json` if you move the project to another machine.
* **`npm audit` has not been run.** wrangler 3.114 reports an available update to 4.x; upgrading is
  a separate, unverified change.

## 11. What remains to be migrated

The staged plan you set out is complete through **Phase 5's core**, with these gaps:

| Phase | Status |
|---|---|
| **1** Worker · Durable Object · WebSocket · create/join/leave · player list · ready | **done, verified** |
| **2** real Viber models · two windows see each other · movement sync · character select sync | **done, verified in two real browsers** |
| **3** jump · dash · attacks · abilities · damage · knockback · hitstun | **done — server-authoritative from the first tick, FX replayed client-side** |
| **4** stocks · KO · fall · respawn · hazards · powerups · timer · victory | **done** |
| **5** interpolation · prediction · reconciliation · disconnect cleanup · rematch · polished lobby | **done** except: reconnect-into-live-match, mid-match spectating, lag compensation |

Still open, in priority order:

1. **Lag compensation / server rewind** for hit resolution.
2. **Reconnect into a live match** (needs a "re-admit as a fresh fighter" design that cannot duplicate).
3. **Mid-match spectating** (camera + read-only HUD).
4. **Scale testing** — 4 humans, long matches, memory per room, DO cost profile.
5. **Team/stock-share modes, ranked rooms, a room browser** — all explicitly out of scope for now.

---

## Verification status

All three suites pass against the shipping configuration.

| Suite | Checks | What it proves |
|---|---|---|
| `headless-sim-test.mjs` | 40 pass | the shared core reproduces your arena geometry, physics, combat, KO, stocks, respawn, hazards, power-ups, timer and winner with **no browser**; two runs of the same seed are byte-identical; **no AI hook exists** |
| `two-client-test.mjs` | 36 pass | against a **live Worker**: create room, bad-code rejection, join by code, server-enforced Viber uniqueness, ready/start, a steady 20 Hz snapshot stream, real cross-client movement, injected cheat fields rejected, the full disconnect policy, and the room surviving the creator leaving |
| `two-browser-test.mjs` | 44 pass | **two isolated real browsers** driven through the real UI |

Measured output from the final `two-browser-test.mjs` run:

```
[6] both pages built the REAL Vibers inside the REAL arena
    arena is the real one (7 platforms)         7
    Vibers are full models, not placeholders    miner:28meshes  volt:27meshes
    both Vibers attached to the live scene      2
[7] A moves, B watches A's Viber move
    A's own Viber moved                         19.11 units
    B SAW A's Viber move                        19.14 units
    both windows agree on A's position          dx=0.02  dz=0.03
    both windows agree on the server tick       341 vs 341
[8] combat
    closest approach                            1.44 units
    server-registered attack windows            72
    B's health (server-authoritative)           95 -> 69.1
    A credited with damage dealt                26.0
[10] disconnect policy, live
    fighters left in the arena                  1
    fighter object created for the leaver       none
    A declared the winner                       yes
    standings mark the leaver as disconnected   yes
```

Screenshots of both windows are in `test/artifacts/` (`client-A.png`,
`client-B.png`, `client-A-fight.png`, `client-A-results.png`).

**Honest statement of completeness:** two separate browser clients have been observed joining the
same room and seeing each other's real Viber moving (19.11 units of travel reproduced on the other
screen to within 0.03) and fighting (one client's attacks driving the other's authoritative health
from 95 to 69.1) in the real Viber Brawl arena, with the server authoritative over the outcome.
Solo mode is byte-identical to the file you supplied. The gaps listed in §10 and §11 are real and
are not claimed as finished.

One behaviour is worth knowing, because it caught the test harness before it could catch a player:
the original `startAttack` only auto-faces a target that is already roughly in front of you, and
`tryHit` only connects inside a forward cone. Standing still with your opponent behind you and
mashing attack is *supposed* to miss — online exactly as in solo. That was preserved deliberately.
