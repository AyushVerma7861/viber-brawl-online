/* =============================================================================
   auth/store.js — all D1 access for accounts, identities, profiles, sessions
   and guests.

   Route handlers never write SQL; they call these functions. That keeps the
   security-relevant queries in one place and makes it obvious what the auth
   system can and cannot touch.
   ============================================================================= */

import { hasDb } from '../db/index.js';

const now = () => Date.now();
const uuid = () => crypto.randomUUID();

/* ================================================================ accounts == */

export async function findAccountByEmail(env, email) {
  if (!hasDb(env)) return null;
  return env.DB.prepare(
    `SELECT * FROM accounts WHERE lower(email) = ? AND deleted_at IS NULL`
  ).bind(String(email).toLowerCase()).first();
}

export async function findAccountById(env, id) {
  if (!hasDb(env) || !id) return null;
  return env.DB.prepare(`SELECT * FROM accounts WHERE id = ?`).bind(id).first();
}

export async function createAccount(env, { email, emailVerified = 0 }) {
  const id = uuid();
  const t = now();
  await env.DB.prepare(
    `INSERT INTO accounts (id, email, email_verified, status, created_at, updated_at)
     VALUES (?, ?, ?, 'active', ?, ?)`
  ).bind(id, email || null, emailVerified ? 1 : 0, t, t).run();
  return { id, email: email || null, email_verified: emailVerified ? 1 : 0, created_at: t };
}

/**
 * Soft-delete. Personal fields are wiped and the email is released, while match
 * history is anonymised rather than deleted so aggregate stats stay coherent.
 * This is what "delete my account" has to actually do.
 */
