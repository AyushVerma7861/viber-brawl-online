/* =============================================================================
   BattleRoom.js — one Cloudflare Durable Object = exactly one battle room.

     Browser
        ↓  (WebSocket)
     Cloudflare Worker
        ↓  (stub.fetch -> Durable Object)
     DurableObject = Battle Room  ──►  authoritative 60Hz simulation
        ↓
     N player sockets

   Responsibilities (all of them authoritative):
     * match state, players, simulation, combat, gameplay collisions,
       powerups, hazards, stocks, respawns, timer, match end, room state.

   Explicitly NOT responsibilities:
     * rendering, camera, animation, particles, sound, UI, interpolation.

   DISCONNECT POLICY (hard requirement):
     * A dropped human is removed from the room and from the live match.
     * Nothing in this file can create, promote or hand control to a bot.
       `sim.js` contains no AI at all, so an AI substitute is structurally
       impossible, not merely disabled by a flag.
     * The match keeps running for the remaining humans. If only one human is
       left, the server ends the match and declares them the winner.
     * The room never depends on a particular browser being the "host".
   ============================================================================= */

import { recordMatch, recordEvents, hasDb } from './db/index.js';
import { awardForAccount } from './progression/index.js';
import {
  TICK_MS, TICK_HZ, SNAPSHOT_EVERY, MAX_PLAYERS,
  C2S, S2C, ERR,
  isValidRoomCode, isValidSeq, normalizeCtrl, sanitizeName, randomRoomCode
} from './protocol.js';
import { RoomState } from './gameState.js';
import {
  PHASE, CFG, CHAR_STATS, CHAR_ORDER, EMPTY_CTRL, SIM_DEBUG,
  stepMatch, serializeFighter, serializePowerups, serializeHazards
} from '../../public/shared/sim.js';

/* Shared frozen fallback for a player with no latched presses yet. */
const EMPTY_EDGES = Object.freeze({ jumpPressed: false, quick: false, heavy: false, dash: false, ability: false });

/** Header values are latin-1; names travel percent-encoded. Never throw on a malformed value. */
function safeHeaderDecode(v) {
  if (!v) return null;
  try { return decodeURIComponent(v).slice(0, 32); } catch (e) { return String(v).slice(0, 32); }
}

/** Read the identity the Worker resolved and attach it to a player record. */
function applyIdentity(p, identity) {
  if (!p || !identity) return;
  p.accountId = identity.accountId || null;
  p.guestId = identity.guestId || null;
  if (identity.displayName) p.displayName = identity.displayName;
}

export class BattleRoom {  constructor(ctx, env) {
    this.ctx = ctx;
    this.env = env;
    this.storage = ctx.storage;

    /* Optional hit-resolution tracing. Set SIM_DEBUG = "1" in wrangler.toml
       [vars] (or in the dashboard) and `wrangler tail` will print why a swing
       connected or missed. Off by default. */
    if (env && env.SIM_DEBUG === '1') SIM_DEBUG.on = true;

    this.code = null;
    this.room = null;
    this.sockets = new Map();        /* playerId -> WebSocket                 */
    this.socketPlayer = new WeakMap(); /* WebSocket -> playerId               */
    this.tickTimer = null;
    this.acc = 0;
    this.lastTickMs = 0;
    this.snapshotAcc = 0;
    this.pendingEvents = [];
    this.matchOverBroadcastAt = 0;
    this.rng = Math.random;          /* room-code generation only             */
    this.inited = false;

    /* Cheap safety net: if the object is evicted with a room that still has
       players, the alarm restores the loop. Alarms are NOT the tick source. */
    ctx.blockConcurrencyWhile(async () => {
      const saved = await this.storage.get('room');
      if (saved) this.hydrate(saved);
      this.inited = true;
    });
  }

  /* ------------------------------------------------------------ persistence */
  persist() {
    if (!this.room) return;
    /* Only durable lobby identity is persisted — never live positions, so a
       restarted object can never resurrect a stale player state. */
    this.storage.put('room', {
      code: this.room.code,
      seed: this.room.seed,
      matchNo: this.room.matchNo,
      createdAt: this.room.createdAt,
      players: this.room.allPlayers.map(p => ({
        id: p.id, name: p.name, token: p.token, charId: p.charId,
        accountId: p.accountId || null, guestId: p.guestId || null,
        displayName: p.displayName || null,
        isHost: p.isHost, joinedAt: p.joinedAt, connected: false
      }))
    }).catch(() => {});
  }

