/* =============================================================================
   VIBER BRAWL — MULTIPLAYER CLIENT LAYER
   -----------------------------------------------------------------------------
   Appended AFTER the original game script, as a classic script, so it shares the
   original file's top-level bindings (`fighters`, `Game`, `Fighter`,
   `buildViber`, `CHARACTERS`, `renderer`, `scene`, `camera`, `updateHUD`,
   `announce`, `burst`, `impactRing`, `SFX`, ...). Nothing is re-implemented:
   the multiplayer mode drives the SAME models, arena, HUD, camera, particles
   and sound as solo play.

   Division of labour:
     * The CLIENT renders, animates, plays sound, shows UI, reads input, and
       predicts its own fighter locally.
     * The SERVER (Durable Object running the shared sim) owns position,
       velocity, gravity, collisions, attacks, damage, knockback, hitstun,
       stocks, KO, respawn, abilities, hazards, powerups, the match timer and
       the winner.

   The only gameplay message this client ever sends is an INPUT frame.
   ============================================================================= */
(function () {
'use strict';

/* ------------------------------------------------------------------ config -- */
var MP_CFG = {
  inputIntervalMs: 33,      /* client -> server input rate (30 Hz)             */
  interpDelayMs: 110,       /* remote fighters are rendered this far in the past */
  snapshotKeep: 24,         /* interpolation buffer depth per remote fighter    */
  hardSnapDist: 3.0,        /* error above this = hard correction, no blending  */
  deadZone: 0.02,
  offsetDecay: 13,          /* per-second decay of the visual correction offset */
  pingIntervalMs: 2000
};

/* ------------------------------------------------------- server discovery -- */
/* Same origin by default (works with `wrangler dev` and with the Worker also
   serving the page). Override for a separate front end, e.g.:
       viber-brawl-multiplayer.html?mp=https://viber-brawl-multiplayer.x.workers.dev
   The value is remembered in localStorage. */
var MP_SERVER = (function () {
  try {
    var q = new URLSearchParams(location.search).get('mp');
    if (q) { localStorage.setItem('viberbrawl_mp_server', q); return q.replace(/\/+$/, ''); }
    var saved = localStorage.getItem('viberbrawl_mp_server');
    if (saved) return saved.replace(/\/+$/, '');
  } catch (e) {}
  return location.origin;
})();
var MP_WS_BASE = MP_SERVER.replace(/^http/, 'ws') + '/ws';
var MP_SIM_URL = MP_SERVER + '/shared/sim.js';

/* ------------------------------------------------------------- MP state --- */
var MP = {
  sim: null, simReady: false,

  ws: null, status: 'idle',        /* idle|connecting|lobby|countdown|playing|over|dead */
  active: false,                   /* multiplayer UI/flow owns the screen right now    */
  inMatch: false,                  /* a networked match is being rendered              */
  showingResults: false,
  spectating: false,

  roomCode: '', playerId: null, token: null, name: 'VIBER',
  players: [], hostId: null, roster: null, phase: 'lobby',
  canStart: false, blockReason: null,

  snap: null, snapAt: 0, lastSnapAt: 0, snapCount: 0, lastTick: -1,

  /* per-player (NOT positional) so a removed fighter cannot shift anyone */
  mirrors: {},          /* playerId -> SimFighter                       */
  buffers: {},          /* playerId -> [{at, s}]                        */
  playerFighter: {},    /* playerId -> the client Fighter (with a model) */
  localIndex: -1,
  slotOrder: [],

  predict: null,        /* lightweight state used to advance the local fighter */
  pending: [],          /* unacked input frames [{seq, ctrl, dt}]              */
  seq: 0, ack: 0, lastSentSeq: -1, lastSendAt: 0, edgeOut: null,
  offset: { x: 0, y: 0, z: 0 },

  powerMeshes: {},      /* id -> {type, pos, mesh, spin}  */
  eventQueue: [],

  standings: null, winnerId: null, matchEndReason: null,
  victoryStarted: false, victoryT: 0,

  rtt: 0, lastPing: 0, lastSnapRecvAt: 0,
  pendingConnect: null,     /* a connect asked for before the core finished loading */
  errors: [], info: ''
};
window.__VB_MP = MP;   /* exposed for the console + automated verification */

/* ------------------------------------------------------------ DOM handles -- */
function $(id) { return document.getElementById(id); }

/* The original screen manager only knows the solo screens. Register the two new
   ones so showScreen() can actually reveal them — `screens` is a const array,
   so its contents may be extended but the binding must not be replaced. */
screens.push('scrMP', 'scrLobby');

/* =============================================================================
   1. LOAD THE SHARED GAMEPLAY CORE
   The exact same file the Durable Object imports. One source of truth.
   ============================================================================= */
import(MP_SIM_URL)
  .then(function (mod) {
    MP.sim = mod;
    MP.simReady = true;
    mpNet('idle', 'shared core loaded');
    console.log('[MP] shared gameplay core loaded from ' + MP_SIM_URL);
    /* A connection requested before the core finished loading must not be
       silently dropped — replay it now. */
    var queued = MP.pendingConnect;
    MP.pendingConnect = null;
    if (queued) { mpMsg('mpMsg', '', ''); mpConnect(queued); }
  })
  .catch(function (err) {
    MP.simReady = false;
    mpNet('bad', 'core failed to load');
    console.error('[MP] failed to load ' + MP_SIM_URL, err);
    /* The single most common way a non-technical user hits this: double-clicking
       the .html file instead of opening it from the local server. A file:// page
       cannot import a module from disk, so say exactly that, in words that tell
       them what to do rather than what went wrong. */
    if (location.protocol === 'file:') {
      mpMsg('mpMsg',
        'This page was opened straight from your folder, so it cannot reach the game server. ' +
        'Open it from the local address instead: ' + MP_SERVER + '/viber-brawl-multiplayer.html',
        'bad');
    } else {
      mpMsg('mpMsg', 'Could not load the shared gameplay core from ' + MP_SIM_URL +
        '. Is the multiplayer server running?', 'bad');
    }
  });

/* =============================================================================
   2. SMALL UI HELPERS
   ============================================================================= */
function mpMsg(elId, text, cls) {
  var el = $(elId);
  if (!el) return;
  el.textContent = text || '';
  el.className = 'mp-msg' + (cls ? ' ' + cls : '');
}
function mpNet(state, text) {
  var el = $('mpNet');
  if (!el) return;
  el.className = 'mp-net' + (state === 'on' ? ' on' : state === 'warn' ? ' warn' : state === 'bad' ? ' bad' : '');
  el.textContent = text;
}
function mpBanner(text, on) {
  var el = $('mpBanner');
  if (!el) return;
  if (text) { el.textContent = text; el.classList.add('on'); }
  else el.classList.remove('on');
}
function shortName(n) { return (n || 'VIBER').toUpperCase().slice(0, 14); }

/* =============================================================================
   3. NETWORKING
   ============================================================================= */
function mpConnect(opts) {
  /* Queue rather than fail. The core usually loads in a few hundred ms, but on
     a slow machine or with several windows open it can take longer — and a
     click that silently does nothing is the worst possible outcome. */
  if (!MP.simReady) {
    MP.pendingConnect = opts;
    mpMsg('mpMsg', 'Loading the gameplay core… connecting in a moment.', '');
    mpNet('warn', 'loading…');
    return;
  }
  if (MP.ws) { try { MP.ws.close(); } catch (e) {} MP.ws = null; }

  MP.status = 'connecting';
  MP.active = true;
  mpNet('warn', 'connecting…');
  mpMsg('mpMsg', '', '');

  var url = MP_WS_BASE + (opts.room ? '?room=' + encodeURIComponent(opts.room) + (opts.create ? '&create=1' : '') : (opts.create ? '?create=1' : ''));
  var ws;
  try { ws = new WebSocket(url); }
  catch (e) { mpMsg('mpMsg', 'Could not open the connection to ' + MP_SERVER, 'bad'); mpNet('bad', 'offline'); return; }
  MP.ws = ws;

  var helloSent = false;
  var connectTimer = setTimeout(function () {
    if (ws.readyState !== 1) { mpMsg('mpMsg', 'Timed out connecting to ' + MP_SERVER, 'bad'); mpNet('bad', 'timeout'); }
  }, 8000);

  ws.onopen = function () {
    clearTimeout(connectTimer);
    helloSent = true;
    mpNet('warn', 'handshaking…');
    mpSend({ t: 'hello', name: MP.name, token: MP.token || undefined });
  };
  ws.onmessage = function (ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    mpOnMessage(msg);
  };
  ws.onerror = function () { mpNet('bad', 'socket error'); };
  ws.onclose = function (ev) {
    clearTimeout(connectTimer);
    if (MP.ws !== ws) return;
    MP.ws = null;
    if (MP.inMatch || MP.status === 'playing' || MP.status === 'countdown') {
      mpTeardownMatch();
      MP.status = 'dead';
      mpNet('bad', 'disconnected');
      mpMsg('mpMsg', 'Connection lost (' + (ev.code || '?') + '). Back to the lobby screen.', 'bad');
      showScreen('scrMP');
    } else {
      MP.status = 'idle';
      mpNet('bad', 'disconnected');
      if (ev.code === 4001) mpMsg('mpMsg', 'That room is full (4 players max).', 'bad');
      else if (ev.code === 4004) mpMsg('mpMsg', 'No room with that code. Check it and try again.', 'bad');
      else mpMsg('mpMsg', 'Disconnected from the server.', 'bad');
    }
    MP.active = false;
  };
}

function mpSend(obj) {
  if (!MP.ws || MP.ws.readyState !== 1) return false;
  try { MP.ws.send(JSON.stringify(obj)); return true; } catch (e) { return false; }
}

function mpOnMessage(msg) {
  switch (msg.t) {
    case 'welcome':
      MP.playerId = msg.you;
      MP.token = msg.token;
      /* The reconnect token MUST live in sessionStorage, which is per tab/window.
         localStorage is shared by every window of the same browser, so storing
         the token there made a second window claim to be the SAME player and
         silently take over the first window's seat — the room then showed one
         player instead of two. sessionStorage gives each window its own identity
         while still surviving a page reload. */
      try { sessionStorage.setItem('viberbrawl_mp_token', msg.token); } catch (e) {}
      MP.roomCode = msg.roomCode;
      $('mpRoomCode').textContent = msg.roomCode;
      mpNet('on', 'connected');
      MP.status = 'lobby';
      showScreen('scrLobby');
      mpPingLoop();
      break;

    case 'lobby':
      mpOnLobby(msg);
      break;

    case 'snapshot':
      mpOnSnapshot(msg);
      break;

    case 'matchend':
      mpOnMatchEnd(msg);
      break;

    case 'playerGone':
      if (MP.inMatch) mpBanner(shortName(msg.name) + ' LEFT THE MATCH', true);
      else mpMsg('mpLobbyMsg', shortName(msg.name) + ' left the room', 'bad');
      setTimeout(function () { mpBanner(null); }, 2600);
      break;

    case 'pong':
      MP.rtt = Math.max(1, Math.round(performance.now() - msg.ts));
      break;

    case 'error':
      if (msg.code === 'room_full' || msg.code === 'room_not_found') {
        mpMsg('mpMsg', msg.message, 'bad');
      } else if (msg.code === 'match_running') {
        MP.spectating = true;
        mpMsg('mpLobbyMsg', msg.message, '');
      } else {
        if (MP.inMatch) mpBanner(msg.message, true), setTimeout(function () { mpBanner(null); }, 2200);
        else mpMsg('mpLobbyMsg', msg.message, 'bad');
      }
      break;
  }
}

function mpPingLoop() {
  if (!MP.ws) return;
  mpSend({ t: 'ping', ts: performance.now() });
  setTimeout(mpPingLoop, MP_CFG.pingIntervalMs);
}

/* =============================================================================
   4. LOBBY
   ============================================================================= */
function mpOnLobby(msg) {
  MP.players = msg.players || [];
  MP.hostId = msg.hostId;
  MP.phase = msg.phase;
  MP.canStart = !!msg.canStart;
  MP.blockReason = msg.blockReason;
  MP.roomCode = msg.roomCode || MP.roomCode;
  if (msg.roster) MP.roster = msg.roster;
  $('mpRoomCode').textContent = MP.roomCode;

  /* a match just started for everyone already in the room */
  if (msg.started && msg.roster && !MP.inMatch) {
    mpBeginMatch(msg.roster);
  }

  /* the room is back in the lobby (rematch, or the match was abandoned) —
     tear the online match down so the next one starts from a clean slate */
  if (msg.phase === 'lobby' && MP.inMatch) {
    mpTeardownMatch();
    MP.standings = null;
    MP.showingResults = false;
    Game.mode = 'menu';
    Game.over = false;
    Game.paused = false;
    Game.victoryPhase = null;
    Game.victoryT = 0;
    Game.winner = null;
    /* hide the last match's fighters behind the lobby overlay. NOTE: the
       original resetToMenu() is deliberately NOT used here — it assumes
       exactly four fighters exist and would throw with a 2- or 3-player
       online roster. */
    for (var fi = 0; fi < fighters.length; fi++) if (fighters[fi].group) fighters[fi].group.visible = false;
    showScreen('scrLobby');
  }

  /* the match finished and we are back in the lobby */
  if (!MP.inMatch && (msg.phase === 'lobby' || msg.phase === 'over')) {
    MP.showingResults = false;
    if (MP.status !== 'lobby') MP.status = 'lobby';
  }

  if (!MP.inMatch) {
    showScreen('scrLobby');
    mpRenderLobby(msg);
  }
}

function mpRenderLobby(msg) {
  var me = mpMe();
  var myReady = me ? me.ready : false;

  /* ---- player slots ---- */
  var slots = $('mpSlots');
  slots.innerHTML = '';
  var list = MP.players.slice();
  list.sort(function (a, b) { return (a.joinedAt || 0) - (b.joinedAt || 0); });
  list.forEach(function (p) {
    var isMe = p.id === MP.playerId;
    var row = document.createElement('div');
    row.className = 'mp-slot' + (isMe ? ' you' : '') + (p.connected ? '' : ' gone');
    var dotCls = !p.connected ? '' : (p.ready ? 'ready' : 'on');
    var charName = p.charId ? (mpCharBase(p.charId) ? mpCharBase(p.charId).name : p.charId) : '—';
    var stateTxt = !p.connected ? 'GONE' : (p.isHost && !p.ready ? 'HOST' : (p.ready ? 'READY' : 'WAITING'));
    var stateCls = !p.connected ? 'gone' : (p.isHost && !p.ready ? 'host' : (p.ready ? 'ready' : ''));
    row.innerHTML =
      '<span class="mp-dot ' + dotCls + '"></span>' +
      '<span class="mp-slot-name">' + mpEsc(shortName(p.name)) + (isMe ? '<span class="mp-tagyou">YOU</span>' : '') + '</span>' +
      '<span class="mp-slot-char">' + mpEsc(charName) + '</span>' +
      '<span class="mp-slot-state ' + stateCls + '">' + stateTxt + '</span>';
    slots.appendChild(row);
  });
  var empties = Math.max(0, 4 - list.length);
  for (var i = 0; i < empties; i++) {
    var e = document.createElement('div');
    e.className = 'mp-slot empty';
    e.innerHTML = '<span class="mp-dot"></span><span class="mp-slot-name" style="color:var(--muted)">Waiting for a player…</span>' +
                  '<span class="mp-slot-char">—</span><span class="mp-slot-state">OPEN</span>';
    slots.appendChild(e);
  }

  /* ---- wait list / spectating note ---- */
  var wl = $('mpWaitlist');
  var waiting = MP.players.filter(function (p) { return p.connected && !p.inMatch && MP.inMatch; });
  if (MP.inMatch && !mpMe() || (MP.inMatch && mpMe() && !mpMe().inMatch)) {
    wl.textContent = 'You are spectating — you will join the next match.';
    wl.style.display = '';
  } else if (waiting.length) {
    wl.textContent = 'Waiting for the next match: ' + waiting.map(function (p) { return shortName(p.name); }).join(', ');
    wl.style.display = '';
  } else {
    wl.textContent = '';
    wl.style.display = 'none';
  }

  /* ---- viber picker ---- */
  mpRenderCharGrid();

  /* ---- buttons ---- */
  var btnReady = $('btnReady');
  btnReady.textContent = myReady ? 'CANCEL READY' : 'READY';
  btnReady.className = 'btn ' + (myReady ? '' : 'green');
  $('btnStartMatch').disabled = false;
  $('btnStartMatch').style.opacity = MP.canStart ? '1' : '.45';

  if (!MP.inMatch) {
    if (MP.canStart) mpMsg('mpLobbyMsg', 'Everyone is ready — start the match!', 'good');
    else mpMsg('mpLobbyMsg', MP.blockReason || '', '');
  }
}

function mpCharBase(id) {
  for (var i = 0; i < CHARACTERS.length; i++) if (CHARACTERS[i].id === id) return CHARACTERS[i];
  return null;
}

function mpRenderCharGrid() {
  var grid = $('mpCharGrid');
  if (!grid) return;
  grid.innerHTML = '';
  var me = mpMe();
  var takenBy = {};
  MP.players.forEach(function (p) {
    if (p.connected && p.charId) takenBy[p.charId] = p;
  });

  CHARACTERS.forEach(function (c) {
    var owner = takenBy[c.id];
    var mine = owner && owner.id === MP.playerId;
    var el = document.createElement('div');
    el.className = 'mp-card' + (mine ? ' sel mine' : '') + (owner && !mine ? ' taken' : '');
    el.innerHTML =
      (owner ? '<span class="mp-card-owner">' + (mine ? 'YOURS' : mpEsc(shortName(owner.name))) + '</span>' : '') +
      '<div class="mp-card-name">' + mpEsc(c.name) + '</div>' +
      '<div class="mp-card-tag">' + mpEsc(c.tag) + '</div>' +
      '<div class="mp-card-abil">' + mpEsc(c.abilityName) + '</div>';
    if (!owner || mine) {
      el.addEventListener('click', function () {
        SFX.init(); SFX.resume(); SFX.click();
        mpSend({ t: 'select', charId: c.id });
      });
    }
    grid.appendChild(el);
  });
  var sub = $('mpLobbySub');
  if (sub) sub.textContent = me && me.charId
    ? 'You picked ' + mpCharBase(me.charId).name + '. Each Viber can only be picked by one player.'
    : 'Each Viber can only be picked by one player.';
}

function mpMe() {
  for (var i = 0; i < MP.players.length; i++) if (MP.players[i].id === MP.playerId) return MP.players[i];
  return null;
}
function mpEsc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (ch) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
  });
}

