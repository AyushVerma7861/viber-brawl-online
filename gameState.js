/* =============================================================================
   gameState.js — the ROOM model (lobby + match lifecycle bookkeeping).

   This is deliberately separate from `sim.js`:
     * sim.js        = pure gameplay (movement, combat, hazards, powerups)
     * gameState.js  = who is in the room, what they picked, who is ready,
                       whose turn it is to host, and the standings table.

   The critical disconnect rule lives here:
     A player who drops is REMOVED. `removePlayer()` never creates a
     replacement, never flips a flag to "bot", and never lets anything other
     than a human drive a fighter slot. The authoritative match simply loses
     one fighter.
   ============================================================================= */

import { CFG, CHAR_STATS, CHAR_ORDER, PHASE, createMatchState, seedMatch } from '../../public/shared/sim.js';
import { MAX_PLAYERS, RECONNECT_GRACE_MS, sanitizeName } from './protocol.js';

/* --------------------------------------------------------------------------- */
export function createPlayer({ id, name, token, socketId, accountId, guestId, displayName }) {
  return {
    id,                                   /* stable per-player identity        */
    name: sanitizeName(name, 'VIBER'),
    token,                                /* reconnect token (client-held)     */
    socketId,                             /* current live socket, or null      */
    /* --- durable identity (resolved by the Worker from the session) --------
       accountId  set when signed in
       guestId    set for a player who has not signed in yet
       playerKey  what match results are filed under — accountId when signed in,
                  otherwise the guest id, otherwise the per-room id. A guest who
                  later signs in keeps their history because the upgrade rewrites
                  this key rather than starting over. */
    accountId: accountId || null,
    guestId: guestId || null,
    displayName: displayName ? sanitizeName(displayName, 'VIBER') : null,
    connected: true,
    charId: null,                         /* chosen Viber                      */
    ready: false,
    isHost: false,
    /* match bookkeeping */
    inMatch: false,                       /* has a fighter in the live sim     */
    fighterIndex: -1,
    inputSeq: 0,                          /* last seq consumed by the server   */
    lastCtrl: null,
    /* One-shot button presses (jump / attack / dash / ability) that have arrived
       but not yet been consumed by a tick. See BattleRoom._stepOnce for why this
       has to exist: `lastCtrl` persists between ticks, so without this an edge
       would fire again on the very next tick and silently eat the double jump. */
    pendingEdges: { jumpPressed: false, quick: false, heavy: false, dash: false, ability: false },
    lastSeen: Date.now(),
    joinedAt: Date.now(),
    /* results */
    placement: 0,
    kos: 0, falls: 0, dmgDealt: 0, dmgTaken: 0
  };
}

/** The key a player's match results are filed under. */
export function playerKeyOf(p) {
  return p.accountId || p.guestId || p.id;
}

/* --------------------------------------------------------------------------- */
export class RoomState {
  constructor(code, seed) {
    this.code = code;
    this.seed = seed >>> 0;
    this.players = new Map();          /* id -> player                      */
    this.match = null;                 /* MatchState | null                 */
    this.phase = PHASE.LOBBY;
    this.matchNo = 0;
    this.createdAt = Date.now();
    this.lastActivity = Date.now();
    this.dirtyLobby = true;
    this.lastStandings = null;
    this.lastResultRows = null;
    this.log = [];
    /* match reporting — see buildMatchReport() */
    this.matchId = null;
    this.matchStartedAt = 0;
    this.matchEndedAt = 0;
    this.matchWinnerKey = null;
    this.matchEndReason = null;
    this.matchReported = false;      /* true once D1 has accepted this match   */
    this.mapId = null;
  }

  /* ------------------------------------------------------------ membership -- */
  get connectedPlayers() {
    let n = 0;
    for (const p of this.players.values()) if (p.connected) n++;
    return n;
  }

  get allPlayers() { return [...this.players.values()]; }