  hydrate(saved) {
    const room = new RoomState(saved.code, saved.seed);
    room.matchNo = saved.matchNo || 0;
    room.createdAt = saved.createdAt || Date.now();
    for (const raw of (saved.players || [])) {
      const p = room.addPlayer({
        id: raw.id, name: raw.name, token: raw.token, socketId: null,
        accountId: raw.accountId || null, guestId: raw.guestId || null,
        displayName: raw.displayName || null
      });
      p.charId = raw.charId || p.charId;
      p.connected = false;
      p.ready = false;
      p.inMatch = false;
      p.fighterIndex = -1;
      p.joinedAt = raw.joinedAt || Date.now();
      if (raw.isHost) { p.isHost = true; }
    }
    /* ensure exactly one host */
    const hosts = room.allPlayers.filter(p => p.isHost);
    if (hosts.length !== 1) {
      room.allPlayers.forEach(p => { p.isHost = false; });
      const first = room.allPlayers[0];
      if (first) first.isHost = true;
    }
    room.phase = PHASE.LOBBY;
    this.room = room;
    this.code = room.code;
  }

  /* =========================================================== HTTP / upgrade */
  async fetch(request) {
    const url = new URL(request.url);

    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response(JSON.stringify({
        ok: true,
        object: 'BattleRoom',
        exists: !!this.room,
        code: this.code || (url.searchParams.get('room') || null),
        players: this.room ? this.room.connectedPlayers : 0,
        phase: this.room ? this.room.phase : PHASE.LOBBY,
        tickHz: TICK_HZ
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    }

    /* --- room identity ----------------------------------------------------
       The Durable Object name IS the room code, so a room "exists" exactly
       when this object has already been created (i.e. it has persisted state).
       A JOIN for a code that was never created must fail rather than silently
       creating a ghost room. */
    let code = (url.searchParams.get('room') || '').toUpperCase();
    const wantsCreate = url.searchParams.get('create') === '1';
    const hadRoom = !!this.room;

    if (!this.room) {
      if (!wantsCreate && code) {
        /* --- room not found: accept the socket only to deliver the error --- */
        const p = new WebSocketPair();
        p[1].accept();
        const errPayload = JSON.stringify({ t: S2C.ERROR, code: ERR.ROOM_NOT_FOUND, message: 'No room with code ' + code });
        try { p[1].send(errPayload); } catch (e) {}
        try { p[1].close(4004, 'room not found'); } catch (e) {}
        return new Response(null, { status: 101, webSocket: p[0] });
      }
      if (!code) code = randomRoomCode(5, this.rng);
      this.room = new RoomState(code, (Math.random() * 0xffffffff) >>> 0);
      this.code = code;
      this.persist();
    } else if (!hadRoom && code) {
      this.room.code = code;
    }

    if (!this.room) return new Response('room not initialised', { status: 500 });

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    /* `accept()` (rather than `acceptWebSocket()`) deliberately opts out of
       hibernation: an authoritative 60Hz loop must stay resident for the whole
       match, and hibernation would suspend it. */
    server.accept();

    server._vb = {
      pending: null,
      helloDeadline: Date.now() + 10000,
      /* Identity is resolved by the Worker from the session BEFORE the request
         reaches this object. The Durable Object performs no authentication of
         its own — it receives an already-verified answer, which keeps the
         match loop free of auth concerns. All three are null for a player who
         is playing with no account, which is a fully supported way to play. */
      identity: {
        accountId: request.headers.get('X-VB-Account-Id') || null,
        guestId: request.headers.get('X-VB-Guest-Id') || null,
        displayName: safeHeaderDecode(request.headers.get('X-VB-Display-Name'))
      }
    };
    /* The socket is not bound to a player until it sends HELLO. */
    this._attach(server, url);
    return new Response(null, { status: 101, webSocket: client });
  }

  _attach(ws, url) {
    ws.addEventListener('message', ev => this._onMessage(ws, ev.data));
    ws.addEventListener('close', () => this._onClose(ws));
    ws.addEventListener('error', () => this._onClose(ws));
  }

  /* =============================================================== messages */
  _send(ws, obj) {
    try { ws.send(JSON.stringify(obj)); } catch (e) { /* socket gone */ }
  }

  _sendTo(playerId, obj) {
    const ws = this.sockets.get(playerId);
    if (ws) this._send(ws, obj);
  }

  _broadcast(obj, exceptId) {
    for (const [id, ws] of this.sockets) {
      if (exceptId && id === exceptId) continue;
      this._send(ws, obj);
    }
  }

  _onMessage(ws, data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : new TextDecoder().decode(data)); }
    catch (e) { return this._send(ws, { t: S2C.ERROR, code: ERR.BAD_MESSAGE, message: 'malformed JSON' }); }
    if (!msg || typeof msg.t !== 'string') return;

    /* --- HELLO must be first --------------------------------------------- */
    if (!ws._vb || !ws._vb.playerId) {
      if (msg.t !== C2S.HELLO) {
        return this._send(ws, { t: S2C.ERROR, code: ERR.BAD_MESSAGE, message: 'send hello first' });
      }
      return this._handleHello(ws, msg);
    }

    const p = this.room.players.get(ws._vb.playerId);
    if (!p) { this._send(ws, { t: S2C.ERROR, code: ERR.ROOM_NOT_FOUND, message: 'not in room' }); return; }
    p.lastSeen = Date.now();
    this.room.lastActivity = Date.now();

    switch (msg.t) {
      case C2S.PING:
        return this._send(ws, { t: S2C.PONG, ts: msg.ts, serverTime: Date.now() });

      case C2S.SELECT: {
        if (this.room.phase !== PHASE.LOBBY && this.room.phase !== PHASE.OVER) {
          return this._send(ws, { t: S2C.ERROR, code: ERR.MATCH_RUNNING, message: 'Match in progress' });
        }
        const charId = String(msg.charId || '');
        if (!CHAR_STATS[charId]) {
          return this._send(ws, { t: S2C.ERROR, code: ERR.BAD_CHAR, message: 'Unknown Viber' });
        }
        /* Viber uniqueness is enforced HERE, on the server, so two clients
           racing for the same character cannot both win. */
        if (this.room.takenChars(p.id).has(charId)) {
          return this._send(ws, { t: S2C.ERROR, code: ERR.CHAR_TAKEN, message: CHAR_STATS[charId].name + ' is already taken' });
        }
        p.charId = charId;
        p.ready = false;
        this.room.dirtyLobby = true;
        return this._broadcastLobby();
      }

      case C2S.READY: {
        p.ready = !!msg.ready && !!p.charId;
        this.room.dirtyLobby = true;
        return this._broadcastLobby();
      }

      case C2S.START: {
        if (!this.room.canStart()) {
          return this._send(ws, { t: S2C.ERROR, code: ERR.NOT_READY, message: this.room.startBlockReason() || 'Cannot start' });
        }
        this._startMatch();
        return;
      }

      case C2S.REMATCH: {
        if (this.room.phase === PHASE.OVER) {
          this.room.resetToLobby();
          this._broadcastLobby();
        }
        return;
      }

      case C2S.LEAVE: {
        this._removePlayer(p.id, 'left');
        return;
      }

      case C2S.INPUT: {
        if (!isValidSeq(msg.seq)) return;
        /* Reject out-of-order / replayed input frames. Only ever move forward. */
        if (msg.seq <= p.inputSeq) return;
        const ctrl = normalizeCtrl(msg);
        p.lastCtrl = ctrl;
        /* Latch the one-shot presses. They are consumed by the next tick and
           then cleared, so holding an input across ticks can never re-trigger it
           — which is what silently consumed the double jump. Latching (rather
           than reading straight off the frame) also means two frames arriving
           between two ticks cannot lose a press. */
        const e = p.pendingEdges;
        e.jumpPressed = e.jumpPressed || ctrl.jumpPressed;
        e.quick       = e.quick       || ctrl.quick;
        e.heavy       = e.heavy       || ctrl.heavy;
        e.dash        = e.dash        || ctrl.dash;
        e.ability     = e.ability     || ctrl.ability;
        p.inputSeq = msg.seq;
        p.lastInputAt = Date.now();
        return;
      }

      default:
        return;
    }
  }

