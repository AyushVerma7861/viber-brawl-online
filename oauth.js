/* =============================================================================
   auth/oauth.js — sign in with Google or Discord.

   Why OAuth is the primary path: there is no password to leak, no password to
   reset, and 2FA comes free from the provider. It also costs no CPU, so it
   works on Cloudflare's free plan — which password hashing does not.

   Flow (authorization code + PKCE):
     1. /start   -> generate state + verifier, set them in a short-lived cookie,
                    redirect to the provider
     2. /callback-> verify state, exchange the code, fetch the profile,
                    find-or-create the account, mint a session

   A provider is only offered when its credentials are configured, so the game
   works with zero providers, one, or both.
   ============================================================================= */

import { randomToken, sha256Hex, toBase64Url } from './crypto.js';

export const PROVIDERS = {
  google: {
    label: 'Google',
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
    scope: 'openid email profile',
    idEnv: 'GOOGLE_CLIENT_ID',
    secretEnv: 'GOOGLE_CLIENT_SECRET',
    /** Normalise a provider payload into { uid, email, name, avatar }. */
    parse(info) {
      return {
        uid: String(info.sub || ''),
        email: info.email ? String(info.email).toLowerCase() : null,
        name: info.name || info.given_name || null,
        avatar: info.picture || null
      };
    }
  },
  discord: {
    label: 'Discord',
    authorize: 'https://discord.com/oauth2/authorize',
    token: 'https://discord.com/api/oauth2/token',
    userinfo: 'https://discord.com/api/users/@me',
    scope: 'identify email',
    idEnv: 'DISCORD_CLIENT_ID',
    secretEnv: 'DISCORD_CLIENT_SECRET',
    parse(info) {
      return {
        uid: String(info.id || ''),
        email: info.email ? String(info.email).toLowerCase() : null,
        name: info.global_name || info.username || null,
        avatar: info.avatar ? `https://cdn.discordapp.com/avatars/${info.id}/${info.avatar}.png` : null
      };
    }
  }
};

/** Which providers are actually usable right now. */
export function availableProviders(env) {
  const out = [];
  for (const [key, p] of Object.entries(PROVIDERS)) {
    if (env && env[p.idEnv] && env[p.secretEnv]) out.push({ id: key, label: p.label });
  }
  return out;
}

export function isConfigured(env, provider) {
  const p = PROVIDERS[provider];
  return !!(p && env && env[p.idEnv] && env[p.secretEnv]);
}

/* ------------------------------------------------------------------ state -- */

const STATE_COOKIE = 'vb_oauth';
const STATE_TTL_S = 600;   /* 10 minutes: long enough to sign in, short enough to matter */

export function buildStateCookie(name, value, url) {
  const parts = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'SameSite=Lax', 'HttpOnly', `Max-Age=${STATE_TTL_S}`];
  if (url && url.protocol === 'https:') parts.push('Secure');
  return parts.join('; ');
}

/** A compact, signed-ish state blob: state|verifier|provider. */
export async function createOAuthState(env, provider, redirectTo) {
  const state = randomToken(24);
  const verifier = randomToken(32);
  const challenge = toBase64Url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)));
  const payload = [state, verifier, provider, redirectTo || ''].join('|');
  return { state, verifier, challenge, cookie: payload };
}

export function parseOAuthStateCookie(raw) {
  if (!raw) return null;
  const [state, verifier, provider, redirectTo] = String(raw).split('|');
  if (!state || !verifier || !provider) return null;
  return { state, verifier, provider, redirectTo: redirectTo || '' };
}

/* ------------------------------------------------------------- redirects -- */

export function callbackUrl(url, provider) {
  return `${url.origin}/api/auth/oauth/${provider}/callback`;
}

export function authorizeUrl(env, provider, { state, challenge, redirectUri }) {
  const p = PROVIDERS[provider];
  const params = new URLSearchParams({
    client_id: env[p.idEnv],
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: p.scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256'
  });
  if (provider === 'google') {
    params.set('access_type', 'online');
    params.set('prompt', 'select_account');
  }
  return `${p.authorize}?${params.toString()}`;
}

/* -------------------------------------------------------------- exchange -- */

/** Exchange the authorization code for an access token. */
export async function exchangeCode(env, provider, { code, verifier, redirectUri }) {
  const p = PROVIDERS[provider];
  const body = new URLSearchParams({
    client_id: env[p.idEnv],
    client_secret: env[p.secretEnv],
    code,
    grant_type: 'authorization_code',
    redirect_uri: redirectUri,
    code_verifier: verifier
  });
  const res = await fetch(p.token, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'accept': 'application/json'
    },
    body: body.toString()
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`token exchange failed (${res.status}) ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  if (!json.access_token) throw new Error('no access_token in token response');
  return json.access_token;
}

/** Fetch the provider's view of the user. */
export async function fetchUserInfo(provider, accessToken) {
  const p = PROVIDERS[provider];
  const res = await fetch(p.userinfo, {
    headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' }
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`userinfo failed (${res.status}) ${text.slice(0, 200)}`);
  }
  const info = await res.json();
  const parsed = p.parse(info);
  if (!parsed.uid) throw new Error('provider returned no user id');
  return parsed;
}

/* ------------------------------------------------------------------ misc -- */

/**
 * Where to send the browser after a successful sign-in. Only same-origin paths
 * are allowed — an open redirect is a phishing gift.
 */
export function safeReturnTo(candidate, fallback = '/viber-brawl-multiplayer.html') {
  const s = String(candidate || '');
  if (!s.startsWith('/') || s.startsWith('//')) return fallback;
  return s.slice(0, 200);
}