/* =============================================================================
   5. MATCH SETUP — build the real Viber models for the roster
   ============================================================================= */
function mpDisposeGroup(g) {
  if (!g) return;
  /* Same care as the original disposePowerup(): the EdgesGeometry cache and the
     shared outlineMat must never be disposed, or unrelated outlines vanish. */
  var shared = [];
  try { edgeCache.forEach(function (geo) { shared.push(geo); }); } catch (e) {}
  g.traverse(function (o) {
    if (o.geometry && shared.indexOf(o.geometry) === -1) { try { o.geometry.dispose(); } catch (e) {} }
    if (o.material) {
      var mats = Array.isArray(o.material) ? o.material : [o.material];
      mats.forEach(function (m) {
        if (!m || !m.dispose || m === outlineMat) return;
        if (m.map && m.map === _glowTex) { m.map = null; }
        try { m.dispose(); } catch (e) {}
      });
    }
  });
}

function mpClearFighters() {
  for (var i = 0; i < fighters.length; i++) {
    var f = fighters[i];
    if (f && f.group) { scene.remove(f.group); mpDisposeGroup(f.group); }
  }
  fighters = [];
}

function mpBeginMatch(roster) {
  if (MP.inMatch) return;
  MP.roster = roster;
  MP.inMatch = true;
  MP.showingResults = false;
  MP.spectating = !roster.some(function (r) { return r.id === MP.playerId; });
  MP.victoryStarted = false;
  MP.victoryT = 0;
  MP.offset.x = MP.offset.y = MP.offset.z = 0;
  MP.pending = [];
  MP.ack = 0;
  MP.mirrors = {};
  MP.buffers = {};
  MP.playerFighter = {};
  MP.powerMeshes = {};
  MP.eventQueue = [];
  /* A key held in the lobby must not fire on the first frame of the match. */
  clearEdges();

  /* Game flags go FIRST: if anything below fails, the world must still be in
     match mode rather than silently falling back to the menu camera. */
  Game.mode = 'play';
  Game.over = false;
  Game.paused = false;
  Game.hitStop = 0;
  Game.shake = 0;
  Game.victoryPhase = null;
  Game.victoryT = 0;
  Game.winner = null;
  Game.matchTime = CFG.matchTime;
  Game.countdown = 3.4;
  Game.camYaw = 0;
  applyMap(Game.map);
  applyHazardsForDifficulty('hard');

  try {
    mpBuildMatch(roster);
  } catch (err) {
    console.error('[MP] match setup failed', err);
    mpMsg('mpLobbyMsg', 'Match setup failed — see the console.', 'bad');
  }
}

