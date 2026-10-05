/* =============================================================================
   auth/identity.js — who is making this request?

   Two kinds of identity, deliberately unified behind one cookie so the rest of
   the system does not care which it is:

     guest    a player who has not signed in. Full match history and XP, no
              password, no email. Upgrades in place later without losing anything.
     account  a signed-in player.

   Token format:  <prefix>.<secret>
     g.…  guest token
     s.…  session token

   The prefix means one indexed lookup instead of two, and only a SHA-256 hash
   of the token is ever stored — a database leak does not hand out logins.
   ============================================================================= */

import { randomToken, sha256Hex, constantTimeEqual, sanitizeDisplayName } from './crypto.js';
import * as store from './store.js';
import { hasDb } from '../db/index.js';

export const COOKIE_NAME = 'vb_id';
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;

/* ================================================================= cookies == */

export function readCookie(request, name) {
  const raw = request.headers.get('Cookie');
  if (!raw) return null;
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i === -1) continue;
    if (part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); }
      catch (e) { return part.slice(i + 1).trim(); }
    }
  }
  return null;
}

/**
 * `Secure` is only set over HTTPS. Setting it on http://localhost would stop the
 * browser storing the cookie at all, which is a confusing way to lose an hour.
 * `SameSite=Lax` (not Strict) because the OAuth callback is a cross-site
 * top-level navigation and Strict would drop the cookie on the way back.
 */
export function buildCookie(name, value, { maxAge, url, httpOnly = true } = {}) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax'];
  if (httpOnly) parts.push('HttpOnly');
  if (url && url.protocol === 'https:') parts.push('Secure');
  if (typeof maxAge === 'number') parts.push('Max-Age=' + Math.max(0, Math.floor(maxAge)));
  return parts.join('; ');
}

export function clearCookie(name, url) {
  return buildCookie(name, '', { maxAge: 0, url });
}

/* ================================================================== tokens == */

export function guestToken() { return 'g.' + randomToken(32); }
export function sessionToken() { return 's.' + randomToken(32); }

/** Which table a token belongs to, from its prefix alone. */
export function tokenKind(token) {
  if (typeof token !== 'string' || token.length < 3) return null;
  if (token.startsWith('g.')) return 'guest';
  if (token.startsWith('s.')) return 'account';
  return null;
}

/* ============================================================ resolve ======== */

/**
 * Turn a raw token into an identity.
 * @returns null, or
 *   { kind, playerKey, displayName, accountId, guestId, sessionId, token }
 */
export async function resolveToken(env, token) {
  if (!hasDb(env) || !token) return null;
  const kind = tokenKind(token);
  if (!kind) return null;

  let hash;
  try { hash = await sha256Hex(token); } catch (e) { return null; }

  if (kind === 'guest') {
    const g = await store.findGuestByHash(env, hash);
    if (!g) return null;
    /* A claimed guest is now an account; the session cookie is the real one,
       but keep working so a stale tab does not lose its history mid-session. */
    if (g.claimed_by) {
      return { kind: 'account', playerKey: g.claimed_by, accountId: g.claimed_by, guestId: null, displayName: g.display_name, token };
    }
    store.touchGuest(env, g.id);
    return { kind: 'guest', playerKey: g.id, guestId: g.id, accountId: null, displayName: g.display_name, token };
  }

  const s = await store.findSessionByHash(env, hash);
  if (!s) return null;
  const profile = await store.getProfile(env, s.account_id);
  store.touchSession(env, s.id);
  return {
    kind: 'account',
    playerKey: s.account_id,
    accountId: s.account_id,
    guestId: null,
    sessionId: s.id,
    displayName: profile ? profile.display_name : null,
    token
  };
}

/**
 * The identity behind a request. Accepts the cookie, or an explicit `?id=` /
 * Authorization token — the latter so a WebSocket handshake can carry it even
 * if cookies are unavailable.
 */
export async function identityFromRequest(env, request, url) {
  const fromCookie = readCookie(request, COOKIE_NAME);
  if (fromCookie) {
    const id = await resolveToken(env, fromCookie);
    if (id) return id;
  }
  const auth = request.headers.get('Authorization');
  if (auth && auth.startsWith('Bearer ')) {
    const id = await resolveToken(env, auth.slice(7).trim());
    if (id) return id;
  }
  if (url) {
    const q = url.searchParams.get('id');
    if (q) {
      const id = await resolveToken(env, q);
      if (id) return id;
    }
  }
  return null;
}

/* ============================================================ create ======== */

