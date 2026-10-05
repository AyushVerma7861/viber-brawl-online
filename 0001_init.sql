-- =============================================================================
-- Viber Brawl — accounts, progression, analytics and profiles
-- Migration 0001: initial schema
--
-- Conventions used throughout:
--   * every id is a TEXT uuid (except autoincrement ledger/event rows)
--   * every timestamp is INTEGER unix milliseconds, matching the rest of the
--     project (the Durable Object already uses Date.now())
--   * anything a client could lie about is deliberately absent; every stat here
--     is written by the server from a match it refereed itself
-- =============================================================================

PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- accounts — one row per person. An account may have several ways to sign in.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS accounts (
  id             TEXT PRIMARY KEY,
  email          TEXT,
  email_verified INTEGER NOT NULL DEFAULT 0,
  status         TEXT    NOT NULL DEFAULT 'active',   -- active | suspended | deleted
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL,
  deleted_at     INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_email
  ON accounts(lower(email)) WHERE email IS NOT NULL;

-- -----------------------------------------------------------------------------
-- identities — one account, many sign-in methods. This is the model every
-- modern game uses (sign in with Google today, link Discord tomorrow, same
-- account, same progress). Passwords live here too, as provider 'password',
-- so there is exactly one place that knows how to verify a credential.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS identities (
  id            TEXT PRIMARY KEY,
  account_id    TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider      TEXT    NOT NULL,          -- google | discord | password
  provider_uid  TEXT    NOT NULL,          -- the provider's own user id
  email         TEXT,
  password_hash TEXT,                      -- provider 'password' only
  password_salt TEXT,
  password_algo TEXT,                      -- e.g. pbkdf2-sha256:600000
  created_at    INTEGER NOT NULL,
  last_used_at  INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_identities_provider
  ON identities(provider, provider_uid);
CREATE INDEX IF NOT EXISTS idx_identities_account
  ON identities(account_id);

-- -----------------------------------------------------------------------------
-- profiles — the public-facing half of an account.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS profiles (
  account_id         TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  display_name       TEXT    NOT NULL,
  display_name_lower TEXT    NOT NULL,
  avatar_viber       TEXT    NOT NULL DEFAULT 'miner',
  country            TEXT,
  is_public          INTEGER NOT NULL DEFAULT 1,
  created_at         INTEGER NOT NULL,
  updated_at         INTEGER NOT NULL,
  name_changed_at    INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_name
  ON profiles(display_name_lower);

-- -----------------------------------------------------------------------------
-- sessions — server-side sessions so a token can actually be revoked.
-- Only a hash of the secret is stored; a database leak does not hand out logins.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS sessions (
  id           TEXT PRIMARY KEY,
  account_id   TEXT    NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  ip_hash      TEXT,
  ua_hash      TEXT,
  revoked_at   INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_token ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_account ON sessions(account_id, expires_at);

-- -----------------------------------------------------------------------------
-- guests — a player who has not signed in yet. They can play immediately and
-- upgrade in place later without losing anything. This is the single biggest
-- onboarding win in the whole design.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS guests (
  id           TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  token_hash   TEXT NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  claimed_by   TEXT REFERENCES accounts(id) ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_guests_token ON guests(token_hash);

-- -----------------------------------------------------------------------------
-- progress — level and experience. Level is cosmetic prestige ONLY; it never
-- touches a gameplay constant.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS progress (
  account_id    TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  level         INTEGER NOT NULL DEFAULT 1,
  xp_total      INTEGER NOT NULL DEFAULT 0,
  xp_into_level INTEGER NOT NULL DEFAULT 0,
  updated_at    INTEGER NOT NULL
);

-- -----------------------------------------------------------------------------
-- player_stats — denormalised career totals for fast profile reads.
-- Fully rebuildable from match_results + xp_ledger; those two are the truth.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS player_stats (
  account_id     TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  matches        INTEGER NOT NULL DEFAULT 0,
  wins           INTEGER NOT NULL DEFAULT 0,
  kos            INTEGER NOT NULL DEFAULT 0,
  falls          INTEGER NOT NULL DEFAULT 0,
  dmg_dealt      INTEGER NOT NULL DEFAULT 0,
  dmg_taken      INTEGER NOT NULL DEFAULT 0,
  best_placement INTEGER,
  playtime_s     INTEGER NOT NULL DEFAULT 0,
  current_streak INTEGER NOT NULL DEFAULT 0,
  best_streak    INTEGER NOT NULL DEFAULT 0,
  updated_at     INTEGER NOT NULL
);

-- -----------------------------------------------------------------------------
-- viber_mastery — a separate track per character. Four Vibers means four
-- parallel goals from day one, which is why Apex, Overwatch and League all do it.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS viber_mastery (
  account_id TEXT    NOT NULL,
  char_id    TEXT    NOT NULL,
  xp         INTEGER NOT NULL DEFAULT 0,
  level      INTEGER NOT NULL DEFAULT 1,
  matches    INTEGER NOT NULL DEFAULT 0,
  wins       INTEGER NOT NULL DEFAULT 0,
  kos        INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, char_id)
);

-- -----------------------------------------------------------------------------
-- match_summary — one row per completed match, written by the Durable Object.
-- match_id is UNIQUE, and every insert is OR IGNORE, so a Durable Object
-- restart or a retry can never double-count a match.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_summary (
  match_id          TEXT PRIMARY KEY,
  room_code         TEXT    NOT NULL,
  map               TEXT,
  ruleset_hash      TEXT,                 -- exact constants used, so old results stay interpretable
  player_count      INTEGER NOT NULL,
  duration_s        INTEGER NOT NULL,
  started_at        INTEGER NOT NULL,
  ended_at          INTEGER NOT NULL,
  winner_player_key TEXT,
  end_reason        TEXT,
  created_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_match_summary_ended ON match_summary(ended_at);

-- -----------------------------------------------------------------------------
-- match_results — one row per player per match. This is the single source of
-- truth for progression and analytics, and it is written by the server, never
-- reported by the client.
--
-- player_key is account_id when signed in, otherwise the guest id, so a guest's
-- results survive their later upgrade to a full account.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS match_results (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id     TEXT    NOT NULL REFERENCES match_summary(match_id) ON DELETE CASCADE,
  player_key   TEXT    NOT NULL,
  account_id   TEXT,
  guest_id     TEXT,
  display_name TEXT    NOT NULL,
  char_id      TEXT    NOT NULL,
  placement    INTEGER NOT NULL,
  lives_left   INTEGER NOT NULL,
  kos          INTEGER NOT NULL,
  falls        INTEGER NOT NULL,
  dmg_dealt    REAL    NOT NULL,
  dmg_taken    REAL    NOT NULL,
  winner       INTEGER NOT NULL DEFAULT 0,
  disconnected INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_match_results_once
  ON match_results(match_id, player_key);
CREATE INDEX IF NOT EXISTS idx_match_results_player
  ON match_results(player_key, created_at);
CREATE INDEX IF NOT EXISTS idx_match_results_char
  ON match_results(char_id, created_at);

-- -----------------------------------------------------------------------------
-- xp_ledger — append-only. Every XP grant is a row, so a number that looks
-- wrong can always be replayed and explained. The unique index is what makes
-- awards idempotent: the same reason can only ever pay out once per match.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS xp_ledger (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id TEXT    NOT NULL,
  match_id   TEXT,
  amount     INTEGER NOT NULL,
  reason     TEXT    NOT NULL,
  meta_json  TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_xp_ledger_account
  ON xp_ledger(account_id, created_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_xp_ledger_once
  ON xp_ledger(account_id, reason, match_id)
  WHERE match_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- achievements — static catalogue. Tiers and rarity are what make them
-- chaseable rather than a flat checklist.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS achievements (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL,
  tier        TEXT    NOT NULL DEFAULT 'bronze',  -- bronze | silver | gold | platinum
  secret      INTEGER NOT NULL DEFAULT 0,
  points      INTEGER NOT NULL DEFAULT 0,
  xp_reward   INTEGER NOT NULL DEFAULT 0,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS account_achievements (
  account_id     TEXT    NOT NULL,
  achievement_id TEXT    NOT NULL REFERENCES achievements(id) ON DELETE CASCADE,
  progress       INTEGER NOT NULL DEFAULT 0,
  unlocked_at    INTEGER,
  PRIMARY KEY (account_id, achievement_id)
);
CREATE INDEX IF NOT EXISTS idx_account_achievements_unlocked
  ON account_achievements(achievement_id, unlocked_at);

-- -----------------------------------------------------------------------------
-- unlocks — COSMETIC ONLY, by construction. `payload_json` describes colours
-- and effects; there is deliberately no column that could hold a gameplay
-- value, and the progression module has no reference to CHAR_STATS at all.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS unlocks (
  id             TEXT PRIMARY KEY,
  kind           TEXT    NOT NULL,   -- palette | skin | ko_effect | trail | banner | title
  name           TEXT    NOT NULL,
  char_id        TEXT,               -- NULL means it applies to any Viber
  source         TEXT    NOT NULL,   -- level | achievement | default
  level_req      INTEGER,
  achievement_id TEXT,
  payload_json   TEXT,
  sort_order     INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS account_unlocks (
  account_id  TEXT    NOT NULL,
  unlock_id   TEXT    NOT NULL REFERENCES unlocks(id) ON DELETE CASCADE,
  source      TEXT    NOT NULL,
  unlocked_at INTEGER NOT NULL,
  PRIMARY KEY (account_id, unlock_id)
);

CREATE TABLE IF NOT EXISTS account_loadout (
  account_id    TEXT PRIMARY KEY,
  equipped_json TEXT    NOT NULL DEFAULT '{}',
  updated_at    INTEGER NOT NULL
);

-- -----------------------------------------------------------------------------
-- challenges — daily and weekly goals, keyed by period so they reset cleanly.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS challenges (
  id          TEXT PRIMARY KEY,
  name        TEXT    NOT NULL,
  description TEXT    NOT NULL,
  period      TEXT    NOT NULL,   -- daily | weekly
  metric      TEXT    NOT NULL,   -- matches | wins | kos | damage | playtime | char_wins
  char_id     TEXT,
  target      INTEGER NOT NULL,
  xp_reward   INTEGER NOT NULL,
  sort_order  INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS challenge_progress (
  account_id   TEXT    NOT NULL,
  challenge_id TEXT    NOT NULL REFERENCES challenges(id) ON DELETE CASCADE,
  period_key   TEXT    NOT NULL,   -- e.g. 2026-10-05 or 2026-W41
  progress     INTEGER NOT NULL DEFAULT 0,
  claimed_at   INTEGER,
  PRIMARY KEY (account_id, challenge_id, period_key)
);

CREATE TABLE IF NOT EXISTS daily_state (
  account_id        TEXT PRIMARY KEY,
  last_first_win_at INTEGER,
  last_daily_key    TEXT,
  updated_at        INTEGER NOT NULL
);

-- -----------------------------------------------------------------------------
-- events — analytics. Two clearly separated sources:
--   source='server'  authoritative, emitted by the Durable Object
--   source='client'  UX and funnel only, never used for stats or progression
-- schema_version lets the shape change without breaking history.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT    NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  source         TEXT    NOT NULL,
  account_id     TEXT,
  guest_id       TEXT,
  session_id     TEXT,
  match_id       TEXT,
  room_code      TEXT,
  props_json     TEXT,
  ts             INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_name_ts  ON events(name, ts);
CREATE INDEX IF NOT EXISTS idx_events_account  ON events(account_id, ts);
CREATE INDEX IF NOT EXISTS idx_events_match    ON events(match_id);

-- -----------------------------------------------------------------------------
-- rate_limits — sliding-window counters for auth endpoints. A D1 table is
-- plenty at this scale and avoids another moving part.
-- -----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limits (
  key          TEXT    NOT NULL,
  window_start INTEGER NOT NULL,
  count        INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key, window_start)
);
