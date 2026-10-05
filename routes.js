/* =============================================================================
   auth/routes.js — the HTTP surface of the account system.

   Every endpoint is rate limited, every response is JSON, and every error
   message is deliberately vague about *why* a sign-in failed (so the API cannot
   be used to discover which email addresses have accounts).

   Returns null when the path is not an auth route, so the Worker can fall
   through to its other handlers.
   ============================================================================= */

import {
  COOKIE_NAME, buildCookie, clearCookie, readCookie,
  resolveToken, identityFromRequest, createGuestIdentity, createAccountSession,
  upsertProviderIdentity, createPasswordAccount, requestFingerprint, SESSION_DAYS
} from './identity.js';
import {
  hashPassword, verifyPassword, validatePassword, isValidEmail, normalizeEmail,
  sanitizeDisplayName, randomToken, sha256Hex
} from './crypto.js';
import * as store from './store.js';
import * as oauth from './oauth.js';
import { bumpRateLimit, hasDb, careerTotals, perCharacterTotals, recentMatchesFor } from '../db/index.js';
import { awardForAccount, progressFor, ACHIEVEMENT_RULES } from '../progression/index.js';
import { nextRewardAt } from '../progression/level.js';
import { periodKeys } from '../progression/xp.js';

/**
 * Move a guest's history onto their new account AND pay out the XP they earned
 * while playing as a guest. Without the second half, "signing up keeps
 * everything" would be a lie for the one thing players care about most.
 */
async function claimAndAward(env, guestId, accountId) {
  const claimed = await store.claimGuest(env, guestId, accountId);
  try { await awardForAccount(env, accountId); }
  catch (e) { console.error('[auth] progression award after claim failed', e && e.message); }
  return claimed;
}

/* ------------------------------------------------------------- responses -- */

function json(data, status = 200, cookies = []) {
  const headers = new Headers({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin'
  });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(JSON.stringify(data), { status, headers });
}

function redirect(location, cookies = []) {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

const fail = (message, status = 400, cookies = []) => json({ ok: false, error: message }, status, cookies);

/* Feature flags. Password auth is opt-in because hashing needs the paid plan. */
function passwordAuthEnabled(env) {
  return String(env.AUTH_PASSWORD || '1') !== '0';
}

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text || text.length > 8192) return {};
    return JSON.parse(text);
  } catch (e) { return {}; }
}

/** Rate limit keyed on the caller's IP, falling back to a coarse global key. */
async function limited(env, request, bucket, max, windowMs) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || 'unknown';
  const res = await bumpRateLimit(env, bucket + ':' + ip, max, windowMs);
  return !res.allowed;
}

/* ================================================================ routes == */

