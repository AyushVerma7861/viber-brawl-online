/* =============================================================================
   db/index.js — the only place that talks to D1.

   Everything here is written by the SERVER from a match the server refereed.
   No function in this file accepts a client-supplied statistic, and none of the
   progression tables can be reached from the browser.

   All writes are idempotent:
     * match_summary  — PRIMARY KEY (match_id) + INSERT OR IGNORE
     * match_results  — UNIQUE (match_id, player_key) + INSERT OR IGNORE
     * xp_ledger      — UNIQUE (account_id, reason, match_id) + INSERT OR IGNORE
   so a Durable Object restart, a retried alarm, or a double-fired match end can
   never award anything twice.
   ============================================================================= */

/** True when the D1 binding is present, so callers can degrade instead of throwing. */
export function hasDb(env) {
  return !!(env && env.DB && typeof env.DB.batch === 'function');
}

/* ------------------------------------------------------------------ events -- */

/**
 * Record analytics events.
 * `source` is 'server' for anything authoritative, 'client' for UX/funnel only.
 * Client events are never read by progression code.
 */
export async function recordEvents(env, events) {
  if (!hasDb(env) || !events || !events.length) return 0;
  const now = Date.now();
  const stmts = events.map(e => env.DB.prepare(
    `INSERT INTO events
       (name, schema_version, source, account_id, guest_id, session_id, match_id, room_code, props_json, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    String(e.name).slice(0, 64),
    e.schemaVersion || 1,
    e.source === 'client' ? 'client' : 'server',
    e.accountId || null,
    e.guestId || null,
    e.sessionId || null,
    e.matchId || null,
    e.roomCode || null,
    e.props ? JSON.stringify(e.props).slice(0, 2000) : null,
    e.ts || now
  ));
  try {
    await env.DB.batch(stmts);
    return stmts.length;
  } catch (err) {
    console.error('[db] recordEvents failed', err && err.message);
    return 0;
  }
}

/* ------------------------------------------------------------ match report -- */

/**
 * Persist one finished match.
 *
 * @param env      worker env with the DB binding
 * @param report   {
 *                   matchId, roomCode, map, rulesetHash,
 *                   startedAt, endedAt, endReason, winnerPlayerKey,
 *                   players: [{ playerKey, accountId, guestId, displayName,
 *                               charId, placement, lives, kos, falls,
 *                               dmgDealt, dmgTaken, winner, disconnected }]
 *                 }
 * @returns { recorded: boolean, results: number }  `recorded` is false when this
 *          match id was already stored, so callers can skip awarding XP twice.
 */
export async function recordMatch(env, report) {
  if (!hasDb(env)) return { recorded: false, results: 0, reason: 'no-db' };
  if (!report || !report.matchId || !Array.isArray(report.players) || !report.players.length) {
    return { recorded: false, results: 0, reason: 'bad-report' };
  }

  const now = Date.now();
  const endedAt = report.endedAt || now;
  const startedAt = report.startedAt || endedAt;
  const durationS = Math.max(0, Math.round((endedAt - startedAt) / 1000));

  const stmts = [];

  stmts.push(env.DB.prepare(
    `INSERT OR IGNORE INTO match_summary
       (match_id, room_code, map, ruleset_hash, player_count, duration_s,
        started_at, ended_at, winner_player_key, end_reason, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(
    report.matchId,
    String(report.roomCode || '').slice(0, 16),
    report.map ? String(report.map).slice(0, 32) : null,
    report.rulesetHash || null,
    report.players.length,
    durationS,
    startedAt,
    endedAt,
    report.winnerPlayerKey || null,
    report.endReason ? String(report.endReason).slice(0, 32) : 'normal',
    now
  ));

  for (const p of report.players) {
    if (!p || !p.playerKey) continue;
    stmts.push(env.DB.prepare(
      `INSERT OR IGNORE INTO match_results
         (match_id, player_key, account_id, guest_id, display_name, char_id,
          placement, lives_left, kos, falls, dmg_dealt, dmg_taken,
          winner, disconnected, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      report.matchId,
      p.playerKey,
      p.accountId || null,
      p.guestId || null,
      String(p.displayName || 'VIBER').slice(0, 32),
      String(p.charId || 'miner').slice(0, 24),
      Number.isFinite(p.placement) ? p.placement : 0,
      Number.isFinite(p.lives) ? p.lives : 0,
      Number.isFinite(p.kos) ? p.kos : 0,
      Number.isFinite(p.falls) ? p.falls : 0,
      Number.isFinite(p.dmgDealt) ? Math.round(p.dmgDealt) : 0,
      Number.isFinite(p.dmgTaken) ? Math.round(p.dmgTaken) : 0,
      p.winner ? 1 : 0,
      p.disconnected ? 1 : 0,
      now
    ));
  }

  try {
    const res = await env.DB.batch(stmts);
    /* res[0] is the summary insert. meta.changes === 0 means it was already
       there, i.e. this match has been reported before. */
    const summary = res && res[0];
    const changed = summary && summary.meta ? summary.meta.changes : 0;
    return { recorded: changed > 0, results: report.players.length };
  } catch (err) {
    console.error('[db] recordMatch failed', err && err.message);
    return { recorded: false, results: 0, reason: 'error' };
  }
}

/* ------------------------------------------------------------------ lookups -- */

/** Match history for one player, newest first. Used by the profile screen. */
export async function recentMatchesFor(env, playerKey, limit = 20) {
  if (!hasDb(env)) return [];
  const n = Math.min(Math.max(1, limit | 0), 100);
  const { results } = await env.DB.prepare(
    `SELECT r.match_id, r.char_id, r.placement, r.lives_left, r.kos, r.falls,
            r.dmg_dealt, r.dmg_taken, r.winner, r.disconnected, r.created_at,
            s.room_code, s.duration_s, s.player_count, s.map
       FROM match_results r
       JOIN match_summary s ON s.match_id = r.match_id
      WHERE r.player_key = ?
      ORDER BY r.created_at DESC
      LIMIT ?`
  ).bind(playerKey, n).all();
  return results || [];
}

/** Career totals, recomputed from the source of truth rather than trusted. */
export async function careerTotals(env, playerKey) {
  if (!hasDb(env)) return null;
  return env.DB.prepare(
    `SELECT COUNT(*)                                   AS matches,
            COALESCE(SUM(winner), 0)                   AS wins,
            COALESCE(SUM(kos), 0)                      AS kos,
            COALESCE(SUM(falls), 0)                    AS falls,
            COALESCE(SUM(dmg_dealt), 0)                AS dmg_dealt,
            COALESCE(SUM(dmg_taken), 0)                AS dmg_taken,
            COALESCE(MIN(placement), NULL)             AS best_placement
       FROM match_results
      WHERE player_key = ?`
  ).bind(playerKey).first();
}

/** Per-character breakdown, for the stats tab and for balance analytics. */
export async function perCharacterTotals(env, playerKey) {
  if (!hasDb(env)) return [];
  const { results } = await env.DB.prepare(
    `SELECT char_id,
            COUNT(*)                 AS matches,
            COALESCE(SUM(winner), 0) AS wins,
            COALESCE(SUM(kos), 0)    AS kos,
            COALESCE(SUM(dmg_dealt),0) AS dmg_dealt
       FROM match_results
      WHERE player_key = ?
      GROUP BY char_id
      ORDER BY matches DESC`
  ).bind(playerKey).all();
  return results || [];
}

/* -------------------------------------------------------------- rate limits -- */

/**
 * Sliding-window rate limit. Returns { allowed, count }.
 * A D1 table is plenty at this scale and avoids another moving part.
 */
export async function bumpRateLimit(env, key, max, windowMs) {
  if (!hasDb(env)) return { allowed: true, count: 0 };
  const now = Date.now();
  const windowStart = Math.floor(now / windowMs) * windowMs;
  try {
    await env.DB.prepare(
      `INSERT INTO rate_limits (key, window_start, count) VALUES (?, ?, 1)
         ON CONFLICT(key, window_start) DO UPDATE SET count = count + 1`
    ).bind(key, windowStart).run();

    const row = await env.DB.prepare(
      `SELECT count FROM rate_limits WHERE key = ? AND window_start = ?`
    ).bind(key, windowStart).first();

    const count = row ? row.count : 1;
    /* opportunistic cleanup so the table cannot grow without bound */
    if (Math.random() < 0.02) {
      await env.DB.prepare(`DELETE FROM rate_limits WHERE window_start < ?`)
        .bind(now - windowMs * 4).run().catch(() => {});
    }
    return { allowed: count <= max, count };
  } catch (err) {
    console.error('[db] bumpRateLimit failed', err && err.message);
    return { allowed: true, count: 0 };   /* fail open on infrastructure errors */
  }
}

/* -------------------------------------------------------------------- stats -- */

/** Row counts, used by the test suite and the admin dashboard. */
export async function tableCounts(env) {
  if (!hasDb(env)) return null;
  return env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM match_summary)  AS matches,
            (SELECT COUNT(*) FROM match_results)  AS results,
            (SELECT COUNT(*) FROM accounts)       AS accounts,
            (SELECT COUNT(*) FROM events)         AS events`
  ).first();
}