function mpBuildMatch(roster) {
  /* ---- wipe transient world objects exactly like the solo startMatch ---- */
  for (var i = 0; i < powerups.length; i++) { disposePowerup(powerups[i].mesh); scene.remove(powerups[i].mesh); }
  powerups.length = 0;
  for (var j = 0; j < particles.length; j++) scene.remove(particles[j].m);
  particles.length = 0;
  for (var k = 0; k < fxList.length; k++) scene.remove(fxList[k].m);
  fxList.length = 0;

  /* ---- build one real Viber per roster slot ---- */
  mpClearFighters();
  var ordered = roster.slice().sort(function (a, b) { return a.index - b.index; });
  MP.slotOrder = ordered.map(function (r) { return r.id; });
  MP.localIndex = -1;

  ordered.forEach(function (r) {
    var base = mpCharBase(r.charId) || CHARACTERS[0];
    /* clone the def so the HUD can show the PLAYER name while every visual and
       gameplay value still comes from the original character definition */
    var def = Object.assign({}, base, { name: shortName(r.name) + ' ' + base.name.split(' ')[0] });
    var f = new Fighter(def, r.index);
    f.isPlayer = (r.id === MP.playerId);
    f.mpPlayerId = r.id;
    f.mpName = shortName(r.name);
    f.reset(0, 0);
    f.invuln = 0;
    fighters.push(f);
    MP.playerFighter[r.id] = f;
    if (r.id === MP.playerId) MP.localIndex = fighters.length - 1;

    /* a mirror SimFighter for every player, keyed by playerId */
    var m = new MP.sim.SimFighter(base.id, r.index);
    m.id = r.id;
    m.reset(0, 0);
    m.invuln = 0;
    MP.mirrors[r.id] = m;
    MP.buffers[r.id] = [];
  });

  player = MP.playerFighter[MP.playerId] || fighters[0];

  /* lightweight state for predicting the local fighter. Its `fighters` list is
     the mirror set, so a locally predicted swing still auto-faces an opponent
     and still feels like it connects — the server remains the arbiter. */
  MP.predict = {
    tick: 0, time: 0, matchTime: CFG.matchTime, countdown: 3.4,
    hitStop: 0, shake: 0, phase: 'playing', over: false, winner: null, winnerId: null,
    rng: function () { return 0.5; },
    fighters: [],
    platforms: MP.sim.ARENA_PLATFORMS,
    hazards: { spinAngle: 0, spinEnabled: false, padsEnabled: false, pads: [] },
    powerups: [],
    events: []
  };
  mpRebuildPredictFighters();

  /* ---- screen + HUD ---- */
  buildCards();
  ui.hud.classList.add('on');
  showScreen(null);
  hidePhotoOverlay();
  Music.start();
  mpMsg('mpLobbyMsg', '', '');
  mpBanner(null);
  console.log('[MP] match started with ' + ordered.length + ' players' + (MP.spectating ? ' (spectating)' : ''));
}

function mpRebuildPredictFighters() {
  MP.predict.fighters = MP.slotOrder.map(function (id) { return MP.mirrors[id]; }).filter(Boolean);
}

function mpTeardownMatch() {
  MP.inMatch = false;
  MP.showingResults = false;
  MP.spectating = false;
  MP.pending = [];
  MP.snap = null;
  MP.eventQueue = [];
  for (var id in MP.powerMeshes) {
    var pm = MP.powerMeshes[id];
    if (pm && pm.mesh) { scene.remove(pm.mesh); mpDisposeGroup(pm.mesh); }
  }
  MP.powerMeshes = {};
  mpBanner(null);
  Music.stop();
  ui.hud.classList.remove('on');
}

/* =============================================================================
   6. SNAPSHOT HANDLING
   ============================================================================= */