  _handleHello(ws, msg) {
    /* --- reconnect by token ---------------------------------------------- */
    const token = typeof msg.token === 'string' ? msg.token.slice(0, 64) : null;
    let p = token ? this.room.findByToken(token) : null;

    /* HIJACK GUARD.
       A reconnect token must only ever be honoured when the seat it points at is
       genuinely free. If that player still has a LIVE socket, this hello is not
       a reconnect — it is a second window that happens to hold the same token
       (two windows of one browser share localStorage, for example). Treating it
       as a reconnect would silently move the first window's seat to the second
       window, and the room would show one player instead of two. */
    if (p && p.connected && this.sockets.has(p.id) && this.sockets.get(p.id) !== ws) {
      console.log('[BattleRoom ' + this.room.code + '] token for ' + p.name +
                  ' is already in use by a live socket — treating this connection as a NEW player');
      p = null;
    }

    if (p) {
      /* A genuine reconnect: the old socket is gone or belongs to this same
         connection. Adopt the identity and drop any stale socket. */
      const stale = this.sockets.get(p.id);
      if (stale && stale !== ws) {
        this.sockets.delete(p.id);
        try { stale.close(4002, 'replaced by reconnect'); } catch (e) {}
      }
      p.connected = true;
      p.socketId = ws._vb.socketId;
      p.lastSeen = Date.now();
      /* Refresh the identity on every reconnect: a player may have signed in
         since they last connected, and their results should follow them. */
      applyIdentity(p, ws._vb && ws._vb.identity);
      if (p.displayName) p.name = this.room.uniqueName(p.displayName, p.id);
      if (p.charId && this.room.takenChars(p.id).has(p.charId)) p.charId = this.room.firstFreeChar(p.id);
      if (!p.charId) p.charId = this.room.firstFreeChar(p.id);
    } else {
      if (!this.room.canJoin()) {
        this._send(ws, { t: S2C.ERROR, code: ERR.ROOM_FULL, message: 'Room is full (4 players)' });
        try { ws.close(4001, 'room full'); } catch (e) {}
        return;
      }
      const id = 'p' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
      const newToken = 'tk' + Math.random().toString(36).slice(2, 12) + Math.random().toString(36).slice(2, 12);
      p = this.room.addPlayer({ id, name: msg.name, token: newToken, socketId: null });
      applyIdentity(p, ws._vb && ws._vb.identity);
      /* Re-apply uniqueness: the identity's display name comes from outside the
         room, so it must not be allowed to collide with someone already here. */
      if (p.displayName) p.name = this.room.uniqueName(p.displayName, p.id);
      p.token = newToken;
      token && (p.reconnectToken = token);
    }

    ws._vb.playerId = p.id;
    this.sockets.set(p.id, ws);
    this.socketPlayer.set(ws, p.id);
    p.connected = true;
    p.lastSeen = Date.now();
    this.room.lastActivity = Date.now();
    this.room.dirtyLobby = true;
    this.persist();

    this._send(ws, {
      t: S2C.WELCOME,
      you: p.id,
      token: p.token,
      roomCode: this.room.code,
      maxPlayers: MAX_PLAYERS,
      tickHz: TICK_HZ,
      config: {
        lives: CFG.lives,
        matchTime: CFG.matchTime,
        gravity: CFG.gravity,
        fallY: CFG.fallY,
        characters: CHAR_ORDER.map(id => ({
          id,
          name: CHAR_STATS[id].name,
          tag: CHAR_STATS[id].tag,
          speed: CHAR_STATS[id].speed,
          jump: CHAR_STATS[id].jump,
          health: CHAR_STATS[id].health,
          weight: CHAR_STATS[id].weight,
          damageMul: CHAR_STATS[id].damageMul,
          abilityCd: CHAR_STATS[id].abilityCd
        }))
      }
    });

    this._broadcastLobby();

    /* A player joining mid-match is a SPECTATOR until the next match. Tell
       them straight away so the client can say so instead of silently hanging. */
    if (this.room.phase === PHASE.PLAYING || this.room.phase === PHASE.COUNTDOWN) {
      this._send(ws, {
        t: S2C.ERROR, code: ERR.MATCH_RUNNING,
        message: 'A match is already running — you will join the next one'
      });
    }

    /* Make sure the loop is running if a match is live. */
    if (this.room.match && this.room.phase !== PHASE.LOBBY) this._ensureLoop();
  }

