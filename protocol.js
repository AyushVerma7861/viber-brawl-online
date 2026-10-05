/* =============================================================================
   protocol.js — wire format for the Viber Brawl multiplayer link.

   Design goals:
     * Compact. A 4-player snapshot is broadcast 20x/second, so it is sent as
       arrays with a fixed field order rather than objects with long keys.
     * Sequence-numbered. Every client input carries a monotonic `seq`; every
       snapshot carries the `ack` (highest seq the server has consumed for that
       client) plus the server `tick`. Stale packets are simply ignored.
     * Authoritative. There is no client->server message that can carry damage,
       HP, position, KO, stocks or a winner. The only gameplay message a client
       may send is an INPUT.
   ============================================================================= */

export const TICK_HZ = 60;
export const TICK_MS = 1000 / TICK_HZ;
export const SNAPSHOT_EVERY = 3;              /* -> 20 snapshots / second      */
export const MAX_PLAYERS = 4;
export const ROOM_CODE_LEN = 5;
export const ROOM_IDLE_MS = 15 * 60 * 1000;   /* reap an empty room after 15m  */
export const RECONNECT_GRACE_MS = 25 * 1000;  /* identity held this long       */
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; /* no I/O/0/1 */

/* ---------------------------------------------------------------- C -> S ---- */
export const C2S = {
  HELLO:    'hello',     /* { t, name, token? }                                */
  SELECT:   'select',    /* { t, charId }                                      */
  READY:    'ready',     /* { t, ready }                                       */
  START:    'start',     /* { t }  — any player may ask to start               */
  INPUT:    'input',     /* { t, seq, dirX, dirZ, jump, jumpPressed, quick,
                              heavy, dash, ability }                            */
  LEAVE:    'leave',     /* { t }                                              */
  REMATCH:  'rematch',   /* { t }                                              */
  PING:     'ping'       /* { t, ts }                                          */
};

/* ---------------------------------------------------------------- S -> C ---- */
export const S2C = {
  WELCOME:  'welcome',   /* { t, you, roomCode, token, config }                */
  LOBBY:    'lobby',     /* { t, players[], phase, hostId, canStart, msg }     */
  SNAPSHOT: 'snapshot',  /* { t, tick, ack, phase, matchTime, countdown,
                              players[], powerups[], hazards, events[] }        */
  MATCHEND: 'matchend',  /* { t, winnerId, standings[] }                       */
  PLAYER_GONE:'playerGone',/* { t, id, name, reason }                          */
  ERROR:    'error',     /* { t, code, message }                               */
  PONG:     'pong'       /* { t, ts, serverTime }                              */
};

export const ERR = {
  ROOM_FULL:      'room_full',
  ROOM_NOT_FOUND: 'room_not_found',
  MATCH_RUNNING:  'match_running',
  BAD_CHAR:       'bad_char',
  CHAR_TAKEN:     'char_taken',
  NOT_READY:      'not_ready',
  BAD_MESSAGE:    'bad_message'
};

/* --------------------------------------------------------------- helpers ---- */
export function randomRoomCode(len, rng) {
  const n = len || ROOM_CODE_LEN;
  let out = '';
  for (let i = 0; i < n; i++) {
    out += ROOM_CODE_ALPHABET[Math.floor((rng ? rng() : Math.random()) * ROOM_CODE_ALPHABET.length)];
  }
  return out;
}

export function isValidRoomCode(code) {
  if (typeof code !== 'string') return false;
  if (code.length < 3 || code.length > 8) return false;
  for (const ch of code.toUpperCase()) {
    if (ROOM_CODE_ALPHABET.indexOf(ch) === -1) return false;
  }
  return true;
}

export function sanitizeName(name, fallback) {
  if (typeof name !== 'string') return fallback || 'VIBER';
  /* strip control chars + collapse whitespace; cap the length so a name cannot
     be used to blow up the HUD */
  const clean = name.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').replace(/\s+/g, ' ').trim();
  return clean.slice(0, 14) || (fallback || 'VIBER');
}

/* A client control frame. `jump` is the held state; the rest are edges. */
export function normalizeCtrl(raw) {
  return {
    dirX: clampNum(raw && raw.dirX, -1, 1),
    dirZ: clampNum(raw && raw.dirZ, -1, 1),
    jump: !!(raw && raw.jump),
    jumpPressed: !!(raw && raw.jumpPressed),
    quick: !!(raw && raw.quick),
    heavy: !!(raw && raw.heavy),
    dash: !!(raw && raw.dash),
    ability: !!(raw && raw.ability)
  };
}

function clampNum(v, a, b) {
  const n = typeof v === 'number' && isFinite(v) ? v : 0;
  return n < a ? a : (n > b ? b : n);
}

/* Server-side input sanity: reject absurd sequence numbers / huge payloads. */
export function isValidSeq(seq) {
  return typeof seq === 'number' && isFinite(seq) && seq >= 0 && seq < 1e12;
}