function mpOnSnapshot(msg) {
  /* A player who joined while a match was already running is a spectator:
     they hold no fighter, so there is nothing to render and nothing to apply.
     They stay in the lobby until the next match. */
  if (!MP.inMatch) { MP.snap = msg; return; }

  var now = performance.now();
  MP.snap = msg;
  MP.snapAt = now;
  MP.lastSnapRecvAt = now;
  MP.snapCount++;
  if (msg.tick <= MP.lastTick) return;      /* stale packet — ignore           */
  MP.lastTick = msg.tick;

  MP.phase = msg.phase;
  MP.winnerId = msg.winnerId;

  /* the match clock / countdown are authoritative */
  Game.matchTime = msg.matchTime;
  Game.countdown = msg.countdown;

  /* ---- per-player state ---- */
  for (var i = 0; i < msg.players.length; i++) {
    var arr = msg.players[i];
    var id = arr[0];
    var st = MP.sim.deserializeFighter(arr);
    if (!MP.buffers[id]) MP.buffers[id] = [];
    var buf = MP.buffers[id];
    buf.push({ at: now, s: st });
    if (buf.length > MP_CFG.snapshotKeep) buf.shift();
    if (!MP.mirrors[id]) {
      var mm = new MP.sim.SimFighter(st.charId, 0);
      mm.id = id;
      MP.mirrors[id] = mm;
    }
  }

  /* a player removed from the match must stop being rendered */
  for (var pid in MP.mirrors) {
    if (!msg.players.some(function (p) { return p[0] === pid; })) {
      var pf = MP.playerFighter[pid];
      if (pf && pf.group) pf.group.visible = false;
    }
  }

  mpReconcileLocal(msg);

  /* ---- server events become local FX ---- */
  if (msg.events && msg.events.length) {
    for (var e = 0; e < msg.events.length; e++) MP.eventQueue.push(msg.events[e]);
    if (MP.eventQueue.length > 300) MP.eventQueue.splice(0, MP.eventQueue.length - 300);
  }

  /* ---- hazards ---- */
  MP.serverHazards = msg.hazards;
  if (hazards.spinBar) {
    hazards.spinBar.rotation.y = msg.hazards.a;
    hazards.spinEnabled = !!msg.hazards.s;
    hazards.spinBar.visible = !!msg.hazards.s;
  }
  hazards.padsEnabled = !!msg.hazards.p;
  if (msg.hazards.pads) {
    for (var pi = 0; pi < hazards.pads.length && pi < msg.hazards.pads.length; pi++) {
      var srvPad = msg.hazards.pads[pi];
      hazards.pads[pi].x = srvPad[0];
      hazards.pads[pi].z = srvPad[1];
      hazards.pads[pi].active = !!srvPad[2];
      hazards.pads[pi].phase = !!srvPad[3];
      hazards.pads[pi].grp.visible = hazards.padsEnabled;
    }
  }

  /* ---- powerups ---- */
  MP.serverPowerups = msg.powerups;
  mpSyncPowerups(msg.powerups);

  /* ---- match end detected from the snapshot itself ---- */
  if (msg.phase === 'over' && !MP.showingResults && !MP.victoryStarted) {
    /* matchend message normally arrives first; this is a safety net */
  }
}

function mpApplyStateToMirror(m, s) {
  m.charId = s.charId; m.def = MP.sim.CHAR_STATS[s.charId] || m.def;
  m.x = s.x; m.y = s.y; m.z = s.z;
  m.vx = s.vx; m.vy = s.vy; m.vz = s.vz;
  m.facing = s.facing;
  m.health = s.health; m.lives = s.lives; m.state = s.state;
  m.onGround = s.onGround; m.jumpsLeft = s.jumpsLeft;
  m.attackType = s.attackType; m.attackT = s.attackT; m.attackPhase = s.attackPhase;
  m.hitstun = s.hitstun; m.moveLock = s.moveLock; m.dashT = s.dashT;
  m.abilityActive = s.abilityActive; m.abilityT = s.abilityT;
  m.abilityCd = s.abilityCd; m.dashCd = s.dashCd;
  m.invuln = s.invuln; m.phaseT = s.phaseT; m.shield = s.shield;
  m.speedBuff = s.speedBuff; m.damageBuff = s.damageBuff; m.dashBuff = s.dashBuff;
  m.koT = s.koT; m.flash = s.flash; m.hazardCd = s.hazardCd;
  m.landSquash = s.landSquash; m.landSquashAmt = s.landSquashAmt;
  m.kos = s.kos; m.falls = s.falls; m.dmgDealt = s.dmgDealt; m.dmgTaken = s.dmgTaken;
}

/* ---------------------------------------------------------------------------
   Reconciliation for the LOCAL player.
   Classic predict-and-replay: reset the predicted fighter to the authoritative
   state the server had at `ack`, then re-apply every input frame the server has
   not consumed yet. The visual difference is absorbed into a decaying offset so
   the fighter never jitters; a large difference is a hard correction.
   --------------------------------------------------------------------------- */
function mpReconcileLocal(msg) {
  var li = MP.localIndex;
  if (li < 0) return;
  var id = MP.playerId;
  var m = MP.mirrors[id];
  if (!m) return;

  var serverArr = null;
  for (var i = 0; i < msg.players.length; i++) if (msg.players[i][0] === id) { serverArr = msg.players[i]; break; }
  if (!serverArr) return;              /* we are not in this match (spectating) */
  var server = MP.sim.deserializeFighter(serverArr);

  MP.ack = msg.ack;
  MP.pending = MP.pending.filter(function (fr) { return fr.seq > MP.ack; });

  var pf = MP.playerFighter[id];
  var prevX = m.x + MP.offset.x, prevY = m.y + MP.offset.y, prevZ = m.z + MP.offset.z;

  mpApplyStateToMirror(m, server);
  if (pf) { pf.landSquash = server.landSquash; pf.landSquashAmt = server.landSquashAmt; }

  /* replay everything the server has not seen */
  for (var k = 0; k < MP.pending.length; k++) {
    var fr = MP.pending[k];
    MP.sim.stepFighter(MP.predict, m, fr.dt, fr.ctrl);
  }

  var dx = prevX - m.x, dy = prevY - m.y, dz = prevZ - m.z;
  var mag = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (mag > MP_CFG.hardSnapDist) {
    MP.offset.x = MP.offset.y = MP.offset.z = 0;      /* hard correction */
  } else if (mag < MP_CFG.deadZone) {
    MP.offset.x = MP.offset.y = MP.offset.z = 0;
  } else {
    MP.offset.x = dx; MP.offset.y = dy; MP.offset.z = dz;
  }
}

/* =============================================================================
   7. PER-FRAME UPDATE  (installed in place of the solo updateWorld)
   ============================================================================= */
function mpUpdate(dt) {
  if (!MP.inMatch) return;

  Game.time += dt;

  /* ---- 1. read local input, mapped into world space via the camera ---- */
  var ctrl = mpReadCtrl();
  clearEdges();

  /* ---- 2. predict the local fighter ---- */
  if (MP.localIndex >= 0) {
    var lm = MP.mirrors[MP.playerId];
    if (lm) {
      var frame = { seq: ++MP.seq, ctrl: ctrl, dt: dt };
      MP.pending.push(frame);
      if (MP.pending.length > 240) MP.pending.shift();
      MP.sim.stepFighter(MP.predict, lm, dt, ctrl);
      MP.offset.x *= Math.exp(-MP_CFG.offsetDecay * dt);
      MP.offset.y *= Math.exp(-MP_CFG.offsetDecay * dt);
      MP.offset.z *= Math.exp(-MP_CFG.offsetDecay * dt);
    }
  }

  /* ---- 3. interpolate everyone else ---- */
  mpInterpolate();

  /* ---- 4. push the simulated state onto the real Fighter objects ---- */
  mpApplyMirrors(dt);

  /* ---- 5. world visuals that the server owns ---- */
  mpUpdateHazards(dt);
  mpUpdatePowerups(dt);
  mpFlushEvents();

  /* ---- 6. camera / particles / fx / HUD ---- */
  updateParticles(dt);
  updateFX(dt);
  updateCamera(dt);
  updatePlatformFading(dt);
  mpVictory(dt);
  updateHUD();
  mpHudExtras();

  /* ---- 7. ship input ---- */
  mpMaybeSendInput(ctrl);
}

function mpReadCtrl() {
  readKeys();
  var cy = Game.camYaw;
  var fwdx = -Math.sin(cy), fwdz = -Math.cos(cy);
  var rx = Math.cos(cy), rz = -Math.sin(cy);
  var wx = fwdx * Input.mz + rx * Input.mx;
  var wz = fwdz * Input.mz + rz * Input.mx;
  var l = Math.hypot(wx, wz);
  var c = {
    dirX: 0, dirZ: 0,
    jump: Input.jumpHeld, jumpPressed: Input.jumpPressed,
    quick: Input.q, heavy: Input.h, dash: Input.dash, ability: Input.ability
  };
  if (l > 0.001) { c.dirX = wx / l; c.dirZ = wz / l; }
  return c;
}