  _broadcastLobby(extra) {
    const payload = this.room.lobbyPayload(extra);
    this._broadcast(payload);
  }

  /* ============================================================ disconnect */
  _onClose(ws) {
    const playerId = ws._vb && ws._vb.playerId;
    if (!playerId) return;
    const p = this.room.players.get(playerId);
    if (!p) { this.sockets.delete(playerId); return; }
    /* Ignore a stale close from a socket that has already been replaced by a
       newer connection for the same identity (prevents a reconnect from being
       killed by the old socket's close event). */
    if (this.sockets.get(playerId) !== ws) return;

    this.sockets.delete(playerId);
    this._removePlayer(playerId, 'disconnected');
  }

  _removePlayer(playerId, reason) {
    const p = this.room.players.get(playerId);
    if (!p) return;

    const result = this.room.removePlayer(playerId, reason);
    const name = result ? result.player.name : 'Player';

    /* Drop the socket too, so a deliberate LEAVE actually disconnects and the
       client's onclose handler runs. `_onClose` will see the socket is no
       longer the registered one and return without re-removing the player. */
    const ws = this.sockets.get(playerId);
    if (ws) {
      this.sockets.delete(playerId);
      try { ws.close(1000, reason === 'left' ? 'left' : 'removed'); } catch (e) {}
    }

    if (result && result.inMatch) {
      /* Loudly log the policy so it is auditable in `wrangler tail`. */
      console.log('[BattleRoom ' + this.room.code + '] player removed from live match: ' + name + ' (' + reason + ') — no AI substitute, fighter deleted');
    }

    this._broadcast({ t: S2C.PLAYER_GONE, id: playerId, name, reason });

    if (result && result.matchEnded && this.room.match) {
      this._broadcastMatchEnd();
    } else {
      this._broadcastLobby();
    }

    if (this.room.connectedPlayers === 0) {
      this._stopLoop();
      this.persist();
    }
  }