export async function deleteAccount(env, accountId) {
  const t = now();
  await env.DB.batch([
    env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`)
      .bind(t, accountId),
    env.DB.prepare(`DELETE FROM identities WHERE account_id = ?`).bind(accountId),
    env.DB.prepare(
      `UPDATE accounts SET status = 'deleted', deleted_at = ?, email = NULL,
              email_verified = 0, updated_at = ? WHERE id = ?`
    ).bind(t, t, accountId),
    env.DB.prepare(
      `UPDATE profiles SET display_name = 'Deleted Player', display_name_lower = ?,
              is_public = 0, updated_at = ? WHERE account_id = ?`
    ).bind('deleted-' + accountId.slice(0, 8), t, accountId),
    /* keep the results for aggregate analytics, but sever them from the person */
    env.DB.prepare(
      `UPDATE match_results SET account_id = NULL, display_name = 'Deleted Player'
        WHERE account_id = ?`
    ).bind(accountId),
    env.DB.prepare(`UPDATE events SET account_id = NULL WHERE account_id = ?`).bind(accountId)
  ]);
  return true;
}

/* ============================================================== identities == */

export async function findIdentity(env, provider, providerUid) {
  if (!hasDb(env)) return null;
  return env.DB.prepare(
    `SELECT * FROM identities WHERE provider = ? AND provider_uid = ?`
  ).bind(provider, String(providerUid)).first();
}

export async function findIdentityByEmail(env, provider, email) {
  if (!hasDb(env) || !email) return null;
  return env.DB.prepare(
    `SELECT * FROM identities WHERE provider = ? AND lower(email) = ?`
  ).bind(provider, String(email).toLowerCase()).first();
}

export async function listIdentities(env, accountId) {
  if (!hasDb(env)) return [];
  const { results } = await env.DB.prepare(
    `SELECT provider, email, created_at, last_used_at FROM identities
      WHERE account_id = ? ORDER BY created_at`
  ).bind(accountId).all();
  return results || [];
}

export async function createIdentity(env, {
  accountId, provider, providerUid, email = null,
  passwordHash = null, passwordSalt = null, passwordAlgo = null
}) {
  const id = uuid();
  await env.DB.prepare(
    `INSERT INTO identities
       (id, account_id, provider, provider_uid, email, password_hash, password_salt, password_algo, created_at, last_used_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, accountId, provider, String(providerUid), email, passwordHash, passwordSalt, passwordAlgo, now(), now()).run();
  return id;
}

export async function touchIdentity(env, id) {
  if (!hasDb(env)) return;
  await env.DB.prepare(`UPDATE identities SET last_used_at = ? WHERE id = ?`)
    .bind(now(), id).run().catch(() => {});
}

/* ================================================================ profiles == */

export async function getProfile(env, accountId) {
  if (!hasDb(env) || !accountId) return null;
  return env.DB.prepare(`SELECT * FROM profiles WHERE account_id = ?`).bind(accountId).first();
}

export async function getProfileByName(env, displayNameLower) {
  if (!hasDb(env)) return null;
  return env.DB.prepare(
    `SELECT p.*, a.status FROM profiles p
       JOIN accounts a ON a.id = p.account_id
      WHERE p.display_name_lower = ? AND a.deleted_at IS NULL`
  ).bind(String(displayNameLower).toLowerCase()).first();
}

export async function isNameTaken(env, displayNameLower, exceptAccountId = null) {
  if (!hasDb(env)) return false;
  const row = await env.DB.prepare(
    `SELECT account_id FROM profiles WHERE display_name_lower = ?`
  ).bind(String(displayNameLower).toLowerCase()).first();
  if (!row) return false;
  return row.account_id !== exceptAccountId;
}

export async function createProfile(env, accountId, displayName) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO profiles (account_id, display_name, display_name_lower, avatar_viber, is_public, created_at, updated_at)
     VALUES (?, ?, ?, 'miner', 1, ?, ?)`
  ).bind(accountId, displayName, displayName.toLowerCase(), t, t).run();
  return { account_id: accountId, display_name: displayName, display_name_lower: displayName.toLowerCase() };
}

export async function updateProfile(env, accountId, fields) {
  const sets = [];
  const vals = [];
  if (fields.displayName) {
    sets.push('display_name = ?', 'display_name_lower = ?', 'name_changed_at = ?');
    vals.push(fields.displayName, fields.displayName.toLowerCase(), now());
  }
  if (fields.avatarViber) { sets.push('avatar_viber = ?'); vals.push(fields.avatarViber); }
  if (typeof fields.isPublic === 'boolean') { sets.push('is_public = ?'); vals.push(fields.isPublic ? 1 : 0); }
  if (!sets.length) return false;
  sets.push('updated_at = ?'); vals.push(now());
  vals.push(accountId);
  await env.DB.prepare(`UPDATE profiles SET ${sets.join(', ')} WHERE account_id = ?`).bind(...vals).run();
  return true;
}

/* ================================================================ sessions == */

export async function createSession(env, { id, accountId, tokenHash, expiresAt, ipHash, uaHash }) {
  await env.DB.prepare(
    `INSERT INTO sessions (id, account_id, token_hash, created_at, expires_at, last_seen_at, ip_hash, ua_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, accountId, tokenHash, now(), expiresAt, now(), ipHash || null, uaHash || null).run();
}

export async function findSessionByHash(env, tokenHash) {
  if (!hasDb(env) || !tokenHash) return null;
  return env.DB.prepare(
    `SELECT * FROM sessions
      WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?`
  ).bind(tokenHash, now()).first();
}

export async function touchSession(env, id) {
  if (!hasDb(env)) return;
  env.DB.prepare(`UPDATE sessions SET last_seen_at = ? WHERE id = ?`)
    .bind(now(), id).run().catch(() => {});
}

export async function revokeSession(env, tokenHash) {
  if (!hasDb(env)) return;
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL`
  ).bind(now(), tokenHash).run();
}

export async function revokeAllSessions(env, accountId) {
  if (!hasDb(env)) return;
  await env.DB.prepare(
    `UPDATE sessions SET revoked_at = ? WHERE account_id = ? AND revoked_at IS NULL`
  ).bind(now(), accountId).run();
}

export async function listSessions(env, accountId) {
  if (!hasDb(env)) return [];
  const { results } = await env.DB.prepare(
    `SELECT id, created_at, last_seen_at, expires_at FROM sessions
      WHERE account_id = ? AND revoked_at IS NULL AND expires_at > ?
      ORDER BY last_seen_at DESC LIMIT 20`
  ).bind(accountId, now()).all();
  return results || [];
}

export async function purgeExpiredSessions(env) {
  if (!hasDb(env)) return;
  await env.DB.prepare(`DELETE FROM sessions WHERE expires_at < ?`)
    .bind(now() - 7 * 24 * 3600 * 1000).run().catch(() => {});
}

/* ================================================================== guests == */

export async function createGuest(env, { id, displayName, tokenHash }) {
  const t = now();
  await env.DB.prepare(
    `INSERT INTO guests (id, display_name, token_hash, created_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?)`
  ).bind(id, displayName, tokenHash, t, t).run();
  return { id, display_name: displayName };
}

export async function findGuestByHash(env, tokenHash) {
  if (!hasDb(env) || !tokenHash) return null;
  return env.DB.prepare(`SELECT * FROM guests WHERE token_hash = ?`).bind(tokenHash).first();
}

export async function touchGuest(env, id) {
  if (!hasDb(env)) return;
  env.DB.prepare(`UPDATE guests SET last_seen_at = ? WHERE id = ?`)
    .bind(now(), id).run().catch(() => {});
}

/**
 * Upgrade a guest to a full account, IN PLACE.
 *
 * This is the single most important onboarding affordance in the design: a
 * player can play immediately and sign up later without losing a single match,
 * a KO or a point of XP. Everything filed under the guest's key is rewritten to
 * the account's key.
 */
export async function claimGuest(env, guestId, accountId) {
  if (!hasDb(env)) return 0;
  const t = now();
  const res = await env.DB.batch([
    env.DB.prepare(
      `UPDATE match_results SET account_id = ?, player_key = ?
        WHERE guest_id = ? AND account_id IS NULL`
    ).bind(accountId, accountId, guestId),
    env.DB.prepare(
      `UPDATE events SET account_id = ? WHERE guest_id = ? AND account_id IS NULL`
    ).bind(accountId, guestId),
    env.DB.prepare(
      `UPDATE xp_ledger SET account_id = ? WHERE account_id = ?`
    ).bind(accountId, guestId),
    env.DB.prepare(`UPDATE guests SET claimed_by = ? WHERE id = ?`).bind(accountId, guestId)
  ]);
  const changed = res && res[0] && res[0].meta ? res[0].meta.changes : 0;
  return changed;
}

/** How many matches a guest has played, so the UI can promise "keep your record". */
export async function guestMatchCount(env, guestId) {
  if (!hasDb(env) || !guestId) return 0;
  const row = await env.DB.prepare(
    `SELECT COUNT(*) n FROM match_results WHERE guest_id = ?`
  ).bind(guestId).first();
  return row ? row.n : 0;
}

/* =============================================================== progress == */

/** Make sure the per-account rows exist. Safe to call on every request. */
export async function ensureAccountRows(env, accountId) {
  if (!hasDb(env) || !accountId) return;
  const t = now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT OR IGNORE INTO progress (account_id, level, xp_total, xp_into_level, updated_at)
       VALUES (?, 1, 0, 0, ?)`
    ).bind(accountId, t),
    env.DB.prepare(
      `INSERT OR IGNORE INTO player_stats (account_id, updated_at) VALUES (?, ?)`
    ).bind(accountId, t),
    env.DB.prepare(
      `INSERT OR IGNORE INTO account_loadout (account_id, equipped_json, updated_at)
       VALUES (?, '{}', ?)`
    ).bind(accountId, t)
  ]).catch(() => {});
}

/** Grant every 'default' cosmetic to a new account. */
export async function grantDefaultUnlocks(env, accountId) {
  if (!hasDb(env) || !accountId) return;
  await env.DB.prepare(
    `INSERT OR IGNORE INTO account_unlocks (account_id, unlock_id, source, unlocked_at)
     SELECT ?, id, 'default', ? FROM unlocks WHERE source = 'default'`
  ).bind(accountId, now()).run().catch(() => {});
}