function mpInterpolate() {
  var now = performance.now();
  var rt = now - MP_CFG.interpDelayMs;
  for (var i = 0; i < MP.slotOrder.length; i++) {
    var id = MP.slotOrder[i];
    if (id === MP.playerId) continue;             /* predicted, not interpolated */
    var buf = MP.buffers[id];
    var m = MP.mirrors[id];
    if (!buf || !buf.length || !m) continue;

    var a = null, b = null;
    for (var k = buf.length - 1; k >= 0; k--) {
      if (buf[k].at <= rt) { a = buf[k]; b = buf[k + 1] || null; break; }
    }
    if (!a) { a = buf[0]; b = buf[1] || null; }
    if (!a) continue;

    if (b) {
      var span = Math.max(1, b.at - a.at);
      var t = Math.max(0, Math.min(1, (rt - a.at) / span));
      m.x = lerp(a.s.x, b.s.x, t);
      m.y = lerp(a.s.y, b.s.y, t);
      m.z = lerp(a.s.z, b.s.z, t);
      m.vx = lerp(a.s.vx, b.s.vx, t);
      m.vy = lerp(a.s.vy, b.s.vy, t);
      m.vz = lerp(a.s.vz, b.s.vz, t);
      m.facing = angLerp(a.s.facing, b.s.facing, t);
      mpApplyStateToMirror(m, b.s);
      m.x = lerp(a.s.x, b.s.x, t);
      m.y = lerp(a.s.y, b.s.y, t);
      m.z = lerp(a.s.z, b.s.z, t);
      m.vx = lerp(a.s.vx, b.s.vx, t);
      m.vy = lerp(a.s.vy, b.s.vy, t);
      m.vz = lerp(a.s.vz, b.s.vz, t);
      m.facing = angLerp(a.s.facing, b.s.facing, t);
    } else {
      mpApplyStateToMirror(m, a.s);
    }
  }
}

function mpApplyMirrors(dt) {
  for (var i = 0; i < MP.slotOrder.length; i++) {
    var id = MP.slotOrder[i];
    var f = MP.playerFighter[id];
    var m = MP.mirrors[id];
    if (!f || !m) continue;

    var ox = 0, oy = 0, oz = 0;
    if (id === MP.playerId) { ox = MP.offset.x; oy = MP.offset.y; oz = MP.offset.z; }

    f.pos.set(m.x + ox, m.y + oy, m.z + oz);
    f.vx = m.vx; f.vy = m.vy; f.vz = m.vz;
    f.facing = m.facing;
    f.health = m.health; f.lives = m.lives;
    f.maxHealth = m.def.health;
    f.state = m.state;
    f.onGround = m.onGround; f.jumpsLeft = m.jumpsLeft;
    f.attackType = m.attackType; f.attackT = m.attackT; f.attackPhase = m.attackPhase;
    f.hitstun = m.hitstun; f.moveLock = m.moveLock; f.dashT = m.dashT;
    f.abilityActive = m.abilityActive; f.abilityT = m.abilityT;
    f.abilityCd = m.abilityCd; f.dashCd = m.dashCd;
    f.invuln = m.invuln; f.phaseT = m.phaseT; f.shield = m.shield;
    f.speedBuff = m.speedBuff; f.damageBuff = m.damageBuff; f.dashBuff = m.dashBuff;
    f.flash = m.flash;
    f.koT = m.koT;
    f.kos = m.kos; f.falls = m.falls; f.dmgDealt = m.dmgDealt; f.dmgTaken = m.dmgTaken;

    mpVisualStep(f, dt);
  }
}

/* The rendering half of the original stepFighter: KO tumble, visibility and
   the skeletal animation. No physics — the server already decided those. */
function mpVisualStep(f, dt) {
  if (f.state === 'dead') { f.group.visible = false; return; }
  if (f.state === 'ko') {
    f.model.bodyPivot.rotation.z += dt * 9;
    f.model.bodyPivot.rotation.x += dt * 5;
    updateModelTransform(f, dt);
    return;
  }
  if (f.state === 'respawning') { f.group.visible = true; updateModelTransform(f, dt); return; }
  if (f.model.bodyPivot.rotation.x !== 0 && f.attackT <= 0 && f.hitstun <= 0 && f.abilityActive !== 'smash') {
    /* ease the tumble back to zero after a KO/respawn, same feel as solo */
    f.model.bodyPivot.rotation.x = lerp(f.model.bodyPivot.rotation.x, 0, 0.12);
    f.model.bodyPivot.rotation.z = lerp(f.model.bodyPivot.rotation.z, 0, 0.12);
  }
  updateModelTransform(f, dt);
}

/* --------------------------------------------------------------- hazards -- */
function mpUpdateHazards(dt) {
  if (!hazards.padsEnabled) return;
  for (var i = 0; i < hazards.pads.length; i++) {
    var p = hazards.pads[i];
    var target = p.phase ? 0.55 : -1.35;
    p.grp.position.y += (target - p.grp.position.y) * Math.min(1, dt * 11);
  }
}

/* -------------------------------------------------------------- powerups -- */
function mpSyncPowerups(list) {
  var seen = {};
  for (var i = 0; i < list.length; i++) {
    var id = list[i][0], typeId = list[i][1];
    seen[id] = true;
    var entry = MP.powerMeshes[id];
    if (!entry) {
      var type = null;
      for (var t = 0; t < POWER_TYPES.length; t++) if (POWER_TYPES[t].id === typeId) type = POWER_TYPES[t];
      if (!type) continue;
      var mesh = buildPowerupMesh(type);
      scene.add(mesh);
      entry = MP.powerMeshes[id] = { type: type, pos: new THREE.Vector3(), mesh: mesh, spin: 1 };
    }
    entry.pos.set(list[i][2], list[i][3], list[i][4]);
    entry.life = list[i][5];
    entry.slot = i;
  }
  for (var pid in MP.powerMeshes) {
    if (!seen[pid]) {
      var gone = MP.powerMeshes[pid];
      scene.remove(gone.mesh);
      mpDisposeGroup(gone.mesh);
      delete MP.powerMeshes[pid];
    }
  }
}

function mpUpdatePowerups(dt) {
  for (var id in MP.powerMeshes) {
    var p = MP.powerMeshes[id];
    if (!p || !p.mesh) continue;
    p.mesh.rotation.y += dt * p.spin;
    p.mesh.position.set(p.pos.x, p.pos.y + Math.sin(Game.time * 2 + (p.slot || 0)) * 0.22, p.pos.z);
    (function (mesh, slot) {
      mesh.traverse(function (o) {
        if (o.userData && o.userData.glow && o.material) {
          o.material.opacity = o.userData.baseOp * (0.72 + 0.28 * Math.sin(Game.time * 2.6 + slot * 1.1));
        }
      });
    })(p.mesh, p.slot || 0);
  }
}

/* =============================================================================
   8. SERVER EVENTS -> LOCAL SOUND + PARTICLES
   The server says WHAT happened; this decides how it looks and sounds. Every
   call below is the original game's own FX function.
   ============================================================================= */
function mpFighterByIdx(index) {
  for (var i = 0; i < fighters.length; i++) if (fighters[i].index === index) return fighters[i];
  return null;
}

function mpFlushEvents() {
  var q = MP.eventQueue;
  MP.eventQueue = [];
  for (var i = 0; i < q.length; i++) mpHandleEvent(q[i]);
}