  /* ============================================================= match flow */
  _startMatch() {
    if (!this.room.startMatch()) return;
    this.pendingEvents = [];
    this.acc = 0;
    this.lastTickMs = Date.now();
    this.snapshotAcc = 0;
    this.matchOverBroadcastAt = 0;

    /* Everyone enters the arena fresh. */
    this._broadcastLobby({ phase: PHASE.COUNTDOWN, started: true });
    this._broadcastSnapshot(true);
    this._ensureLoop();
    console.log('[BattleRoom ' + this.room.code + '] match #' + this.room.matchNo + ' started with ' + this.room.humanFighterCount() + ' human players');
  }

  _ensureLoop() {
    if (this.tickTimer !== null) return;
    this.lastTickMs = Date.now();
    this.acc = 0;
    this.tickTimer = setTimeout(() => this._loop(), TICK_MS);
  }

  _stopLoop() {
    if (this.tickTimer !== null) { clearTimeout(this.tickTimer); this.tickTimer = null; }
  }

  _loop() {
    this.tickTimer = null;
    const now = Date.now();
    this.acc += now - this.lastTickMs;
    this.lastTickMs = now;

    let steps = 0;
    const dt = 1 / TICK_HZ;
    while (this.acc >= TICK_MS && steps < 6) {
      this._stepOnce(dt);
      this.acc -= TICK_MS;
      steps++;
    }
    if (steps >= 6) this.acc = 0;   /* gave up catching up; drop the backlog  */

    this.snapshotAcc += steps;
    if (this.snapshotAcc >= SNAPSHOT_EVERY) {
      this.snapshotAcc = 0;
      this._broadcastSnapshot(false);
    }

    if (this.room.phase === PHASE.OVER) {
      /* keep broadcasting the frozen final state briefly, then idle out */
      if (!this.matchOverBroadcastAt) this.matchOverBroadcastAt = now;
      if (now - this.matchOverBroadcastAt > 4000) { this._stopLoop(); return; }
    }
    if (this.room.connectedPlayers === 0) { this._stopLoop(); return; }
    this.tickTimer = setTimeout(() => this._loop(), TICK_MS);
  }