/** Mint a fresh guest and its token. */
export async function createGuestIdentity(env, desiredName) {
  const id = crypto.randomUUID();
  const token = guestToken();
  const name = sanitizeDisplayName(desiredName) || 'VIBER';
  const tokenHash = await sha256Hex(token);
  await store.createGuest(env, { id, displayName: name, tokenHash });
  return { token, guestId: id, displayName: name, playerKey: id };
}

/** Mint a session for an account. Returns the raw token (only time it exists). */
export async function createAccountSession(env, accountId, { ipHash, uaHash } = {}) {
  const token = sessionToken();
  const tokenHash = await sha256Hex(token);
  const sessionId = crypto.randomUUID();
  await store.createSession(env, {
    id: sessionId, accountId, tokenHash,
    expiresAt: Date.now() + SESSION_MS,
    ipHash, uaHash
  });
  await store.ensureAccountRows(env, accountId);
  return { token, sessionId, expiresAt: Date.now() + SESSION_MS };
}

/**
 * Sign in (or sign up) via a provider. Finds an existing identity, otherwise
 * links one onto an account with the same email, otherwise creates a brand new
 * account. That "link by email" step is what makes Google-then-Discord feel like
 * one account rather than two.
 */
export async function upsertProviderIdentity(env, { provider, providerUid, email, displayName, avatar }) {
  const existing = await store.findIdentity(env, provider, providerUid);
  if (existing) {
    store.touchIdentity(env, existing.id);
    return { accountId: existing.account_id, created: false, linked: false };
  }

  const normEmail = email ? String(email).toLowerCase() : null;
  let accountId = null;

  if (normEmail) {
    const byEmail = await store.findAccountByEmail(env, normEmail);
    if (byEmail) accountId = byEmail.id;
  }

  let linked = false;
  if (accountId) {
    linked = true;   /* an account with this email already existed */
  } else {
    const acct = await store.createAccount(env, { email: normEmail, emailVerified: normEmail ? 1 : 0 });
    accountId = acct.id;
  }

  await store.createIdentity(env, {
    accountId, provider, providerUid, email: normEmail
  });

  /* Give them a profile if they have none. */
  const profile = await store.getProfile(env, accountId);
  if (!profile) {
    let name = sanitizeDisplayName(displayName) || 'VIBER';
    if (await store.isNameTaken(env, name)) {
      name = (name.slice(0, 10) + '-' + randomToken(2).replace(/[^A-Za-z0-9]/g, '').slice(0, 3)).slice(0, 14);
      if (await store.isNameTaken(env, name)) name = 'VIBER-' + randomToken(3).replace(/[^A-Za-z0-9]/g, '').slice(0, 5);
    }
    await store.createProfile(env, accountId, name);
    await store.ensureAccountRows(env, accountId);
    await store.grantDefaultUnlocks(env, accountId);
  }

  return { accountId, created: !linked, linked };
}

/** Create an account from an email + password. */
export async function createPasswordAccount(env, { email, password, displayName, passwordRecord }) {
  const normEmail = String(email).toLowerCase();
  const acct = await store.createAccount(env, { email: normEmail, emailVerified: 0 });
  await store.createIdentity(env, {
    accountId: acct.id,
    provider: 'password',
    providerUid: normEmail,          /* the email IS the uid for this provider */
    email: normEmail,
    passwordHash: passwordRecord.hash,
    passwordSalt: passwordRecord.salt,
    passwordAlgo: passwordRecord.algo
  });
  let name = sanitizeDisplayName(displayName);
  if (!name || await store.isNameTaken(env, name)) {
    name = 'VIBER-' + randomToken(3).replace(/[^A-Za-z0-9]/g, '').slice(0, 5);
    while (await store.isNameTaken(env, name)) {
      name = 'VIBER-' + randomToken(4).replace(/[^A-Za-z0-9]/g, '').slice(0, 6);
    }
  }
  await store.createProfile(env, acct.id, name);
  await store.ensureAccountRows(env, acct.id);
  await store.grantDefaultUnlocks(env, acct.id);
  return { accountId: acct.id, displayName: name };
}

/* =============================================================== helpers ==== */

/** Privacy-preserving request fingerprint. Raw IPs are never stored. */
export async function requestFingerprint(request) {
  const ip = request.headers.get('CF-Connecting-IP') || request.headers.get('X-Forwarded-For') || '';
  const ua = request.headers.get('User-Agent') || '';
  return {
    ipHash: ip ? (await sha256Hex(ip)).slice(0, 32) : null,
    uaHash: ua ? (await sha256Hex(ua)).slice(0, 32) : null
  };
}

export { constantTimeEqual };