function mpHandleEvent(e) {
  var f;
  switch (e.t) {
    case 'hit': {
      var heavy = !!e.heavy;
      var accent = heavy ? 0xDFF902 : 0xA56BFF;
      impactRing(e.x, e.y, e.z, accent, heavy ? 1.3 : 0.9);
      burst(e.x, e.y, e.z, accent, heavy ? 16 : 10, heavy ? 12 : 8, 0.4, heavy ? 1.1 : 0.85, true);
      if (e.shielded) burst(e.x, e.y, e.z, 0x5CFFE7, 8, 7, 0.35, 0.8, true);
      var n = heavy ? 9 : 6;
      for (var s = 0; s < n; s++) {
        var sm = new THREE.Mesh(pGeo, pmat(0xDFF902, true));
        var sp = rand(9, 18);
        sm.position.set(e.x, e.y, e.z);
        sm.scale.setScalar(rand(0.28, 0.65));
        scene.add(sm);
        particles.push({ m: sm, vx: (e.nx || 0) * sp + rand(-3, 3), vy: rand(1, 5), vz: (e.nz || 0) * sp + rand(-3, 3), life: 0.26, max: 0.26, grav: true, spin: rand(-15, 15), size: 1 });
      }
      if (heavy) SFX.hitHeavy(); else SFX.hitLight();
      Game.shake = Math.max(Game.shake, heavy ? 0.62 : 0.28);
      Game.hitStop = Math.max(Game.hitStop, heavy ? 0.11 : 0.05);
      break;
    }
    case 'swing':
      SFX.swing();
      break;

    case 'ko': {
      var v = mpFighterByIdx(e.victim);
      burst(e.x, e.y, e.z, 0xDFF902, 30, 16, 1.1, 1.4, true);
      burst(e.x, e.y, e.z, 0xA56BFF, 24, 13, 1.0, 1.2, true);
      for (var i = 0; i < 14; i++) {
        var a = (i / 14) * TAU;
        var shard = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshBasicMaterial({ color: i % 2 ? 0xDFF902 : 0xA56BFF }));
        shard.position.set(e.x, e.y, e.z);
        scene.add(shard);
        fxList.push({ m: shard, life: 0.9, max: 0.9, type: 'abilityChip', sc: 1, vx: Math.cos(a) * 11, vy: rand(2, 6), vz: Math.sin(a) * 11 });
      }
      impactRing(e.x, e.y, e.z, 0xDFF902, 1.8);
      impactRing(e.x, e.y, e.z, 0xA56BFF, 1.4);
      SFX.ko();
      Game.shake = 1.1;
      Game.hitStop = Math.max(Game.hitStop, 0.16);
      break;
    }

    case 'fall':
      SFX.fall();
      burst(e.x, e.y, e.z, 0xDFF902, 16, 9, 0.8, 1.1, true);
      burst(e.x, e.y, e.z, 0xA56BFF, 12, 7, 0.8, 1.0, true);
      break;

    case 'respawn':
      impactRing(e.x, e.y + 1.2, e.z, 0xDFF902, 0.8);
      burst(e.x, e.y + 1, e.z, 0xA56BFF, 10, 7, 0.5, 0.8);
      break;

    case 'jump':
      SFX.jump();
      if (e.dbl) {
        for (var d = 0; d < 10; d++) {
          var ang = (d / 10) * TAU;
          burst(e.x + Math.cos(ang) * 0.6, e.y + 0.6, e.z + Math.sin(ang) * 0.6, 0xA56BFF, 1, 3, 0.35, 0.7);
        }
      } else {
        burst(e.x, e.y + 0.1, e.z, 0xDFF902, 6, 4, 0.3, 0.7, false);
      }
      break;

    case 'land': {
      var impact = e.impact || 0;
      SFX.land(impact);
      burst(e.x, e.y + 0.1, e.z, 0xDFF902, 6 + Math.round(impact * 16), 3 + impact * 6, 0.22 + impact * 0.18, 0.5 + impact * 0.7, false);
      if (impact > 0.42) impactRing(e.x, e.y + 0.15, e.z, 0xA56BFF, 0.55 + impact * 0.7);
      var lf = mpFighterByIdx(e.i);
      if (lf) { lf.landSquash = 0.16 + impact * 0.24; lf.landSquashAmt = 0.09 + impact * 0.20; }
      if (impact > 0.5) Game.shake = Math.max(Game.shake, (impact - 0.5) * 0.55);
      break;
    }

    case 'dash': {
      SFX.dash();
      f = mpFighterByIdx(e.i);
      var col = f ? f.def.colors.accent : 0xDFF902;
      for (var c = 0; c < 6; c++) {
        var chip = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.35, 0.35), new THREE.MeshBasicMaterial({ color: col }));
        chip.position.set(e.x - (e.dx || 0) * (c * 0.5), e.y + 0.8, e.z - (e.dz || 0) * (c * 0.5));
        scene.add(chip);
        fxList.push({ m: chip, life: 0.35, max: 0.35, type: 'abilityChip', sc: 1, vx: 0, vy: 1.5, vz: 0 });
      }
      break;
    }

    case 'ability': {
      SFX.ability();
      f = mpFighterByIdx(e.i);
      if (f) {
        var savedPos = f.pos.clone();
        f.pos.set(e.x, e.y, e.z);
        spawnAbilityRing(f);
        f.pos.copy(savedPos);
      }
      break;
    }

    case 'blink': {
      f = mpFighterByIdx(e.i);
      var bcol = f ? f.def.colors.accent : 0xDFF902;
      burst(e.x, e.y + 1, e.z, bcol, 16, 7, 0.5, 0.9);
      impactRing(e.x, e.y + 1.1, e.z, bcol, 1.1);
      Game.shake = Math.max(Game.shake, 0.35);
      break;
    }

    case 'smash': {
      SFX.hitHeavy();
      SFX.noise(0.4, 0.4, 200, 0.7);
      impactRing(e.x, e.y, e.z, 0xDFF902, 2.2);
      burst(e.x, e.y + 0.1, e.z, 0xDFF902, 26, 15, 0.7, 1.2);
      burst(e.x, e.y + 0.1, e.z, 0xA56BFF, 20, 12, 0.7, 1.0, true);
      Game.shake = Math.max(Game.shake, 1.0);
      Game.hitStop = Math.max(Game.hitStop, 0.09);
      break;
    }

    case 'hazard':
      SFX.spike();
      if (e.kind === 'spin') {
        burst(e.x, e.y, e.z, 0xDFF902, 12, 9, 0.5, 1);
        impactRing(e.x, e.y, e.z, 0xFFD36A, 1.0);
      } else {
        burst(e.x, e.y, e.z, 0xA56BFF, 14, 10, 0.5, 1);
        impactRing(e.x, e.y, e.z, 0xFF5B5B, 1.0);
      }
      Game.shake = Math.max(Game.shake, 0.45);
      break;

    case 'padUp':
      burst(e.x, 0.4, e.z, 0xDFF902, 10, 6, 0.4, 0.9);
      break;

    case 'powerSpawn':
      burst(e.x, e.y, e.z, 0xDFF902, 8, 5, 0.4, 0.7);
      break;

    case 'powerup': {
      SFX.power();
      var pu = null;
      for (var w = 0; w < POWER_TYPES.length; w++) if (POWER_TYPES[w].id === e.powerId) pu = POWER_TYPES[w];
      if (e.i === MP.localIndex && pu) announce(pu.name, 0.75, 'small');
      break;
    }

    case 'bump':
      bumpFX(e.x, e.y, e.z, e.nx || 0, e.nz || 0, e.mag || 0.5);
      break;

    case 'announce':
      announce(e.text, e.dur || 1.2, e.small ? 'small' : '');
      if (e.text === '3') SFX.count(3);
      else if (e.text === '2') SFX.count(2);
      else if (e.text === '1') SFX.count(1);
      else if (e.text === 'FIGHT!') SFX.count(0);
      break;
  }
}

/* =============================================================================
   9. HUD EXTRAS + VICTORY
   ============================================================================= */
function mpHudExtras() {
  if (!MP.snap) return;
  var el = $('timer');
  if (el) el.classList.toggle('low', MP.snap.matchTime < 30);
}

function mpVictory(dt) {
  if (MP.victoryStarted && Game.victoryPhase === 'emote') {
    MP.victoryT += dt;
    Game.victoryT = MP.victoryT;
    if (MP.victoryT > 2.6) {
      Game.victoryPhase = null;
      MP.victoryStarted = false;
      if (Game.winner === player) enterPhotoMode();
      else mpShowResults();
    }
  }
}

function mpOnMatchEnd(msg) {
  MP.standings = msg.standings || [];
  MP.winnerId = msg.winnerId;
  MP.matchEndReason = msg.reason;
  MP.showingResults = false;
  MP.victoryStarted = false;
  MP.victoryT = 0;
  MP.spectating = !MP.standings.some(function (s) { return s.id === MP.playerId; });

  Game.over = true;
  Music.stop();

  var winnerIdx = -1;
  for (var i = 0; i < MP.standings.length; i++) if (MP.standings[i].id === MP.winnerId) winnerIdx = i;
  var winStanding = winnerIdx >= 0 ? MP.standings[winnerIdx] : null;
  var wf = winStanding ? MP.playerFighter[winStanding.id] : null;

  announce('GAME OVER!', 1.6);
  SFX.ko();

  if (wf) {
    Game.winner = wf;
    Game.victoryPhase = 'emote';
    Game.victoryT = 0;
    MP.victoryStarted = true;
    MP.victoryT = 0;
    wf._emoteBurstDone = false;
    setTimeout(function () { if (Game.victoryPhase === 'emote') SFX.victory(); }, 350);
  } else {
    setTimeout(mpShowResults, 1200);
  }

  /* after the emote, results for the players who lost or who are spectating */
  setTimeout(function () {
    if (!MP.showingResults && Game.victoryPhase === null) mpShowResults();
  }, 3600);
}