  /**
   * A name that is unique among the connected players in this room.
   *
   * Called on join AND again after the account identity is applied, because the
   * account's display name arrives from outside the room and would otherwise
   * bypass the uniqueness rule entirely.
   */
  uniqueName(desired, exceptId) {
    const base = sanitizeName(desired, 'VIBER');
    const taken = new Set();
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      if (exceptId && p.id === exceptId) continue;
      taken.add(p.name.toLowerCase());
    }
    if (!taken.has(base.toLowerCase())) return base;
    let n = 2;
    while (taken.has((base + ' ' + n).toLowerCase())) n++;
    return (base + ' ' + n).slice(0, 14);
  }

  get host() {
    for (const p of this.players.values()) if (p.isHost && p.connected) return p;
    return null;
  }

  findByToken(token) {
    if (!token) return null;
    for (const p of this.players.values()) if (p.token === token) return p;
    return null;
  }

  /* Which Viber ids are spoken for by a connected player. */
  takenChars(exceptId) {
    const taken = new Set();
    for (const p of this.players.values()) {
      if (!p.connected) continue;
      if (p.id === exceptId) continue;
      if (p.charId) taken.add(p.charId);
    }
    return taken;
  }

  firstFreeChar(exceptId) {
    const taken = this.takenChars(exceptId);
    for (const id of CHAR_ORDER) if (!taken.has(id)) return id;
    return null;
  }

  canJoin() {
    if (this.connectedPlayers < MAX_PLAYERS) return true;
    /* a disconnected slot whose grace window has not expired still counts as
       reclaimable, so the room is not permanently full because of a drop */
    return false;
  }

  addPlayer({ id, name, token, socketId, accountId, guestId, displayName }) {
    const p = createPlayer({ id, name, token, socketId, accountId, guestId, displayName });
    /* Two windows of the same browser share the saved name, and two accounts can
       legitimately have similar names — so make names unique among the players
       actually in this room, or the lobby reads as one person listed twice. */
    p.name = this.uniqueName(p.name, p.id);
    if (!this.host) p.isHost = true;
    /* auto-assign a free Viber so a player is never in an unplayable state */
    const free = this.firstFreeChar(p.id);
    if (free) p.charId = free;
    this.players.set(id, p);
    this.lastActivity = Date.now();
    this.dirtyLobby = true;
    this.log.push({ at: Date.now(), ev: 'join', id, name: p.name });
    return p;
  }

  /**
   * Remove a player from the room ENTIRELY.
   *
   * This is the single place that implements the "never replace a human with
   * AI" rule: there is no code path here that substitutes a bot, and the match
   * sim is simply told to drop the fighter.
   *
   * @returns {{ player, wasHost, inMatch, remaining, matchEnded, winnerId }}
   */
  removePlayer(id, reason) {
    const p = this.players.get(id);
    if (!p) return null;

    const wasHost = p.isHost;
    const inMatch = p.inMatch;
    p.connected = false;
    p.socketId = null;
    p.ready = false;

    let matchEnded = false;
    let winnerId = null;

    if (inMatch && this.match && this.phase !== PHASE.OVER) {
      /* Remove the fighter from the live simulation. The character disappears
         from the arena. Nothing takes its place. */
      const idx = p.fighterIndex;
      if (idx >= 0 && idx < this.match.fighters.length) {
        const f = this.match.fighters[idx];
        if (f) {
          f.state = 'dead';
          f.lives = 0;
          f.health = 0;
          f.removed = true;
        }
      }
      p.inMatch = false;
      p.fighterIndex = -1;

      /* If only one human is still fighting, the server ends the match and
         declares that human the winner. */
      const stillIn = [...this.players.values()].filter(x => x.inMatch && x.connected);
      if (stillIn.length <= 1) {
        this.endMatch(stillIn.length === 1 ? stillIn[0].id : null, 'opponent-left');
        matchEnded = true;
        winnerId = this.match ? this.match.winnerId : null;
      }
    }

    this.players.delete(id);
    this.lastActivity = Date.now();
    this.dirtyLobby = true;
    this.log.push({ at: Date.now(), ev: 'leave', id, name: p.name, reason: reason || 'left' });

    /* Host ownership is a LOBBY concern only — the simulation never depends on
       it, so the room keeps working even if the creator leaves. */
    if (wasHost) {
      const next = this.allPlayers.find(x => x.connected);
      if (next) next.isHost = true;
    }

    /* A match that loses a participant can leave the remaining fighters with
       no valid opponent count; re-check the end condition. */
    if (this.match && this.phase !== PHASE.OVER && this.phase !== PHASE.LOBBY) {
      const alive = this.match.fighters.filter(f => !f.removed && f.lives > 0);
      if (alive.length <= 1 && this.humanFighterCount() <= 1) {
        const rem = [...this.players.values()].find(x => x.inMatch && x.connected);
        this.endMatch(rem ? rem.id : null, 'last-standing');
        matchEnded = true;
        winnerId = this.match.winnerId;
      }
    }

    /* Release the Viber so someone else can pick it. */
    return {
      player: p, wasHost, inMatch,
      remaining: this.connectedPlayers,
      matchEnded, winnerId
    };
  }

  /** Hard-remove players whose reconnect grace window has expired. */
  pruneExpired(now) {
    const gone = [];
    for (const p of this.allPlayers) {
      if (!p.connected && (now - p.lastSeen) > RECONNECT_GRACE_MS) gone.push(p.id);
    }
    return gone;
  }

  /* ---------------------------------------------------------------- lobby -- */
  humanFighterCount() {
    let n = 0;
    for (const p of this.allPlayers) if (p.inMatch && p.connected) n++;
    return n;
  }

  canStart() {
    if (this.phase === PHASE.COUNTDOWN || this.phase === PHASE.PLAYING) return false;
    const list = this.allPlayers.filter(p => p.connected);
    if (list.length < 2) return false;
    if (!list.every(p => p.ready && p.charId)) return false;
    const ids = new Set(list.map(p => p.charId));
    return ids.size === list.length;
  }

  startBlockReason() {
    const list = this.allPlayers.filter(p => p.connected);
    if (list.length < 2) return 'Need at least 2 players';
    const notReady = list.filter(p => !p.ready);
    if (notReady.length) return notReady.length + ' player(s) not ready';
    const missing = list.filter(p => !p.charId);
    if (missing.length) return 'A player has not picked a Viber';
    const ids = new Set(list.map(p => p.charId));
    if (ids.size !== list.length) return 'Two players share a Viber';
    return null;
  }

  lobbyPayload(extra) {
    const host = this.host;
    const payload = Object.assign({
      t: 'lobby',
      roomCode: this.code,
      phase: this.phase,
      matchNo: this.matchNo,
      hostId: host ? host.id : null,
      canStart: this.canStart(),
      blockReason: this.startBlockReason(),
      players: this.allPlayers
        .sort((a, b) => a.joinedAt - b.joinedAt)
        .map(p => ({
          id: p.id,
          name: p.name,
          charId: p.charId,
          ready: p.ready,
          connected: p.connected,
          isHost: p.isHost,
          inMatch: p.inMatch
        }))
    }, extra || {});

    /* When a match is live, ship the exact roster (id -> fighter index) so the
       client can build the right Viber model in the right slot without
       guessing from array positions. */
    if (this.match && (this.phase === PHASE.COUNTDOWN || this.phase === PHASE.PLAYING || this.phase === PHASE.OVER)) {
      payload.roster = this.match.fighters.map(f => ({
        id: f.id,
        index: f.index,
        charId: f.charId,
        name: (this.players.get(f.id) || {}).name || 'VIBER'
      }));
    }
    return payload;
  }

  /* ---------------------------------------------------------------- match -- */
  startMatch() {
    if (!this.canStart()) return false;
    const list = this.allPlayers.filter(p => p.connected).sort((a, b) => a.joinedAt - b.joinedAt);
    this.matchNo++;
    /* A stable id for this match, so its result can be written to D1 exactly
       once no matter how many times the end-of-match path runs. */
    this.matchId = (crypto && crypto.randomUUID)
      ? crypto.randomUUID()
      : (this.code + '-' + this.matchNo + '-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10));
    this.matchStartedAt = Date.now();
    this.matchEndedAt = 0;
    this.matchReported = false;
    this.matchWinnerKey = null;
    /* Re-seed the RNG per match so gameplay randomness is still server-owned
       but a rematch is not a byte-for-byte repeat. */
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    const match = createMatchState({
      seed: this.seed ^ (this.matchNo * 2654435761),
      hardHazards: true          /* spin rod + spike pads: the 'hard' loadout   */
    });
    match.hazards.padsEnabled = true;
    match.hazards.spinEnabled = true;

    const slots = list.map((p, i) => ({ id: p.id, charId: p.charId, index: i }));
    seedMatch(match, slots, { rng: match.rng });

    match.fighters.forEach((f, i) => {
      const p = list[i];
      p.inMatch = true;
      p.fighterIndex = i;
      p.inputSeq = 0;
      p.lastCtrl = null;
      /* drop any press latched before the whistle, so the match cannot open with
         a phantom jump or swing */
      p.pendingEdges = { jumpPressed: false, quick: false, heavy: false, dash: false, ability: false };
      p.placement = 0;
      p.kos = 0; p.falls = 0; p.dmgDealt = 0; p.dmgTaken = 0;
      f.playerId = p.id;
    });

    this.match = match;
    this.phase = PHASE.COUNTDOWN;
    this.dirtyLobby = true;
    this.lastActivity = Date.now();
    return true;
  }

  endMatch(forcedWinnerId, reason) {
    if (!this.match) return;
    if (this.phase === PHASE.OVER && !forcedWinnerId) return;
    const m = this.match;
    m.over = true;
    m.phase = PHASE.OVER;
    if (forcedWinnerId) {
      m.winnerId = forcedWinnerId;
      const wf = m.fighters.find(f => f.playerId === forcedWinnerId);
      m.winner = wf ? wf.index : -1;
    }
    this.phase = PHASE.OVER;

    /* Snapshot per-player stats into the room so the results screen survives
       the fighters being cleared. */
    const standings = [];
    const resultRows = [];
    for (const p of this.allPlayers) {
      const f = m.fighters.find(x => x.playerId === p.id);
      if (f) {
        p.kos = f.kos; p.falls = f.falls;
        p.dmgDealt = Math.round(f.dmgDealt); p.dmgTaken = Math.round(f.dmgTaken);
      }
      standings.push({
        id: p.id, name: p.name, charId: p.charId,
        lives: f ? f.lives : 0,
        kos: p.kos, falls: p.falls,
        dmgDealt: p.dmgDealt, dmgTaken: p.dmgTaken,
        winner: p.id === m.winnerId,
        disconnected: !p.connected
      });
      /* The internal record for D1, kept separate from `standings` on purpose:
         standings are broadcast to every player, and account/guest ids are
         nobody else's business. Captured HERE, at end-of-match time, because a
         player who left is removed from `this.players` moments later and would
         otherwise vanish from the match record entirely. */
      resultRows.push({
        playerKey: playerKeyOf(p),
        accountId: p.accountId || null,
        guestId: p.guestId || null,
        displayName: p.displayName || p.name,
        charId: p.charId || 'miner',
        playerId: p.id
      });
    }
    standings.sort((a, b) => {
      if (a.winner !== b.winner) return a.winner ? -1 : 1;
      if (b.lives !== a.lives) return b.lives - a.lives;
      if (b.kos !== a.kos) return b.kos - a.kos;
      return b.dmgDealt - a.dmgDealt;
    });
    standings.forEach((s, i) => { s.placement = i + 1; });

    /* Winner gets the win recorded on the room-side player record. */
    for (const p of this.allPlayers) {
      const s = standings.find(x => x.id === p.id);
      if (s) p.placement = s.placement;
      p.inMatch = false;
      p.fighterIndex = -1;
      p.ready = false;    /* everyone must re-ready for a rematch */
    }
    this.lastStandings = standings;
    this.lastResultRows = resultRows;
    this.matchEndReason = reason || 'normal';
    this.matchEndedAt = Date.now();
    const winnerStanding = standings.find(s => s.winner);
    const winnerPlayer = winnerStanding ? this.players.get(winnerStanding.id) : null;
    this.matchWinnerKey = winnerPlayer ? playerKeyOf(winnerPlayer) : null;
    this.dirtyLobby = true;
    this.lastActivity = Date.now();
    return standings;
  }

  /**
   * The payload written to D1 when a match finishes. Built entirely from
   * server-side state — there is no path for a client to influence any value
   * in here. Returns null when there is nothing worth recording.
   */
  buildMatchReport(rulesetHash) {
    if (!this.matchId || !this.lastStandings || !this.lastStandings.length) return null;
    const rows = this.lastResultRows || [];
    const players = [];
    for (const s of this.lastStandings) {
      /* Prefer the identity captured at end-of-match time. Falling back to a
         live lookup would drop any player who has already been removed from the
         room — which is exactly what happens to whoever leaves first. */
      const snap = rows.find(r => r.playerId === s.id);
      const live = this.players.get(s.id);
      const identity = snap || (live ? {
        playerKey: playerKeyOf(live),
        accountId: live.accountId || null,
        guestId: live.guestId || null,
        displayName: live.displayName || live.name
      } : null);
      if (!identity || !identity.playerKey) continue;
      players.push({
        playerKey: identity.playerKey,
        accountId: identity.accountId || null,
        guestId: identity.guestId || null,
        displayName: identity.displayName || s.name,
        charId: s.charId || identity.charId || 'miner',
        placement: s.placement,
        lives: s.lives,
        kos: s.kos,
        falls: s.falls,
        dmgDealt: s.dmgDealt,
        dmgTaken: s.dmgTaken,
        winner: !!s.winner,
        disconnected: !!s.disconnected
      });
    }
    if (!players.length) return null;
    return {
      matchId: this.matchId,
      roomCode: this.code,
      map: this.mapId || null,
      rulesetHash: rulesetHash || null,
      startedAt: this.matchStartedAt,
      endedAt: this.matchEndedAt || Date.now(),
      endReason: this.matchEndReason || 'normal',
      winnerPlayerKey: this.matchWinnerKey,
      players
    };
  }

  /** After a match, return everyone to the lobby ready for a rematch. */
  resetToLobby() {
    this.match = null;
    this.phase = PHASE.LOBBY;
    this.lastResultRows = null;
    for (const p of this.allPlayers) {
      p.inMatch = false;
      p.fighterIndex = -1;
      p.ready = false;
      p.inputSeq = 0;
      p.lastCtrl = null;
    }
    this.dirtyLobby = true;
    this.lastActivity = Date.now();
  }

  isIdle(now) {
    if (this.connectedPlayers > 0) return false;
    return (now - this.lastActivity) > 15 * 60 * 1000;
  }
}

export { CFG, CHAR_STATS, CHAR_ORDER, PHASE };