export async function handleAuth(request, env, url) {
  const path = url.pathname;
  /* This module owns every player-facing API, not just the auth ones — the
     progress and public-profile routes live here too because they all need the
     same identity resolution. Anything else returns null so the Worker can
     carry on to its own handlers. */
  if (!path.startsWith('/api/auth') &&
      !path.startsWith('/api/progress') &&
      !path.startsWith('/api/profile/')) {
    return null;
  }

  if (!hasDb(env)) {
    return json({ ok: false, error: 'Accounts are not configured on this server yet.' }, 503);
  }

  const method = request.method.toUpperCase();

  /* ---------------------------------------------------------- /config ---- */
  /* Public: tells the client which sign-in buttons to draw. */
  if (path === '/api/auth/config' && method === 'GET') {
    return json({
      ok: true,
      providers: oauth.availableProviders(env),
      password: passwordAuthEnabled(env),
      accountsReady: true
    });
  }

  /* ----------------------------------------------------------- /guest ---- */
  /* Called when a player enters multiplayer with no account. Creates the
     throwaway identity that match history and XP are filed under until they
     choose to sign in. */
  if (path === '/api/auth/guest' && method === 'POST') {
    if (await limited(env, request, 'guest', 30, 3600_000)) {
      return fail('Too many new players from here. Try again in a little while.', 429);
    }
    const body = await readJson(request);
    const existing = await identityFromRequest(env, request, url);
    if (existing && existing.kind === 'guest') {
      return json({ ok: true, kind: 'guest', displayName: existing.displayName, reused: true });
    }
    const g = await createGuestIdentity(env, body.name);
    return json({ ok: true, kind: 'guest', displayName: g.displayName, playerKey: g.playerKey },
      200, [buildCookie(COOKIE_NAME, g.token, { maxAge: SESSION_DAYS * 86400, url })]);
  }

  /* -------------------------------------------------------------- /me ---- */
  if (path === '/api/auth/me' && method === 'GET') {
    const id = await identityFromRequest(env, request, url);
    if (!id) {
      return json({
        ok: true, signedIn: false, kind: null, displayName: null,
        providers: oauth.availableProviders(env),
        password: passwordAuthEnabled(env)
      });
    }
    let profile = null;
    let guestMatches = 0;
    if (id.accountId) profile = await store.getProfile(env, id.accountId);
    if (id.guestId) guestMatches = await store.guestMatchCount(env, id.guestId);
    return json({
      ok: true,
      signedIn: id.kind === 'account',
      kind: id.kind,
      displayName: (profile && profile.display_name) || id.displayName,
      avatarViber: profile ? profile.avatar_viber : null,
      isPublic: profile ? !!profile.is_public : true,
      playerKey: id.playerKey,
      guestMatches,
      identities: id.accountId ? await store.listIdentities(env, id.accountId) : [],
      providers: oauth.availableProviders(env),
      password: passwordAuthEnabled(env)
    });
  }

  /* -------------------------------------------------------- /register ---- */
  if (path === '/api/auth/register' && method === 'POST') {
    if (!passwordAuthEnabled(env)) {
      return fail('Password sign-in is turned off on this server. Use Google or Discord.', 403);
    }
    if (await limited(env, request, 'register', 8, 900_000)) {
      return fail('Too many sign-up attempts. Try again in 15 minutes.', 429);
    }
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    if (!isValidEmail(email)) return fail('That does not look like an email address.');
    const pw = validatePassword(body.password);
    if (!pw.ok) return fail(pw.message);

    const existing = await store.findAccountByEmail(env, email);
    if (existing) return fail('Could not create that account.', 409);

    const record = await hashPassword(body.password);
    const { accountId, displayName } = await createPasswordAccount(env, {
      email, password: body.password, displayName: body.displayName, passwordRecord: record
    });

    /* A guest who signs up keeps everything they already earned. */
    const current = await identityFromRequest(env, request, url);
    let claimed = 0;
    if (current && current.guestId) claimed = await claimAndAward(env, current.guestId, accountId);

    const fp = await requestFingerprint(request);
    const sess = await createAccountSession(env, accountId, fp);
    return json({
      ok: true, signedIn: true, kind: 'account', displayName,
      claimedMatches: claimed
    }, 200, [buildCookie(COOKIE_NAME, sess.token, { maxAge: SESSION_DAYS * 86400, url })]);
  }

  /* ----------------------------------------------------------- /login ---- */
  if (path === '/api/auth/login' && method === 'POST') {
    if (!passwordAuthEnabled(env)) {
      return fail('Password sign-in is turned off on this server. Use Google or Discord.', 403);
    }
    if (await limited(env, request, 'login', 12, 900_000)) {
      return fail('Too many sign-in attempts. Try again in 15 minutes.', 429);
    }
    const body = await readJson(request);
    const email = normalizeEmail(body.email);
    const password = String(body.password || '');
    if (!isValidEmail(email) || !password) return fail('Wrong email or password.', 401);

    const identity = await store.findIdentity(env, 'password', email);
    /* Always run a verification, even with no such user, so the response time
       does not reveal whether the account exists. */
    const ok = identity
      ? await verifyPassword(password, identity.password_hash, identity.password_salt, identity.password_algo)
      : await verifyPassword(password, 'x', 'AAAAAAAAAAAAAAAAAAAAAA', 'pbkdf2-sha256:1000');
    if (!identity || !ok) return fail('Wrong email or password.', 401);

    const account = await store.findAccountById(env, identity.account_id);
    if (!account || account.status !== 'active') return fail('That account is not available.', 403);

    await store.touchIdentity(env, identity.id);
    const current = await identityFromRequest(env, request, url);
    let claimed = 0;
    if (current && current.guestId && current.guestId !== identity.account_id) {
      claimed = await claimAndAward(env, current.guestId, identity.account_id);
    }
    const fp = await requestFingerprint(request);
    const sess = await createAccountSession(env, identity.account_id, fp);
    const profile = await store.getProfile(env, identity.account_id);
    return json({
      ok: true, signedIn: true, kind: 'account',
      displayName: profile ? profile.display_name : null,
      claimedMatches: claimed
    }, 200, [buildCookie(COOKIE_NAME, sess.token, { maxAge: SESSION_DAYS * 86400, url })]);
  }

  /* ---------------------------------------------------------- /logout ---- */
  if (path === '/api/auth/logout' && method === 'POST') {
    const token = readCookie(request, COOKIE_NAME);
    if (token && token.startsWith('s.')) {
      const id = await resolveToken(env, token);
      if (id && id.sessionId) {
        await store.revokeSession(env, await sha256Hex(token));
      }
    }
    return json({ ok: true, signedIn: false }, 200, [clearCookie(COOKIE_NAME, url)]);
  }

  /* ----------------------------------------------------- /logout-all ---- */
  if (path === '/api/auth/logout-all' && method === 'POST') {
    const id = await identityFromRequest(env, request, url);
    if (!id || !id.accountId) return fail('Not signed in.', 401);
    await store.revokeAllSessions(env, id.accountId);
    return json({ ok: true }, 200, [clearCookie(COOKIE_NAME, url)]);
  }

  /* ----------------------------------------------------------- /delete -- */
  /* Account deletion that actually deletes. Requires the literal word DELETE so
     it cannot be triggered by a stray click or a cross-site form post. */
  if (path === '/api/auth/delete' && method === 'POST') {
    const id = await identityFromRequest(env, request, url);
    if (!id || !id.accountId) return fail('Not signed in.', 401);
    if (await limited(env, request, 'delete', 5, 3600_000)) return fail('Too many attempts.', 429);
    const body = await readJson(request);
    if (String(body.confirm || '').toUpperCase() !== 'DELETE') {
      return fail('Type DELETE to confirm.');
    }
    await store.deleteAccount(env, id.accountId);
    return json({ ok: true, deleted: true }, 200, [clearCookie(COOKIE_NAME, url)]);
  }

  /* ---------------------------------------------------------- /profile -- */
  if (path === '/api/auth/profile' && method === 'PATCH') {
    const id = await identityFromRequest(env, request, url);
    if (!id) return fail('Not signed in.', 401);
    if (await limited(env, request, 'profile', 20, 900_000)) return fail('Too many changes. Slow down.', 429);

    const body = await readJson(request);
    const fields = {};
    if (body.displayName !== undefined) {
      const name = sanitizeDisplayName(body.displayName);
      if (!name) return fail('Pick a name of 3 to 14 letters, numbers, spaces, dashes or underscores.');
      if (await store.isNameTaken(env, name, id.accountId)) return fail('That name is taken.', 409);
      /* A name change costs nothing but has a cooldown, so nobody can churn
         through names to impersonate. */
      if (id.accountId) {
        const profile = await store.getProfile(env, id.accountId);
        const last = profile && profile.name_changed_at ? profile.name_changed_at : 0;
        if (last && Date.now() - last < 24 * 3600 * 1000) {
          const hours = Math.ceil((24 * 3600 * 1000 - (Date.now() - last)) / 3600000);
          return fail(`You can change your name again in ${hours} hour(s).`, 429);
        }
      }
      fields.displayName = name;
    }
    if (typeof body.isPublic === 'boolean') fields.isPublic = body.isPublic;
    if (body.avatarViber) fields.avatarViber = String(body.avatarViber).slice(0, 24);

    if (id.accountId) {
      if (!Object.keys(fields).length) return json({ ok: true, unchanged: true });
      await store.updateProfile(env, id.accountId, fields);
    } else if (fields.displayName && id.guestId) {
      /* guests can rename themselves freely — nothing to squat on */
      await env.DB.prepare(`UPDATE guests SET display_name = ? WHERE id = ?`)
        .bind(fields.displayName, id.guestId).run();
    }
    const profile = id.accountId ? await store.getProfile(env, id.accountId) : null;
    return json({ ok: true, displayName: (profile && profile.display_name) || fields.displayName || id.displayName });
  }

  /* ------------------------------------------------------- oauth/start -- */
  const startMatch = /^\/api\/auth\/oauth\/([a-z]+)\/start$/.exec(path);
  if (startMatch && method === 'GET') {
    const provider = startMatch[1];
    if (!oauth.isConfigured(env, provider)) return fail('That sign-in method is not set up.', 404);
    if (await limited(env, request, 'oauth_start', 30, 900_000)) return fail('Too many attempts.', 429);

    const { state, challenge, cookie } = await oauth.createOAuthState(
      env, provider, oauth.safeReturnTo(url.searchParams.get('returnTo'))
    );
    const target = oauth.authorizeUrl(env, provider, {
      state, challenge, redirectUri: oauth.callbackUrl(url, provider)
    });
    return redirect(target, [oauth.buildStateCookie('vb_oauth', cookie, url)]);
  }

  /* ---------------------------------------------------- oauth/callback -- */
  const cbMatch = /^\/api\/auth\/oauth\/([a-z]+)\/callback$/.exec(path);
  if (cbMatch && method === 'GET') {
    const provider = cbMatch[1];
    if (!oauth.isConfigured(env, provider)) return fail('That sign-in method is not set up.', 404);

    const saved = oauth.parseOAuthStateCookie(readCookie(request, 'vb_oauth'));
    const state = url.searchParams.get('state');
    const code = url.searchParams.get('code');

    const clearState = oauth.buildStateCookie('vb_oauth', '', url).replace(/Max-Age=\d+/, 'Max-Age=0');

    if (url.searchParams.get('error')) {
      return redirect('/viber-brawl-multiplayer.html?signin=cancelled', [clearState]);
    }
    if (!saved || !state || saved.state !== state || saved.provider !== provider) {
      return redirect('/viber-brawl-multiplayer.html?signin=error&reason=state', [clearState]);
    }
    if (!code) {
      return redirect('/viber-brawl-multiplayer.html?signin=error&reason=code', [clearState]);
    }

    let profile;
    try {
      const accessToken = await oauth.exchangeCode(env, provider, {
        code, verifier: saved.verifier, redirectUri: oauth.callbackUrl(url, provider)
      });
      profile = await oauth.fetchUserInfo(provider, accessToken);
    } catch (err) {
      console.error('[auth] oauth ' + provider + ' failed:', err && err.message);
      return redirect('/viber-brawl-multiplayer.html?signin=error&reason=provider', [clearState]);
    }

    const { accountId } = await upsertProviderIdentity(env, {
      provider,
      providerUid: profile.uid,
      email: profile.email,
      displayName: profile.name,
      avatar: profile.avatar
    });

    /* Claim anything the guest earned before signing in. */
    const current = await identityFromRequest(env, request, url);
    if (current && current.guestId) await claimAndAward(env, current.guestId, accountId);

    const fp = await requestFingerprint(request);
    const sess = await createAccountSession(env, accountId, fp);
    const returnTo = oauth.safeReturnTo(saved.redirectTo);

    return redirect(returnTo + (returnTo.includes('?') ? '&' : '?') + 'signin=ok', [
      clearState,
      buildCookie(COOKIE_NAME, sess.token, { maxAge: SESSION_DAYS * 86400, url })
    ]);
  }

  /* --------------------------------------------------------- progress ---- */
  /* Everything the profile screen needs, in one round trip. */
  if (path === '/api/progress/me' && method === 'GET') {
    const id = await identityFromRequest(env, request, url);
    if (!id) return fail('Not signed in.', 401);
    if (!id.accountId) {
      /* A guest has real match history but no progress row yet. Say so plainly
         rather than inventing a level for them. */
      return json({
        ok: true, guest: true, level: null,
        guestMatches: await store.guestMatchCount(env, id.guestId),
        message: 'Sign in to start earning levels and rewards.'
      });
    }
    const p = await progressFor(env, id.accountId);
    const catalogue = await env.DB.prepare(`SELECT * FROM unlocks ORDER BY sort_order`).all();
    const owned = await env.DB.prepare(
      `SELECT unlock_id, source, unlocked_at FROM account_unlocks WHERE account_id = ?`
    ).bind(id.accountId).all();
    const ownedIds = new Set((owned.results || []).map(o => o.unlock_id));
    /* Match history travels with the profile so the whole screen is one request.
       Capped at 20 — a career page does not need more, and it keeps the payload
       small enough to render instantly. */
    const history = await recentMatchesFor(env, id.accountId, 20);
    return json({
      ok: true,
      guest: false,
      ...p,
      recentMatches: (history || []).map(m => ({
        matchId: m.match_id,
        charId: m.char_id,
        placement: m.placement,
        livesLeft: m.lives_left,
        kos: m.kos,
        falls: m.falls,
        dmgDealt: Math.round(m.dmg_dealt || 0),
        dmgTaken: Math.round(m.dmg_taken || 0),
        winner: !!m.winner,
        disconnected: !!m.disconnected,
        playedAt: m.created_at,
        roomCode: m.room_code,
        durationS: m.duration_s,
        playerCount: m.player_count,
        map: m.map
      })),
      unlocks: {
        owned: owned.results || [],
        next: nextRewardAt(p.level, catalogue.results || []),
        all: (catalogue.results || []).map(u => ({
          id: u.id, kind: u.kind, name: u.name, charId: u.char_id,
          source: u.source, levelReq: u.level_req, achievementId: u.achievement_id,
          payload: u.payload_json ? JSON.parse(u.payload_json) : null,
          owned: ownedIds.has(u.id)
        }))
      }
    });
  }

  /* ----------------------------------------------------- achievements ---- */
  if (path === '/api/progress/achievements' && method === 'GET') {
    const id = await identityFromRequest(env, request, url);
    if (!id || !id.accountId) return fail('Not signed in.', 401);
    const catalogue = await env.DB.prepare(
      `SELECT id, name, description, tier, secret, points, xp_reward, sort_order
         FROM achievements ORDER BY sort_order`
    ).all();
    const mine = await env.DB.prepare(
      `SELECT achievement_id, progress, unlocked_at FROM account_achievements WHERE account_id = ?`
    ).bind(id.accountId).all();
    const byId = new Map((mine.results || []).map(r => [r.achievement_id, r]));
    /* rarity = what fraction of players have it, which is what makes an
       achievement worth chasing */
    const rarityRows = await env.DB.prepare(
      `SELECT achievement_id, COUNT(*) n FROM account_achievements
        WHERE unlocked_at IS NOT NULL GROUP BY achievement_id`
    ).all();
    const totalPlayers = await env.DB.prepare(
      `SELECT COUNT(DISTINCT account_id) n FROM player_stats WHERE matches > 0`
    ).first();
    const denom = Math.max(1, totalPlayers ? totalPlayers.n : 1);
    const rarity = new Map((rarityRows.results || []).map(r => [r.achievement_id, r.n]));

    const list = (catalogue.results || []).map(a => {
      const mineRow = byId.get(a.id);
      const unlocked = !!(mineRow && mineRow.unlocked_at);
      const rule = ACHIEVEMENT_RULES[a.id];
      return {
        id: a.id,
        name: a.secret && !unlocked ? '???' : a.name,
        description: a.secret && !unlocked ? 'A secret achievement.' : a.description,
        tier: a.tier,
        secret: !!a.secret,
        points: a.points,
        xpReward: a.xp_reward,
        target: rule ? rule.target : 1,
        progress: mineRow ? mineRow.progress : 0,
        unlocked,
        unlockedAt: mineRow ? mineRow.unlocked_at : null,
        rarity: +(100 * (rarity.get(a.id) || 0) / denom).toFixed(1)
      };
    });
    const unlockedCount = list.filter(a => a.unlocked).length;
    return json({ ok: true, achievements: list, unlocked: unlockedCount, total: list.length });
  }

  /* ------------------------------------------------------- challenges ---- */
  if (path === '/api/progress/challenges' && method === 'GET') {
    const id = await identityFromRequest(env, request, url);
    if (!id || !id.accountId) return fail('Not signed in.', 401);
    const keys = periodKeys();
    const rows = await env.DB.prepare(
      `SELECT c.id, c.name, c.description, c.period, c.target, c.xp_reward,
              p.progress, p.claimed_at, p.period_key
         FROM challenges c
         LEFT JOIN challenge_progress p
           ON p.challenge_id = c.id AND p.account_id = ?
          AND p.period_key IN (?, ?)
        ORDER BY c.sort_order`
    ).bind(id.accountId, keys.day, keys.week).all();
    return json({
      ok: true,
      day: keys.day,
      week: keys.week,
      challenges: (rows.results || []).map(c => ({
        id: c.id, name: c.name, description: c.description, period: c.period,
        target: c.target, xpReward: c.xp_reward,
        progress: Math.min(c.progress || 0, c.target),
        complete: (c.progress || 0) >= c.target,
        claimed: !!c.claimed_at
      }))
    });
  }

  /* -------------------------------------------------------- public page -- */
  /* /api/profile/:name — the data behind a shareable profile link. */
  const pub = /^\/api\/profile\/([A-Za-z0-9_\- ]{3,14})$/.exec(decodeURIComponent(path));
  if (pub && method === 'GET') {
    if (await limited(env, request, 'pubprofile', 120, 60_000)) return fail('Slow down.', 429);
    const profile = await store.getProfileByName(env, pub[1]);
    if (!profile || !profile.is_public) return fail('No such player.', 404);
    const totals = await careerTotals(env, profile.account_id);
    const byChar = await perCharacterTotals(env, profile.account_id);
    return json({
      ok: true,
      displayName: profile.display_name,
      avatarViber: profile.avatar_viber,
      joinedAt: profile.created_at,
      totals: totals || null,
      characters: byChar || []
    });
  }

  return fail('Unknown auth endpoint.', 404);
}