function mpShowResults() {
  if (MP.showingResults) return;
  MP.showingResults = true;
  Game.victoryPhase = null;
  MP.victoryStarted = false;

  var standings = MP.standings || [];
  var mine = null;
  for (var i = 0; i < standings.length; i++) if (standings[i].id === MP.playerId) mine = standings[i];
  var won = MP.winnerId === MP.playerId;
  var winName = 'Nobody';
  for (var j = 0; j < standings.length; j++) if (standings[j].id === MP.winnerId) winName = standings[j].name;

  $('resTitle').textContent = MP.spectating ? 'MATCH OVER' : (won ? 'VICTORY!' : 'DEFEAT');
  $('resSub').textContent = MP.spectating
    ? (winName + ' won the match.')
    : (won ? 'You are the last Viber standing.' : (winName + ' is the last Viber standing.'));
  if (MP.matchEndReason === 'opponent-left' || MP.matchEndReason === 'last-standing') {
    $('resSub').textContent = won
      ? 'Everyone else left — you are the last Viber standing.'
      : winName + ' is the last Viber standing.';
  }

  var PLACE = ['1ST', '2ND', '3RD', '4TH'];
  var podium = '';
  standings.forEach(function (s, idx) {
    var base = mpCharBase(s.charId);
    var col = base ? '#' + base.colors.accent.toString(16).padStart(6, '0') : '#DFF902';
    var isMe = s.id === MP.playerId;
    podium +=
      '<div class="mp-standrow' + (s.winner ? ' win' : '') + (isMe ? ' you' : '') + (s.disconnected ? ' gone' : '') + '">' +
        '<span class="mp-standplace">' + (PLACE[idx] || (idx + 1) + 'TH') + '</span>' +
        '<span class="rr-swatch" style="background:' + col + '"></span>' +
        '<span class="mp-standname">' + mpEsc(shortName(s.name)) + (isMe ? '<span class="rr-you">YOU</span>' : '') +
          (s.disconnected ? ' <span class="rr-type">LEFT</span>' : '') + '</span>' +
        '<span class="rr-type">' + mpEsc(base ? base.tag : '') + '</span>' +
        '<span class="mp-standstats"><b>' + s.kos + '</b> KO &middot; ' + Math.round(s.dmgDealt) + ' dmg dealt &middot; ' +
          Math.round(s.dmgTaken) + ' taken &middot; ' + s.falls + ' falls &middot; ' + s.lives + ' lives left</span>' +
      '</div>';
  });

  $('resStats').innerHTML =
    (mine
      ? '<div class="rr-tiles">' +
          '<div class="rr-tile"><span class="rr-tl">Knockouts</span><span class="rr-tv">' + mine.kos + '</span></div>' +
          '<div class="rr-tile"><span class="rr-tl">Damage dealt</span><span class="rr-tv">' + Math.round(mine.dmgDealt) + '</span></div>' +
          '<div class="rr-tile"><span class="rr-tl">Placement</span><span class="rr-tv">' + (mine.placement || '-') + '</span></div>' +
        '</div>'
      : '<div class="mp-spectate">SPECTATING</div>') +
    '<h4 class="rr-h">FINAL STANDINGS</h4>' +
    '<div class="rr-podium">' + podium + '</div>' +
    '<div class="rr-foot">' +
      '<span>ROOM ' + MP.roomCode + '</span>' +
      '<span>' + MAPS[Game.map].name + '</span>' +
      '<span>HARD</span>' +
      '<span>2–4 PLAYERS</span>' +
    '</div>';

  ui.hud.classList.remove('on');
  showScreen('scrResults');
  $('btnRematch').textContent = 'BACK TO ROOM';
}

/* =============================================================================
   10. INPUT TRANSPORT
   ============================================================================= */
function mpMaybeSendInput(ctrl) {
  var now = performance.now();
  var edges = ctrl.jumpPressed || ctrl.quick || ctrl.heavy || ctrl.dash || ctrl.ability;
  var due = (now - MP.lastSendAt) >= MP_CFG.inputIntervalMs;
  if (!edges && !due) return;
  if (MP.seq === MP.lastSentSeq) return;      /* nothing new to say */
  MP.lastSendAt = now;
  MP.lastSentSeq = MP.seq;
  MP.lastSentCtrl = { seq: MP.seq, jumpPressed: !!ctrl.jumpPressed, edges: !!edges };
  mpSend({
    t: 'input',
    seq: MP.seq,
    dirX: +ctrl.dirX.toFixed(4),
    dirZ: +ctrl.dirZ.toFixed(4),
    jump: !!ctrl.jump,
    jumpPressed: !!ctrl.jumpPressed,
    quick: !!ctrl.quick,
    heavy: !!ctrl.heavy,
    dash: !!ctrl.dash,
    ability: !!ctrl.ability
  });
}

/* ---------------------------------------------------------------------------
   The original buildCards() hardcodes exactly four fighters, which throws on a
   2- or 3-player online roster. This is the multiplayer version — same markup,
   same classes, driven by the actual roster size. Solo keeps the original.
   --------------------------------------------------------------------------- */
var ORIG_BUILD_CARDS = window.buildCards;
window.buildCards = function () {
  if (!MP.inMatch) return ORIG_BUILD_CARDS.apply(this, arguments);
  var cards = document.getElementById('cards');
  if (!cards) return;
  cards.innerHTML = '';
  for (var i = 0; i < fighters.length; i++) {
    var f = fighters[i];
    var c = document.createElement('div');
    c.className = 'pcard'; c.id = 'card' + i;
    var col = '#' + f.def.colors.accent.toString(16).padStart(6, '0');
    c.innerHTML =
      '<div class="pname"><span class="dot" style="background:' + col + '"></span>' +
      '<span class="lbl">' + f.def.name.split(' ')[0] + '</span></div>' +
      '<div class="hbar"><i></i></div><div class="lives"></div>';
    cards.appendChild(c);
  }
  updateHUD(true);
};

/* =============================================================================
   11. HOOKS INTO THE ORIGINAL GAME
   ============================================================================= */
var ORIG_UPDATE_WORLD = window.updateWorld;
var ORIG_TOGGLE_PAUSE = window.togglePause;
var ORIG_RESET_TO_MENU = window.resetToMenu;

/* The single integration point for the per-frame loop. Solo play falls
   straight through to the untouched original. */
window.updateWorld = function (dt) {
  if (MP.inMatch) { mpUpdate(dt); return; }
  return ORIG_UPDATE_WORLD(dt);
};

/* One client may never freeze an online match. Pause stays a solo feature. */
window.togglePause = function () {
  if (MP.inMatch) { mpBanner('Pause is disabled online — leave the match instead', true); setTimeout(function () { mpBanner(null); }, 1800); return; }
  return ORIG_TOGGLE_PAUSE();
};

window.resetToMenu = function () {
  if (MP.active) mpLeaveRoom(true);
  return ORIG_RESET_TO_MENU();
};

/* The original results screen knows about AI behaviours; online it must show
   the server's standings instead. Captured BEFORE the override so there is no
   recursion. */
var ORIG_SHOW_RESULTS = window.showResults;
window.showResults = function () {
  if (MP.inMatch || MP.standings) {
    if (MP.showingResults) { showScreen('scrResults'); return; }   /* already built */
    mpShowResults();
    return;
  }
  return ORIG_SHOW_RESULTS.apply(this, arguments);
};