  _stepOnce(dt) {
    const room = this.room;
    if (!room.match) return;

    /* Build the control array in FIGHTER order. A fighter with no connected
       human behind it is driven by an empty control frame — it is not
       simulated by anything else. (In practice such a fighter has already
       been removed by the disconnect handler.)

       CONTINUOUS state (direction, held jump) comes from the latest input frame.
       ONE-SHOT presses come from `pendingEdges`, which is cleared after the tick
       — this is the server's equivalent of the original's clearEdges() running
       once per frame. Without that split, a press held across two 60 Hz ticks
       fires twice, and the second firing consumed the double jump. */
    const ctrls = new Array(room.match.fighters.length);
    for (const p of room.players.values()) {
      if (!p.inMatch) continue;
      const i = p.fighterIndex;
      if (i < 0 || i >= ctrls.length) continue;
      if (!p.connected) continue;
      const base = p.lastCtrl || EMPTY_CTRL;
      const e = p.pendingEdges || EMPTY_EDGES;
      ctrls[i] = {
        dirX: base.dirX, dirZ: base.dirZ, jump: base.jump,
        jumpPressed: e.jumpPressed,
        quick: e.quick, heavy: e.heavy, dash: e.dash, ability: e.ability
      };
    }
    for (let i = 0; i < ctrls.length; i++) if (!ctrls[i]) ctrls[i] = EMPTY_CTRL;

    const events = stepMatch(room.match, dt, ctrls);

    /* The tick has now consumed every latched press — clear them, exactly as the
       original game's clearEdges() does once per frame. A press that is still
       being held will be re-latched by the next input frame the client sends. */
    for (const p of room.players.values()) {
      const e = p.pendingEdges;
      if (!e) continue;
      e.jumpPressed = false; e.quick = false; e.heavy = false; e.dash = false; e.ability = false;
    }

    /* ---- optional hit-resolution tracing -------------------------------
       Enable with:  curl -X POST .../api/debug   (see worker.js)
       Off by default; costs one boolean test per tick when disabled. */
    if (SIM_DEBUG.on) {
      this._dbg = this._dbg || { last: null, n: 0 };
      if (SIM_DEBUG.last && SIM_DEBUG.last !== this._dbg.last) {
        this._dbg.last = SIM_DEBUG.last;
        this._dbg.n++;
        if (this._dbg.n % 20 === 0) {
          console.log('[BattleRoom ' + room.code + '] tryHit ' + JSON.stringify(SIM_DEBUG.last));
        }
      }
    }

    if (events && events.length) {
      for (const e of events) this.pendingEvents.push(e);
      if (this.pendingEvents.length > 400) this.pendingEvents.splice(0, this.pendingEvents.length - 400);
    }

    /* The sim ends the match on its own when stocks run out or the timer hits
       zero. Translate that into the room-level end + results. */
    if (room.match.over && room.phase !== PHASE.OVER) {
      room.endMatch(null, 'normal');
      this._broadcastMatchEnd();
    }

    /* Mirror live stats so the room record stays accurate. */
    for (const p of room.players.values()) {
      if (!p.inMatch) continue;
      const f = room.match.fighters[p.fighterIndex];
      if (!f) continue;
      p.kos = f.kos; p.falls = f.falls;
      p.dmgDealt = Math.round(f.dmgDealt);
      p.dmgTaken = Math.round(f.dmgTaken);
    }
  }

  _broadcastMatchEnd() {
    if (!this.room.lastStandings) this.room.endMatch(null, 'normal');
    const standings = this.room.lastStandings || [];
    this._broadcast({
      t: S2C.MATCHEND,
      winnerId: this.room.match ? this.room.match.winnerId : null,
      reason: this.room.matchEndReason || 'normal',
      standings
    });
    this.persist();
    /* Persist the result for progression and analytics. Deliberately not
       awaited: the players must not wait on a database write to see the
       results screen. */
    this._reportMatch();
  }

