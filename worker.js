/* =============================================================================
   worker.js — Cloudflare Worker entry point.

   Routing:
     /api/auth/*                    → accounts: guest, sign in/up, profile, delete
     /api/profile/:name             → the data behind a shareable profile link
     GET /ws?room=CODE[&create=1]   → WebSocket upgrade → BattleRoom Durable Object
     GET /api/room/CODE             → { exists, players, phase }  (no side effects)
     GET /api/health                → { ok, tickHz, maxPlayers }
     GET /shared/sim.js             → the shared gameplay core, CORS-enabled so a
                                      front end hosted elsewhere (e.g. Cloudflare
                                      Pages) can import the EXACT same file the
                                      Durable Object runs.
     GET /*                         → static assets from ./public

   One Durable Object instance == one battle room, addressed by room code:
       env.BATTLE_ROOM.idFromName('X7K4Q')

   AUTHENTICATION HAPPENS HERE, NEVER IN THE DURABLE OBJECT.
   The Worker resolves who the player is and passes the answer down as headers.
   The match loop therefore contains no auth logic at all, and a player with no
   account is a fully supported case rather than an error.
   ============================================================================= */

import { BattleRoom } from './BattleRoom.js';
import { TICK_HZ, MAX_PLAYERS, isValidRoomCode, randomRoomCode } from './protocol.js';
import { handleAuth } from './auth/routes.js';
import { identityFromRequest } from './auth/identity.js';

export { BattleRoom };

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST, OPTIONS',
  'access-control-allow-headers': 'content-type'
};

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }, CORS)
  });
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    /* ------------------------------------------------------------- the root -- */
    /* The bare address has no page of its own — the game lives at
       /viber-brawl-multiplayer. Without this, anyone opening the root (which is
       exactly where Cloudflare's dashboard "Visit site" button points, and where
       a shared link lands if someone drops the filename) sees a 404 and assumes
       the whole thing is broken. */
    if (path === '/' || path === '') {
      const to = new URL(request.url);
      to.pathname = '/viber-brawl-multiplayer';
      return Response.redirect(to.toString(), 302);
    }

    /* ------------------------------------------------------------ health -- */
    if (path === '/api/health') {
      return json({
        ok: true, service: 'viber-brawl-multiplayer', tickHz: TICK_HZ,
        maxPlayers: MAX_PLAYERS, accounts: !!env.DB, time: Date.now()
      });
    }

    /* ------------------------------------------------------------ accounts -- */
    /* Handled before anything else so an auth route can never be shadowed by an
       asset of the same name. Returns null for non-auth paths. */
    if (path.startsWith('/api/auth') || path.startsWith('/api/profile/') ||
        path.startsWith('/api/progress')) {
      const res = await handleAuth(request, env, url);
      if (res) return res;
    }

    /* ------------------------------------------------- shared gameplay core */
    if (path === '/shared/sim.js' || path === '/multiplayer/shared/sim.js') {
      const res = await serveAsset(env, request, url, '/shared/sim.js');
      if (!res) return json({ error: 'sim.js not found in assets' }, 500);
      const body = await res.text();
      return new Response(body, {
        status: 200,
        headers: {
          'content-type': 'application/javascript; charset=utf-8',
          'cache-control': 'public, max-age=30',
          'access-control-allow-origin': '*'
        }
      });
    }

    /* ------------------------------------------------------- room probing -- */
    const apiRoom = path.match(/^\/api\/room\/([A-Za-z0-9]{3,8})$/);
    if (apiRoom) {
      const code = apiRoom[1].toUpperCase();
      if (!isValidRoomCode(code)) return json({ exists: false, error: 'bad_code' }, 400);
      const stub = env.BATTLE_ROOM.get(env.BATTLE_ROOM.idFromName(code));
      const res = await stub.fetch('https://battle-room/status?room=' + code, { method: 'GET' });
      return new Response(res.body, { status: res.status, headers: Object.assign({ 'content-type': 'application/json' }, CORS) });
    }

    /* --------------------------------------------------------- websockets -- */
    if (path === '/ws' || path === '/multiplayer/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return json({ error: 'expected a websocket upgrade' }, 426);
      }
      let code = (url.searchParams.get('room') || '').toUpperCase();
      const wantsCreate = url.searchParams.get('create') === '1';

      /* CRITICAL: the room code must BE the Durable Object name.
         If the Worker let the object invent its own code, that code would not
         map back to the same object and `JOIN ROOM` would always miss. So the
         Worker mints the code for a create, and every joiner reaches the same
         single-threaded object via idFromName(code). */
      if (!code && wantsCreate) code = randomRoomCode(5);
      if (!code) return json({ error: 'room code required' }, 400);
      if (!isValidRoomCode(code)) return json({ error: 'invalid room code' }, 400);

      /* Resolve the player's identity HERE and pass the answer down. The Durable
         Object never authenticates anything; it just receives a verified
         identity. No identity at all is a valid outcome — that is a player who
         is happy to play with no account, and everything still works. */
      const identity = await identityFromRequest(env, request, url);

      const target = new URL(request.url);
      target.searchParams.set('room', code);
      if (wantsCreate) target.searchParams.set('create', '1');

      const headers = new Headers(request.headers);
      if (identity) {
        if (identity.accountId) headers.set('X-VB-Account-Id', identity.accountId);
        if (identity.guestId) headers.set('X-VB-Guest-Id', identity.guestId);
        /* Header values are latin-1, and display names are user-controlled. */
        if (identity.displayName) headers.set('X-VB-Display-Name', encodeURIComponent(identity.displayName));
      }
      const forwarded = new Request(target.toString(), { method: request.method, headers });

      const stub = env.BATTLE_ROOM.get(env.BATTLE_ROOM.idFromName(code));
      return stub.fetch(forwarded);
    }

    /* ------------------------------------------------------- static assets */
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(request);
      if (res.status !== 404) return res;
      /* friendly landing page for a bare room URL like /X7K4Q */
      if (isValidRoomCode(path.slice(1))) {
        const redirect = new URL(request.url);
        redirect.pathname = '/viber-brawl-multiplayer.html';
        return env.ASSETS.fetch(new Request(redirect.toString(), request));
      }
      return res;
    }
    return new Response('Not found', { status: 404 });
  }
};

async function serveAsset(env, request, url, assetPath) {
  if (!env.ASSETS) return null;
  const target = new URL(request.url);
  target.pathname = assetPath;
  return env.ASSETS.fetch(new Request(target.toString(), { method: 'GET' }));
}