/* Menu: add MULTIPLAYER directly under PLAY, and ACCOUNT under that. */
(function mpAddMenuButton() {
  var play = $('btnPlay');
  if (!play) return;

  var b = document.createElement('button');
  b.className = 'btn green';
  b.id = 'btnMultiplayer';
  b.textContent = 'MULTIPLAYER';
  play.insertAdjacentElement('afterend', b);

  var acct = document.createElement('button');
  acct.className = 'btn blue';
  acct.id = 'btnAccount';
  acct.textContent = 'ACCOUNT';
  b.insertAdjacentElement('afterend', acct);

  var prof = document.createElement('button');
  prof.className = 'btn pink';
  prof.id = 'btnProfile';
  prof.textContent = 'PROFILE';
  acct.insertAdjacentElement('afterend', prof);

  b.addEventListener('click', function () {
    SFX.init(); SFX.resume(); SFX.click();
    MP.active = true;
    mpMsg('mpMsg', '', '');
    showScreen('scrMP');
    /* NOTE: the guest identity is deliberately NOT created here. It is created
       when the player actually creates or joins a room, because by then they
       have typed a name — creating it here would lock in the placeholder
       "VIBER" and the server would then override whatever they typed. */
    var n = $('mpName');
    if (n && !n.value) {
      var A = window.__VB_ACCOUNT;
      if (A && A.suggestedName) n.value = A.suggestedName() || '';
    }
    if (n) n.focus();
  });

  acct.addEventListener('click', function () {
    SFX.init(); SFX.resume(); SFX.click();
    MP.active = true;
    var A = window.__VB_ACCOUNT;
    if (A && A.open) A.open();
  });

  prof.addEventListener('click', function () {
    SFX.init(); SFX.resume(); SFX.click();
    MP.active = true;
    var P = window.__VB_PROFILE;
    if (P && P.open) P.open();
  });

  var back = $('btnAcctBack');
  if (back) back.addEventListener('click', function () { SFX.click(); showScreen('scrMenu'); });

  var pback = $('btnProfileBack');
  if (pback) pback.addEventListener('click', function () { SFX.click(); showScreen('scrMenu'); });
})();

/* Intercept the results-screen buttons online. A capture-phase listener on
   document runs BEFORE the original handlers, so we can divert them without
   editing the original wiring. */
document.addEventListener('click', function (ev) {
  var t = ev.target;
  if (!t || !t.id) return;
  if (!MP.showingResults) return;
  if (t.id === 'btnRematch') {
    ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
    SFX.click();
    MP.showingResults = false;
    MP.standings = null;
    mpSend({ t: 'rematch' });
    showScreen('scrLobby');
  } else if (t.id === 'btnMenu') {
    ev.preventDefault(); ev.stopPropagation(); ev.stopImmediatePropagation();
    SFX.click();
    MP.showingResults = false;
    MP.standings = null;
    mpLeaveRoom(false);
    showScreen('scrMP');
  }
}, true);

/* =============================================================================
   12. ROOM ACTIONS + BUTTON WIRING
   ============================================================================= */
function mpLeaveRoom(silent) {
  if (MP.ws && MP.ws.readyState === 1) mpSend({ t: 'leave' });
  if (MP.ws) { try { MP.ws.close(1000, 'left'); } catch (e) {} }
  MP.ws = null;
  /* A deliberate exit forgets the identity, so rejoining is a fresh player
     rather than a reconnect into the seat we just walked away from. */
  MP.token = null;
  try { sessionStorage.removeItem('viberbrawl_mp_token'); } catch (e) {}
  mpTeardownMatch();
  /* Restore the solo four-fighter roster. The original resetToMenu() (and
     several other original functions) assume exactly four fighters exist, so
     leaving an online match must put the roster back before anything else in
     the original code runs. */
  mpClearFighters();
  createFighters();
  player = fighters[Game.selectedChar] || fighters[0];
  Game.mode = 'menu';
  Game.over = false;
  Game.paused = false;
  Game.victoryPhase = null;
  Game.winner = null;
  applyHazardsForDifficulty(Game.difficulty);
  applyMap(Game.map);
  MP.active = false;
  MP.status = 'idle';
  MP.players = [];
  MP.roster = null;
  MP.standings = null;
  MP.showingResults = false;
  if (!silent) { mpNet('idle', 'disconnected'); }
}

(function mpWire() {
  var nameEl = $('mpName');
  var codeEl = $('mpCode');
  if (!nameEl || !codeEl) { console.error('[MP] UI elements missing — was the multiplayer markup injected?'); return; }

  try { nameEl.value = localStorage.getItem('viberbrawl_mp_name') || ''; } catch (e) {}
  /* per-window identity, NOT per-browser — see the note in the welcome handler */
  try { MP.token = sessionStorage.getItem('viberbrawl_mp_token') || null; } catch (e) {}

  function readName() {
    var v = (nameEl.value || '').replace(/\s+/g, ' ').trim().slice(0, 14) || 'VIBER';
    MP.name = v;
    try { localStorage.setItem('viberbrawl_mp_name', v); } catch (e) {}
    return v;
  }
  MP.readName = readName;

  /* Create the identity only once the player has told us their name, otherwise
     the server-side identity is created as "VIBER" and then overrides the name
     they just typed. Failure is non-fatal: you can always play with no account. */
  function withIdentity(fn) {
    var A = window.__VB_ACCOUNT;
    if (A && A.ensureGuest) {
      A.ensureGuest()
        .then(function () { return A.syncGuestName(MP.name); })
        .then(fn, fn);
    } else fn();
  }

  $('btnCreateRoom').addEventListener('click', function () {
    SFX.init(); SFX.resume(); SFX.click();
    readName();
    MP.spectating = false;
    withIdentity(function () { mpConnect({ create: true }); });
  });

  $('btnJoinRoom').addEventListener('click', function () {
    SFX.init(); SFX.resume(); SFX.click();
    readName();
    var code = (codeEl.value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 3) { mpMsg('mpMsg', 'Enter the 5-character room code.', 'bad'); return; }
    codeEl.value = code;
    MP.spectating = false;
    withIdentity(function () { mpConnect({ room: code, create: false }); });
  });

  codeEl.addEventListener('input', function () {
    codeEl.value = codeEl.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  });
  codeEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') $('btnJoinRoom').click(); });
  nameEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') codeEl.focus(); });

  $('btnMpBack').addEventListener('click', function () {
    SFX.click();
    mpLeaveRoom(true);
    showScreen('scrMenu');
  });

  $('btnReady').addEventListener('click', function () {
    SFX.init(); SFX.resume(); SFX.click();
    var me = mpMe();
    if (!me) return;
    if (!me.charId) { mpMsg('mpLobbyMsg', 'Pick a Viber first.', 'bad'); return; }
    mpSend({ t: 'ready', ready: !me.ready });
  });

  $('btnStartMatch').addEventListener('click', function () {
    SFX.click();
    if (!MP.canStart) { mpMsg('mpLobbyMsg', MP.blockReason || 'Not ready yet', 'bad'); return; }
    mpSend({ t: 'start' });
  });

  $('btnLeaveRoom').addEventListener('click', function () {
    SFX.click();
    mpLeaveRoom(false);
    showScreen('scrMP');
  });

  $('btnCopyInvite').addEventListener('click', function () {
    SFX.click();
    var link = location.origin + location.pathname + '?mp=' + encodeURIComponent(MP_SERVER) + '&room=' + MP.roomCode;
    function done() { $('btnCopyInvite').textContent = 'COPIED!'; setTimeout(function () { $('btnCopyInvite').textContent = 'COPY INVITE LINK'; }, 1500); }
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(link).then(done, done);
      else done();
    } catch (e) { done(); }
  });

  /* Auto-join from a URL, e.g. ?room=X7K4Q  or  ?mp=https://…&room=X7K4Q */
  var params = new URLSearchParams(location.search);
  var auto = (params.get('room') || '').toUpperCase();
  if (auto) {
    codeEl.value = auto;
    var stored = '';
    try { stored = localStorage.getItem('viberbrawl_mp_name') || ''; } catch (e) {}
    MP.name = stored || 'VIBER';
    MP.active = true;
    showScreen('scrMP');
    mpMsg('mpMsg', 'Joining room ' + auto + '…', '');
    /* No fixed delay: if the core is already loaded, go now; otherwise the
       import handler replays this connection the moment it is ready. */
    if (MP.simReady) setTimeout(function () { mpConnect({ room: auto, create: false }); }, 120);
    else MP.pendingConnect = { room: auto, create: false };
  }
})();

/* Keep the exposed object useful for verification from the console. */
MP.leaveRoom = mpLeaveRoom;
MP.connect = mpConnect;
MP.showResults = mpShowResults;
MP.rebuildPredictFighters = mpRebuildPredictFighters;

console.log('[MP] multiplayer layer installed. server=' + MP_SERVER + ' sim=' + MP_SIM_URL);
})();
