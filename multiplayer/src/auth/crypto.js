/* =============================================================================
   auth/crypto.js — every cryptographic primitive the auth system uses.

   Kept in one file so the security-relevant code can be read and audited in a
   single sitting, and so there is exactly one implementation of each thing.

   Nothing here is invented: PBKDF2-HMAC-SHA256 for passwords (the OWASP
   recommendation, and the only KDF WebCrypto provides natively in Workers),
   SHA-256 for token storage, and constant-time comparison for secrets.
   ============================================================================= */

const encoder = new TextEncoder();

/* --------------------------------------------------------------- encodings -- */

export function toBase64Url(bytes) {
  let bin = '';
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromBase64Url(str) {
  const s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 ? '='.repeat(4 - (s.length % 4)) : '';
  const bin = atob(s + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh, unguessable secret. 32 bytes = 256 bits. */
export function randomToken(bytes = 32) {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toBase64Url(buf);
}

export async function sha256Hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(String(input)));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Constant-time string comparison. Used for anything an attacker could probe
 * byte-by-byte (session lookups, OAuth state, provider secrets).
 */
export function constantTimeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  if (x.length !== y.length) return false;
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x.charCodeAt(i) ^ y.charCodeAt(i);
  return diff === 0;
}

/* --------------------------------------------------------------- passwords -- */

/**
 * Iteration count for PBKDF2-HMAC-SHA256.
 *
 * 600,000 is the OWASP 2023 recommendation. It costs roughly 200-400 ms of CPU,
 * which is fine on the Workers PAID plan (30 s default CPU budget) but will be
 * killed by the FREE plan's 10 ms per-request limit. That is why password auth
 * sits behind the AUTH_PASSWORD flag — set it to "0" and the game runs OAuth
 * only, with no hashing at all.
 */
export const PBKDF2_ITERATIONS = 600000;
export const PBKDF2_ALGO = 'pbkdf2-sha256:' + PBKDF2_ITERATIONS;

async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey(
    'raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt: saltBytes, iterations, hash: 'SHA-256' },
    key, 256
  );
  return new Uint8Array(bits);
}

/** Returns { hash, salt, algo } ready to store on an identity row. */
export async function hashPassword(password, iterations = PBKDF2_ITERATIONS) {
  const saltBytes = new Uint8Array(16);
  crypto.getRandomValues(saltBytes);
  const hash = await pbkdf2(password, saltBytes, iterations);
  return {
    hash: toBase64Url(hash),
    salt: toBase64Url(saltBytes),
    algo: 'pbkdf2-sha256:' + iterations
  };
}

/**
 * Verify a password against a stored hash. Always runs the KDF, even when the
 * stored algo is unrecognised, so a corrupt row cannot be distinguished from a
 * wrong password by timing.
 */
export async function verifyPassword(password, storedHash, storedSalt, storedAlgo) {
  let iterations = PBKDF2_ITERATIONS;
  const m = /^pbkdf2-sha256:(\d+)$/.exec(String(storedAlgo || ''));
  if (m) iterations = Math.min(Math.max(parseInt(m[1], 10) || PBKDF2_ITERATIONS, 1000), 2000000);

  let saltBytes;
  try { saltBytes = fromBase64Url(storedSalt); }
  catch (e) { saltBytes = new Uint8Array(16); }

  const computed = toBase64Url(await pbkdf2(password, saltBytes, iterations));
  return constantTimeEqual(computed, storedHash);
}

/* ------------------------------------------------------------------ input -- */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase().slice(0, 254);
}

export function isValidEmail(email) {
  return EMAIL_RE.test(normalizeEmail(email));
}

/**
 * Password policy. Length is the only thing that really matters, so the rule is
 * "at least 8 characters, not a known-terrible password" rather than a pile of
 * character-class requirements that push people towards `Password1!`.
 */
const WEAK = new Set([
  'password', 'password1', '12345678', '123456789', 'qwertyui', 'qwerty123',
  'letmein1', 'iloveyou', 'admin123', 'viberbrawl', 'football', 'baseball'
]);

export function validatePassword(password) {
  const p = String(password || '');
  if (p.length < 8) return { ok: false, message: 'Password must be at least 8 characters.' };
  if (p.length > 200) return { ok: false, message: 'Password must be under 200 characters.' };
  if (WEAK.has(p.toLowerCase())) return { ok: false, message: 'That password is too common. Pick another.' };
  return { ok: true };
}

/* ------------------------------------------------------------ display names -- */

const NAME_ALLOWED = /[^A-Za-z0-9 _\-]/g;
const NAME_RESERVED = new Set([
  'admin', 'administrator', 'moderator', 'mod', 'staff', 'system', 'server',
  'official', 'viberbrawl', 'root', 'null', 'undefined', 'guest', 'player'
]);

/**
 * Display names go into the game UI and into public profiles, so they are an
 * XSS surface and an impersonation surface. Strip everything that is not a
 * plain character, collapse whitespace, and refuse reserved words.
 */
export function sanitizeDisplayName(raw) {
  let n = String(raw || '')
    .replace(NAME_ALLOWED, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 14);
  if (n.length < 3) return null;
  if (NAME_RESERVED.has(n.toLowerCase())) return null;
  if (/^[_-]+$/.test(n)) return null;
  return n;
}

/** Escape for any place a name is interpolated into HTML. */
export function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
}