  /* ==========================================================================
     Match reporting — the bridge from "a match happened" to progression.

     This runs ONCE per match (`matchReported` guard) and writes to D1 with
     INSERT OR IGNORE on a unique match id, so even if the guard were bypassed
     by a restart, nothing could be counted twice.

     Everything written here was computed by this object during the match. A
     client cannot reach it.
     ========================================================================== */
  _reportMatch() {
    const room = this.room;
    if (!room || room.matchReported || !room.matchId) return;
    if (!hasDb(this.env)) return;          /* no D1 binding: play on regardless */
    const report = room.buildMatchReport(this._rulesetHash());
    if (!report) return;
    room.matchReported = true;             /* optimistic; DB insert is idempotent */

    recordMatch(this.env, report).then(res => {
      if (res && res.recorded) {
        console.log('[BattleRoom ' + room.code + '] match ' + report.matchId +
          ' recorded (' + res.results + ' results, winner=' + (report.winnerPlayerKey || 'none') + ')');
      }
      /* Progression and achievements are driven off this same report and are
         added in phase 3 / 5 — the hook is here so the ordering is fixed. */
      this._onMatchRecorded(report, res);
    }).catch(err => {
      console.error('[BattleRoom ' + room.code + '] match report failed', err && err.message);
      room.matchReported = false;          /* allow a retry on the next end path */
    });
  }

  /** Phase 3 / 5 hook: award XP and evaluate achievements for a recorded match. */
  _onMatchRecorded(report, _result) {
    if (!hasDb(this.env)) return;
    const events = [{
      name: 'match_ended', source: 'server', matchId: report.matchId,
      roomCode: report.roomCode, props: {
        players: report.players.length,
        durationS: Math.round(((report.endedAt - report.startedAt) || 0) / 1000),
        reason: report.endReason
      }
    }];
    recordEvents(this.env, events);

    /* Award progression for every SIGNED-IN player. A guest has no progress row
       yet: their XP is computed the moment they sign up and their matches are
       claimed, which is what makes "sign up later and keep everything" true. */
    const accounts = [...new Set(report.players.map(p => p.accountId).filter(Boolean))];
    for (const accountId of accounts) {
      awardForAccount(this.env, accountId).then(res => {
        if (res && res.levelledUp) {
          console.log('[BattleRoom ' + (this.room ? this.room.code : '?') + '] account ' +
            accountId.slice(0, 8) + ' reached level ' + res.level + ' (+' + res.levelsGained + ')');
        }
      }).catch(err => {
        console.error('[BattleRoom] progression award failed', err && err.message);
      });
    }
  }

  /**
   * A hash of the gameplay constants a match was played under. Stored with the
   * result so that if the game is retuned later, old matches can still be
   * interpreted correctly.
   */
  _rulesetHash() {
    if (this._ruleset) return this._ruleset;
    let h = 0x811c9dc5;
    const s = CFG.tickRate + '|' + CFG.matchTime + '|' + CFG.lives + '|' +
              CHAR_ORDER.map(id => {
                const c = CHAR_STATS[id];
                return id + ':' + c.speed + ':' + c.jump + ':' + c.health + ':' + c.weight + ':' + c.damageMul;
              }).join(',');
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    this._ruleset = 'fnv1a:' + h.toString(16);
    return this._ruleset;
  }

  /* ============================================================= snapshots */
  _broadcastSnapshot(force) {
    const room = this.room;
    const m = room.match;
    if (!m) return;

    const players = m.fighters
      .filter(f => !f.removed)
      .map(f => serializeFighter(f));

    const events = this.pendingEvents;
    this.pendingEvents = [];

    /* The per-client `ack` (last input seq consumed) is the one field that
       differs between recipients, so the base payload is built once. */
    const base = {
      t: S2C.SNAPSHOT,
      tick: m.tick,
      phase: m.phase,
      matchTime: +m.matchTime.toFixed(2),
      countdown: +m.countdown.toFixed(2),
      time: +m.time.toFixed(2),
      shake: +m.shake.toFixed(3),
      winnerId: m.winnerId,
      players,
      powerups: serializePowerups(m),
      hazards: serializeHazards(m),
      events
    };

    for (const [id, ws] of this.sockets) {
      const p = room.players.get(id);
      const ack = p ? p.inputSeq : 0;
      this._send(ws, Object.assign({ ack }, base));
    }

    /* clear the transient shake once broadcast so it is not replayed */
    m.shake = 0;
  }

  /* ================================================================ alarms */
  async alarm() {
    const now = Date.now();
    const expired = this.room ? this.room.pruneExpired(now) : [];
    for (const id of expired) this._removePlayer(id, 'expired');
    if (this.room && this.room.connectedPlayers === 0 && this.room.isIdle(now)) {
      await this.storage.deleteAll();
      this.room = null;
      this.code = null;
      return;
    }
    await this.storage.setAlarm(now + 60000);
  }
}
